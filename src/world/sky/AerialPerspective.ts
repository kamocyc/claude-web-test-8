import { Material, ShaderChunk, Vector2, Vector3, type IUniform, type Texture } from 'three';
import { SKY_MAPPING_GLSL } from './AtmosphereGlsl';

/**
 * Aerial perspective.
 *
 * three's fog mixes towards one flat colour, which is why the old build had a
 * hard line where the hills stopped and the sky started, and why distant land
 * never sat back. This replaces the fog chunks with the real thing: every
 * surface is blended towards the radiance of the sky *in its own direction*,
 * read from the same scattering table the dome is drawn from, with an
 * exponential height falloff so the haze pools in the valleys.
 *
 * The result is that the horizon dissolves exactly, distant ridges go blue
 * away from the sun and bright warm towards it, and rain or fog is a change of
 * two numbers rather than a different shader.
 *
 * Getting the table into every material without owning the material code is
 * done by intercepting `Material.prototype.onBeforeCompile`: materials that
 * install their own hook still get ours first, and the uniform objects are
 * shared by reference so one write per frame reaches everything.
 */

export const aerialUniforms = {
  uAerialSkyLut: { value: null as Texture | null },
  uAerialSkyTexel: { value: new Vector2(1, 1) },
  uAerialSunDir: { value: new Vector3(0, 1, 0) },
  uAerialSunTint: { value: new Vector3(1, 1, 1) },
  uAerialTint: { value: new Vector3(1, 1, 1) },
  uAerialCameraY: { value: 0 },
  uAerialHeightScale: { value: 900 },
  uAerialStrength: { value: 1 },
  uAerialGround: { value: 0 },
} satisfies Record<string, IUniform>;

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogView;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogView = mvPosition.xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogView;

  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif

  uniform sampler2D uAerialSkyLut;
  uniform vec2 uAerialSkyTexel;
  uniform vec3 uAerialSunDir;
  uniform vec3 uAerialSunTint;
  uniform vec3 uAerialTint;
  uniform float uAerialCameraY;
  uniform float uAerialHeightScale;
  uniform float uAerialStrength;
  uniform float uAerialGround;

  ${SKY_MAPPING_GLSL}
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  {
    // View space back to world space: the view rotation is orthonormal, so its
    // transpose is its inverse and three rows of dot products will do.
    vec3 fogWorld = vec3(
      dot(viewMatrix[0].xyz, vFogView),
      dot(viewMatrix[1].xyz, vFogView),
      dot(viewMatrix[2].xyz, vFogView));
    float fogDist = max(length(fogWorld), 1e-3);
    vec3 fogDir = fogWorld / fogDist;

    // Optical depth through an exponential atmosphere, integrated in closed
    // form along the ray so haze pools in the valleys and thins on the tops.
    float H = uAerialHeightScale;
    float rise = fogDir.y * fogDist;
    float base = exp(-max(uAerialCameraY, 0.0) / H);
    float depth;
    if (abs(rise) > 1.0) {
      depth = fogDist * H / rise * (base - exp(-max(uAerialCameraY + rise, 0.0) / H));
    } else {
      depth = fogDist * base;
    }
    depth = max(depth, 0.0);

    #ifdef FOG_EXP2
      float sigma = fogDensity;
    #else
      float sigma = 1.0 / max(fogFar - fogNear, 1.0);
    #endif

    // Blue is scattered out of the beam hardest, which is what turns a distant
    // ridge the colour of the sky behind it.
    vec3 extinction = vec3(0.78, 0.90, 1.06) * sigma * uAerialStrength;
    vec3 transmittance = exp(-extinction * depth);

    vec3 skyCol = skyRadiance(uAerialSkyLut, uAerialSkyTexel, fogDir, uAerialSunDir, uAerialSunTint);
    // Below the horizon there is land, not sky, so the haze there takes the
    // ground's own colour rather than glowing.
    skyCol = mix(skyCol, skyCol * uAerialGround, smoothstep(0.02, -0.14, fogDir.y));
    skyCol *= uAerialTint;

    gl_FragColor.rgb = gl_FragColor.rgb * transmittance + skyCol * (vec3(1.0) - transmittance);
  }
#endif
`;

let installed = false;

/** Swaps three's fog chunks for the scattering ones and wires the uniforms. */
export function installAerialPerspective(): void {
  if (installed) return;
  installed = true;

  ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  ShaderChunk.fog_vertex = FOG_VERTEX;
  ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  ShaderChunk.fog_fragment = FOG_FRAGMENT;

  const slot = Symbol('aerial.onBeforeCompile');
  interface Slotted {
    [key: symbol]: ((shader: { uniforms: Record<string, IUniform> }, renderer: unknown) => void) | undefined;
  }

  Object.defineProperty(Material.prototype, 'onBeforeCompile', {
    configurable: true,
    get(this: Slotted) {
      const own = this[slot];
      return function (
        this: Material,
        shader: { uniforms: Record<string, IUniform> },
        renderer: unknown,
      ): void {
        // Shared by reference, so the per-frame write in Sky reaches every
        // material that has ever been compiled.
        Object.assign(shader.uniforms, aerialUniforms);
        if (own) own.call(this, shader, renderer);
      };
    },
    set(this: Slotted, fn: ((shader: { uniforms: Record<string, IUniform> }, renderer: unknown) => void) | undefined) {
      this[slot] = fn;
    },
  });
}
