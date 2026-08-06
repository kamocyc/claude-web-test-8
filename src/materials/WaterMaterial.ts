import { Color, ShaderMaterial, UniformsLib, UniformsUtils, Vector2, Vector3, type Texture } from 'three';

/**
 * Water surface shader used for the sea, rivers and flooded paddies.
 *
 * Geometry carries a per-vertex `aDepth` attribute (metres of water below the
 * surface) and `aFlow` (how fast the body is moving, and which way along its
 * own channel), which between them drive wave height, shoaling, colour
 * absorption and shoreline foam without needing a depth pre-pass.
 *
 * Depth is also what decides whether there is any water here at all. A surface
 * with no depth under it is dry land, and dry land must not be painted over -
 * the mesh reaches well past the water's edge, so the shader discards there.
 */

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>

  attribute float aDepth;
  attribute float aFlow;

  uniform float uTime;
  uniform float uWaveScale;
  uniform float uChop;
  uniform vec2 uFlowDir;

  varying vec3 vWorldPos;
  varying float vDepth;
  varying float vFlow;
  varying vec3 vWaveNormal;
  varying float vCrest;
  varying float vShoal;

  /**
   * A sum of trochoidal waves.
   *
   * Waves feel the bottom as they come in: they slow, shorten and steepen
   * until they trip over themselves. The shoal term (1 in deep water, 0 at
   * the waterline) carries that, so one wave train is a long swell offshore
   * and a short steep one on the beach.
   */
  float waves(vec2 p, float shoal, out vec3 n) {
    vec2 dirs[4];
    dirs[0] = normalize(vec2(1.0, 0.35));
    dirs[1] = normalize(vec2(-0.6, 1.0));
    dirs[2] = normalize(vec2(0.85, -0.75));
    dirs[3] = normalize(vec2(-0.25, -1.0));
    float amps[4];
    amps[0] = 0.46; amps[1] = 0.27; amps[2] = 0.13; amps[3] = 0.07;
    float lens[4];
    lens[0] = 30.0; lens[1] = 17.0; lens[2] = 9.0; lens[3] = 4.4;
    float speeds[4];
    speeds[0] = 0.9; speeds[1] = 1.25; speeds[2] = 1.7; speeds[3] = 2.4;

    // Shoaling: shorter and taller as the bottom comes up.
    float shorten = mix(0.55, 1.0, shoal);
    float heighten = mix(1.35, 1.0, shoal);

    float h = 0.0;
    vec2 grad = vec2(0.0);
    for (int i = 0; i < 4; i++) {
      float k = 6.2831853 / (lens[i] * uWaveScale * shorten);
      float phase = dot(dirs[i], p) * k + uTime * speeds[i] * k * 2.2;
      float a = amps[i] * uWaveScale * uChop * heighten;
      // Sharpened crests, flattened troughs - the shape of a real wave.
      float s = sin(phase);
      float sharpen = mix(1.0, 1.0 + 0.45 * (1.0 - shoal), 1.0);
      h += a * (s + 0.22 * sharpen * s * abs(s));
      grad += dirs[i] * (a * k * cos(phase) * (1.0 + 0.44 * sharpen * abs(s)));
    }
    n = normalize(vec3(-grad.x, 1.0, -grad.y));
    return h;
  }

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);

    // Nothing moves right at the edge, and everything moves in deep water.
    float shallow = smoothstep(0.0, 3.5, aDepth);
    float shoal = smoothstep(0.6, 9.0, aDepth);
    vec3 n;
    float h = waves(worldPos.xz + uFlowDir * uTime * aFlow * 1.4, shoal, n) * shallow;
    worldPos.y += h;

    vWorldPos = worldPos.xyz;
    vDepth = aDepth;
    vFlow = aFlow;
    vWaveNormal = normalize(mix(vec3(0.0, 1.0, 0.0), n, shallow));
    vCrest = h;
    vShoal = shoal;

    vec4 mvPosition = viewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>

  uniform float uTime;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uZenithColor;
  uniform vec3 uShallowColor;
  uniform vec3 uDeepColor;
  uniform sampler2D uNormalMap;
  uniform float uNormalScale;
  uniform float uFoam;
  uniform float uRipple;
  uniform float uNight;
  uniform float uMirror;
  uniform vec2 uFlowDir;

  varying vec3 vWorldPos;
  varying float vDepth;
  varying float vFlow;
  varying vec3 vWaveNormal;
  varying float vCrest;
  varying float vShoal;

  vec3 sampleNormal(vec2 uv) {
    vec3 n = texture2D(uNormalMap, uv).xyz * 2.0 - 1.0;
    return normalize(vec3(n.x, n.z, n.y));
  }

  // Cheap analytic sky used for the reflection.
  vec3 skyColor(vec3 dir) {
    float up = clamp(dir.y, 0.0, 1.0);
    vec3 base = mix(uHorizonColor, uZenithColor, pow(up, 0.55));
    float sunDot = max(dot(dir, uSunDir), 0.0);
    base += uSunColor * pow(sunDot, 320.0) * 3.0;
    base += uSunColor * pow(sunDot, 9.0) * 0.22;
    return base;
  }

  // GGX lobe, so the sun's track across the water has the right shape: a tight
  // core where the surface is smooth and a long smear where it is chopped up.
  float ggx(float nDotH, float rough) {
    float a = rough * rough;
    float d = nDotH * nDotH * (a * a - 1.0) + 1.0;
    return (a * a) / (3.14159265 * d * d);
  }

  void main() {
    // Dry land. The mesh runs well past the water's edge so that the edge can
    // be found per pixel; everything beyond it is not water and is not drawn.
    float edge = smoothstep(0.0, 0.16, vDepth);
    if (edge <= 0.002) discard;

    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float dist = length(cameraPosition - vWorldPos);

    // Detail ripples: two scrolling normal maps at different scales, faded out
    // with distance so the horizon does not shimmer.
    vec2 flow = uFlowDir * vFlow;
    vec2 drift = vec2(uTime * 0.021, uTime * 0.014) + flow * uTime * 0.06;
    vec3 n1 = sampleNormal(vWorldPos.xz * 0.045 + drift);
    vec3 n2 = sampleNormal(vWorldPos.xz * 0.011 - drift * 0.6);
    vec3 n3 = sampleNormal(vWorldPos.xz * 0.19 + drift * 3.1);
    float detailFade = 1.0 - smoothstep(50.0, 700.0, dist);
    float microFade = 1.0 - smoothstep(6.0, 60.0, dist);
    vec3 ripple = normalize(n1 * 0.62 + n2 * 0.55 + n3 * 0.3 * microFade);
    vec3 detail = normalize(mix(vec3(0.0, 1.0, 0.0), ripple, detailFade * uRipple));

    vec3 normal = normalize(mix(vWaveNormal, detail, 0.62 * (1.0 - uMirror * 0.85)));

    // Schlick, with water's real index of refraction.
    float cosTheta = clamp(dot(normal, viewDir), 0.0, 1.0);
    // Capped short of a perfect mirror: some of the body colour always comes
    // back through, which is what gives water its own colour at a distance.
    float fres = min(0.02 + 0.98 * pow(1.0 - cosTheta, 5.0), 0.74);

    vec3 refl = reflect(-viewDir, normal);
    refl.y = abs(refl.y);
    // Water is never quite as bright as the sky it mirrors, and a rippled
    // surface never mirrors it cleanly - both are what stop a calm sea under
    // an overcast reading as a sheet of white paper.
    vec3 reflection = skyColor(normalize(refl)) * 0.66;

    // Absorption: red goes first, then green, so the body of the water runs
    // from a silty green in the shallows to a deep blue offshore.
    vec3 absorb = exp(-max(vDepth, 0.0) * vec3(0.46, 0.19, 0.11));
    vec3 body = mix(uDeepColor, uShallowColor, absorb.g);
    body *= mix(0.22, 1.0, 1.0 - uNight * 0.82);
    // Shallow water is see-through, which is what makes a beach read as a
    // beach rather than a painted edge.
    float clarity = 1.0 - exp(-max(vDepth, 0.0) * 1.5);

    // Sun glitter.
    vec3 halfVec = normalize(uSunDir + viewDir);
    float nDotH = max(dot(normal, halfVec), 0.0);
    float rough = mix(0.045, 0.20, clamp(1.0 - detailFade, 0.0, 1.0)) * (1.0 - uMirror * 0.75) + 0.006;
    float spec = ggx(nDotH, rough) * 0.05 + ggx(nDotH, 0.4) * 0.02;

    vec3 color = mix(body, reflection, fres);
    color += uSunColor * spec * (1.0 - uNight) * max(uSunDir.y, 0.0);

    // Foam. It belongs in a band just off the waterline where the wave has
    // already broken, not smeared over every shallow surface, and it is torn
    // up by the same water that made it.
    float foamNoise = texture2D(uNormalMap, vWorldPos.xz * 0.11 + drift * 2.4).r
                    * texture2D(uNormalMap, vWorldPos.xz * 0.031 - drift * 1.3).g * 2.2;
    float surge = 0.55 + 0.45 * sin(uTime * 0.55 + vWorldPos.x * 0.012 + vWorldPos.z * 0.009);
    float band = smoothstep(0.02, 0.35, vDepth) * (1.0 - smoothstep(0.35, 1.5 + surge * 0.9, vDepth));
    float breaker = smoothstep(0.28, 0.62, vCrest) * (1.0 - vShoal) * 0.8;
    float foam = clamp((band * (0.35 + foamNoise) + breaker * foamNoise) * uFoam, 0.0, 1.0);
    vec3 foamColor = vec3(0.86, 0.90, 0.93) * (0.32 + 0.68 * (1.0 - uNight));
    color = mix(color, foamColor, foam * 0.85);

    // Opacity: clear in the shallows so the bed shows, opaque offshore, and
    // gone entirely at the water's edge.
    float alpha = clamp(mix(0.30, 0.97, clarity) + fres * 0.35 + foam * 0.5, 0.0, 1.0) * edge;

    gl_FragColor = vec4(color, alpha);
    #include <fog_fragment>
  }
`;

export interface WaterOptions {
  normalMap: Texture;
  shallow?: number;
  deep?: number;
  waveScale?: number;
  chop?: number;
  foam?: number;
  ripple?: number;
  /** 1 = a still, mirror-like sheet (a flooded paddy); 0 = open water. */
  mirror?: number;
  /** Direction the body flows in, world XZ. */
  flowDir?: Vector2;
}

export function createWaterMaterial(options: WaterOptions): ShaderMaterial {
  const material = new ShaderMaterial({
    uniforms: UniformsUtils.merge([
      UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDir: { value: new Vector3(0, 1, 0) },
        uSunColor: { value: new Color(1, 0.95, 0.85) },
        uHorizonColor: { value: new Color(0.62, 0.735, 0.885) },
        uZenithColor: { value: new Color(0.075, 0.215, 0.585) },
        uShallowColor: { value: new Color(options.shallow ?? 0x2f7f7a) },
        uDeepColor: { value: new Color(options.deep ?? 0x06263f) },
        uNormalMap: { value: null },
        uNormalScale: { value: 0.55 },
        uWaveScale: { value: options.waveScale ?? 1 },
        uChop: { value: options.chop ?? 1 },
        uFoam: { value: options.foam ?? 1 },
        uRipple: { value: options.ripple ?? 1 },
        // A body with no chop in it is a still one: a flooded paddy or a canal
        // reflects like a mirror without anything else having to say so.
        uMirror: { value: options.mirror ?? ((options.chop ?? 1) < 0.2 ? 1 : 0) },
        uFlowDir: { value: options.flowDir ?? new Vector2(1, 0) },
        uNight: { value: 0 },
      },
    ]),
    vertexShader,
    fragmentShader,
    transparent: true,
    fog: true,
    depthWrite: false,
  });
  material.uniforms.uNormalMap.value = options.normalMap;
  return material;
}

/** Keeps every water material in the scene in sync with sky and time. */
export class WaterRegistry {
  private readonly materials: ShaderMaterial[] = [];

  register(material: ShaderMaterial): void {
    this.materials.push(material);
  }

  update(
    time: number,
    sunDir: Vector3,
    sunColor: Color,
    horizon: Color,
    zenith: Color,
    night: number,
  ): void {
    for (const m of this.materials) {
      m.uniforms.uTime.value = time;
      m.uniforms.uSunDir.value.copy(sunDir);
      m.uniforms.uSunColor.value.copy(sunColor);
      m.uniforms.uHorizonColor.value.copy(horizon);
      m.uniforms.uZenithColor.value.copy(zenith);
      m.uniforms.uNight.value = night;
    }
  }
}
