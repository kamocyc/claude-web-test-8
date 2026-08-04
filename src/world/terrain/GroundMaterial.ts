import { FrontSide, MeshStandardMaterial } from 'three';
import { groundLayerTextures } from './GroundTextures';

/**
 * The ground material.
 *
 * Both the coarse world tiles and the fine track-space corridor mesh are drawn
 * with this one material, which is what lets them meet invisibly. It works
 * entirely from world position and the surface normal, so neither mesh has to
 * agree on anything beyond geometry.
 *
 * What it does, in order:
 *
 *  - Decides how much of each ground layer belongs at this pixel from slope,
 *    altitude, curvature, distance to water and three scales of drifting
 *    variation noise. Layers are chosen per pixel and blended *by their own
 *    relief*, so turf grows around the stones of a gravel patch instead of
 *    dissolving into it.
 *  - Projects rock triplanar-ly on anything steep, so a cliff or the batter of
 *    a cutting shows bedding rather than a smeared plan view.
 *  - Breaks up tiling with a warped UV, a macro-scale modulation of the same
 *    sheet, and a large drifting colour field - the repeat is not readable at
 *    any distance.
 *  - Adds a second octave of the layer's own normal map close to the camera,
 *    faded out before it can alias.
 */

/** Metres per repeat of the detail sheet: 1 / 3.6 m. */
const DETAIL_SCALE = 0.28;

const commonChunk = /* glsl */ `
  precision highp sampler2DArray;
  uniform highp sampler2DArray uLayers;
  uniform highp sampler2DArray uSurface;
  uniform sampler2D uVariation;
  uniform float uDetailScale;
  uniform float uNearDetail;

  varying vec3 vWorldPos;
  varying vec3 vWorldNormal;
  varying float vShoreW;
  varying float vCavity;

  // Filled in by the ground pass and consumed by the roughness and normal
  // chunks further down the shader.
  vec3 gGroundNormal;
  float gGroundRough;
  float gGroundAO;

  const float L_GRASS  = 0.0;
  const float L_DRY    = 1.0;
  const float L_SOIL   = 2.0;
  const float L_GRAVEL = 3.0;
  const float L_SAND   = 4.0;
  const float L_ROCK   = 5.0;
`;

const groundChunk = /* glsl */ `
  vec3 wp = vWorldPos;
  vec3 gn = normalize(vWorldNormal);
  float slope = clamp(1.0 - gn.y, 0.0, 1.0);
  float viewDist = length(wp - cameraPosition);

  // --- drifting variation ------------------------------------------------
  // Three decades of scale. The widest decides what kind of country this is,
  // the middle breaks it into fields and thickets, the closest keeps any one
  // patch from having a straight edge.
  vec4 vMacro = texture2D(uVariation, wp.xz * 0.00029);
  vec4 vMeso  = texture2D(uVariation, wp.xz * 0.0037);
  vec4 vFine  = texture2D(uVariation, wp.xz * 0.031);

  // Warping the lookup with the variation field is most of what defeats the
  // repeat: straight seams in the sheet stop being straight.
  vec2 warp = (vMeso.zw - 0.5) * 1.9 + (vFine.zw - 0.5) * 0.28;
  vec2 uvD = (wp.xz + warp) * uDetailScale;
  vec2 dX = dFdx(uvD);
  vec2 dY = dFdy(uvD);
  vec2 uvM = (wp.xz + warp * 3.0) * uDetailScale * 0.153;
  vec2 mX = dX * 0.153;
  vec2 mY = dY * 0.153;

  // --- how much of each layer belongs here --------------------------------
  float alt = wp.y;
  // Concave ground collects water and soil; convex ground is scoured.
  float hollow = clamp(vCavity, 0.0, 1.0);
  float ridgeTop = clamp(-vCavity, 0.0, 1.0);

  float dryness = clamp(vMacro.r * 1.45 + vMeso.r * 0.75 - 1.32
                        + smoothstep(180.0, 700.0, alt) * 0.3
                        + ridgeTop * 0.28 - hollow * 0.45, 0.0, 1.0);
  float wear = clamp(vMeso.g * 1.5 + vFine.g * 0.6 - 1.28
                     + smoothstep(0.10, 0.36, slope) * 0.55, 0.0, 1.0);
  // Loose stone is the exception, not the rule: it wants ground steep enough
  // for nothing to hold on, or the hollow at the foot of ground like that.
  float stony = clamp(smoothstep(0.22, 0.52, slope) * 0.85
                      + hollow * smoothstep(0.12, 0.34, slope) * 1.1
                      + (vMacro.a - 0.80) * 0.9, 0.0, 1.0);
  float shore = clamp(vShoreW, 0.0, 1.0);

  float wGrass  = (1.0 - dryness * 0.75) * (1.0 - wear * 0.8) * (1.0 - stony * 0.8) * 1.12;
  float wDry    = dryness * (1.0 - wear * 0.5) * (1.0 - stony * 0.6);
  float wSoil   = wear * (0.55 + dryness * 0.45);
  // Sand belongs at the waterline. The same attribute marks the gravel cess
  // beside the running line, which is stone, not beach - so the two are split
  // by how far above the water they sit.
  float low = 1.0 - smoothstep(0.6, 7.0, alt);
  float wGravel = max(stony, shore * 1.5 * (1.0 - low));
  float wSand   = shore * 1.7 * low;
  wGrass = max(wGrass, 0.02);

  // Pick the two strongest layers. Everything else contributes nothing the eye
  // could find, and two samples is what keeps this affordable.
  float w[5];
  w[0] = wGrass; w[1] = wDry; w[2] = wSoil; w[3] = wGravel; w[4] = wSand;
  int i0 = 0;
  float w0 = w[0];
  for (int i = 1; i < 5; i++) { if (w[i] > w0) { w0 = w[i]; i0 = i; } }
  int i1 = 0;
  float w1 = -1.0;
  for (int i = 0; i < 5; i++) { if (i != i0 && w[i] > w1) { w1 = w[i]; i1 = i; } }

  float l0 = float(i0);
  float l1 = float(i1);
  vec4 a0 = textureGrad(uLayers, vec3(uvD, l0), dX, dY);
  vec4 a1 = textureGrad(uLayers, vec3(uvD, l1), dX, dY);

  // Height blend: the layer whose own surface stands proudest wins the pixel,
  // so the boundary follows blades and stones instead of a soft contour.
  float depth = 0.14;
  float top = max(a0.a + w0, a1.a + w1) - depth;
  float b0 = max(a0.a + w0 - top, 0.0);
  float b1 = max(a1.a + w1 - top, 0.0);
  float bt = max(b0 + b1, 1e-4);
  b0 /= bt; b1 /= bt;

  vec3 albedo = a0.rgb * b0 + a1.rgb * b1;
  vec4 s0 = textureGrad(uSurface, vec3(uvD, l0), dX, dY);
  vec4 s1 = textureGrad(uSurface, vec3(uvD, l1), dX, dY);
  vec4 surf = s0 * b0 + s1 * b1;

  // Macro pass over the same sheet, six times larger. Multiplying the two
  // together gives a period no eye can lock on to.
  vec4 m0 = textureGrad(uLayers, vec3(uvM, l0), mX, mY);
  // The relief channel, not the colour: it has the full range, so the macro
  // pass modulates without dragging the whole landscape darker.
  float macro = 0.60 + m0.a * 0.82;
  albedo *= mix(1.0, macro, 0.7);

  // Two scales of colour drift. The wide one says what kind of country this
  // is; the field-sized one is what stops the middle distance - where the
  // detail sheet has gone into its mipmaps - from flattening into a wash.
  vec3 drift = vec3(0.94 + vMacro.b * 0.20, 0.95 + vMacro.g * 0.14, 0.90 + vMacro.r * 0.22);
  vec3 field = mix(vec3(0.88, 0.94, 0.82), vec3(1.14, 1.05, 1.10), vMeso.r)
             * mix(vec3(1.0), vec3(1.10, 0.99, 0.84), vMeso.a);
  albedo *= mix(vec3(1.0), drift, 0.85) * mix(vec3(1.0), field, 0.8);
  albedo *= 0.84 + vMeso.b * 0.38;

  vec2 nrm = (surf.xy - 0.5) * 2.0;
  gGroundRough = surf.z;
  gGroundAO = surf.w;

  // --- rock, projected on three planes ------------------------------------
  float rockNoise = (vMeso.b - 0.5) * 0.30 + (vFine.b - 0.5) * 0.12;
  float rocky = smoothstep(0.42, 0.78, slope + rockNoise)
              * (0.5 + 0.5 * smoothstep(0.0, 260.0, alt));
  rocky = max(rocky, smoothstep(0.66, 0.86, slope));
  rocky *= 1.0 - shore * 0.7;

  float rs = uDetailScale * 0.62;
  vec2 uvRX = vec2(wp.z, -wp.y) * rs;
  vec2 uvRZ = vec2(wp.x, -wp.y) * rs;
  vec2 uvRY = wp.xz * rs;
  vec2 rxX = dFdx(uvRX), rxY = dFdy(uvRX);
  vec2 rzX = dFdx(uvRZ), rzY = dFdy(uvRZ);
  vec2 ryX = dFdx(uvRY), ryY = dFdy(uvRY);

  if (rocky > 0.004) {
    vec3 an = pow(abs(gn), vec3(5.0));
    an /= max(an.x + an.y + an.z, 1e-4);
    vec4 rA = textureGrad(uLayers, vec3(uvRX, L_ROCK), rxX, rxY) * an.x
            + textureGrad(uLayers, vec3(uvRY, L_ROCK), ryX, ryY) * an.y
            + textureGrad(uLayers, vec3(uvRZ, L_ROCK), rzX, rzY) * an.z;
    vec4 rS = textureGrad(uSurface, vec3(uvRX, L_ROCK), rxX, rxY) * an.x
            + textureGrad(uSurface, vec3(uvRY, L_ROCK), ryX, ryY) * an.y
            + textureGrad(uSurface, vec3(uvRZ, L_ROCK), rzX, rzY) * an.z;

    // Rock takes the pixel where its relief stands above the turf's.
    float rockTop = max(rA.a + rocky, mix(a0.a, a1.a, b1) + (1.0 - rocky)) - 0.24;
    float rb = max(rA.a + rocky - rockTop, 0.0);
    float gb = max(mix(a0.a, a1.a, b1) + (1.0 - rocky) - rockTop, 0.0);
    float rw = rb / max(rb + gb, 1e-4);

    albedo = mix(albedo, rA.rgb * (0.66 + m0.a * 0.72), rw);
    nrm = mix(nrm, (rS.xy - 0.5) * 2.0, rw);
    gGroundRough = mix(gGroundRough, rS.z, rw);
    gGroundAO = mix(gGroundAO, rS.w, rw);
  }

  // --- close-range relief -------------------------------------------------
  // A second, much finer octave of the same normal map underfoot only. It
  // gives the lineside real surface texture and is gone long before the
  // distance where it would sparkle.
  float near = uNearDetail * (1.0 - smoothstep(6.0, 34.0, viewDist));
  if (near > 0.01) {
    vec2 uvN = uvD * 4.7;
    vec4 sn = textureGrad(uSurface, vec3(uvN, l0), dX * 4.7, dY * 4.7);
    nrm += (sn.xy - 0.5) * 2.0 * near * 0.75;
    albedo *= mix(1.0, 0.72 + textureGrad(uLayers, vec3(uvN, l0), dX * 4.7, dY * 4.7).g * 0.7, near * 0.45);
  }

  // --- water's edge -------------------------------------------------------
  // Ground does not stop at the waterline: it darkens as it wets, silts up and
  // grows a green weed line just above it.
  float wet = clamp(1.0 - smoothstep(-0.4, 2.6, wp.y), 0.0, 1.0) * clamp(shore * 1.4, 0.0, 1.0);
  albedo *= mix(1.0, 0.46, wet * 0.9);
  gGroundRough = mix(gGroundRough, 0.24, wet * 0.85);

  // --- occlusion ----------------------------------------------------------
  // Landform curvature darkens creases and valley floors; the layer's own
  // occlusion darkens between its blades and stones.
  float landAO = 1.0 - clamp(hollow, 0.0, 1.0) * 0.38;
  gGroundAO = mix(1.0, gGroundAO, 0.5) * landAO;
  albedo *= gGroundAO;

  // --- rebuild the shading normal in world space ---------------------------
  vec3 tx = normalize(cross(gn, vec3(0.0, 0.0, 1.0)) + vec3(1e-5, 0.0, 0.0));
  vec3 tz = cross(tx, gn);
  float bump = mix(0.6, 1.05, 1.0 - smoothstep(20.0, 220.0, viewDist));
  gGroundNormal = normalize(gn + (tx * nrm.x + tz * nrm.y) * bump);

  diffuseColor.rgb *= albedo * 1.12;
`;

let material: MeshStandardMaterial | null = null;

/** The shared ground material. One instance: tiles and corridor must match. */
export function createGroundMaterial(): MeshStandardMaterial {
  if (material) return material;
  const { albedo, surface, variation } = groundLayerTextures();

  const mat = new MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.95,
    metalness: 0,
    side: FrontSide,
  });

  // The corridor mesh does not carry the curvature attribute; open ground is
  // the right default for it, since it covers the graded formation.
  (mat as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = {
    aCavity: [0],
    aShore: [0],
  };

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLayers = { value: albedo };
    shader.uniforms.uSurface = { value: surface };
    shader.uniforms.uVariation = { value: variation };
    shader.uniforms.uDetailScale = { value: DETAIL_SCALE };
    shader.uniforms.uNearDetail = { value: 1 };
    uniformsRef = shader.uniforms;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aShore;
         attribute float aCavity;
         varying vec3 vWorldPos;
         varying vec3 vWorldNormal;
         varying float vShoreW;
         varying float vCavity;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
         vWorldNormal = normalize(mat3(modelMatrix) * normal);
         vShoreW = aShore;
         vCavity = aCavity;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${commonChunk}`)
      .replace('#include <map_fragment>', groundChunk)
      .replace(
        '#include <roughnessmap_fragment>',
        'float roughnessFactor = gGroundRough;',
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
         normal = normalize(mat3(viewMatrix) * gGroundNormal);
         nonPerturbedNormal = normal;`,
      );
  };
  mat.customProgramCacheKey = () => 'terrain-layers';
  material = mat;
  return mat;
}

let uniformsRef: Record<string, { value: unknown }> | null = null;

/** Turns the close-range relief pass on or off with the quality profile. */
export function setGroundNearDetail(enabled: boolean): void {
  if (uniformsRef) uniformsRef.uNearDetail.value = enabled ? 1 : 0;
}
