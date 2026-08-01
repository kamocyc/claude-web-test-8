import { Color, ShaderMaterial, UniformsLib, UniformsUtils, Vector3, type Texture } from 'three';

/**
 * Water surface shader used for the sea, rivers and flooded paddies.
 *
 * Geometry carries a per-vertex `aDepth` attribute (metres of water below the
 * surface), which drives wave height, colour absorption and shoreline foam
 * without needing a depth pre-pass.
 */

const vertexShader = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>

  attribute float aDepth;
  attribute float aFlow;

  uniform float uTime;
  uniform float uWaveScale;
  uniform float uChop;

  varying vec3 vWorldPos;
  varying float vDepth;
  varying float vFlow;
  varying vec3 vWaveNormal;
  varying float vCrest;

  // Four travelling waves; returns height and accumulates the analytic normal.
  float waves(vec2 p, out vec3 n) {
    vec2 dirs[4];
    dirs[0] = normalize(vec2(1.0, 0.35));
    dirs[1] = normalize(vec2(-0.6, 1.0));
    dirs[2] = normalize(vec2(0.85, -0.75));
    dirs[3] = normalize(vec2(-0.25, -1.0));
    float amps[4];
    amps[0] = 0.42; amps[1] = 0.26; amps[2] = 0.14; amps[3] = 0.08;
    float lens[4];
    lens[0] = 26.0; lens[1] = 15.0; lens[2] = 8.5; lens[3] = 4.2;
    float speeds[4];
    speeds[0] = 0.9; speeds[1] = 1.25; speeds[2] = 1.7; speeds[3] = 2.4;

    float h = 0.0;
    vec2 grad = vec2(0.0);
    for (int i = 0; i < 4; i++) {
      float k = 6.2831853 / (lens[i] * uWaveScale);
      float phase = dot(dirs[i], p) * k + uTime * speeds[i] * k * 2.2;
      float a = amps[i] * uWaveScale * uChop;
      h += a * sin(phase);
      grad += dirs[i] * (a * k * cos(phase));
    }
    n = normalize(vec3(-grad.x, 1.0, -grad.y));
    return h;
  }

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);

    // Shallow water carries smaller waves.
    float shallow = smoothstep(0.0, 3.5, aDepth);
    vec3 n;
    float h = waves(worldPos.xz, n) * shallow;
    worldPos.y += h;

    vWorldPos = worldPos.xyz;
    vDepth = aDepth;
    vFlow = aFlow;
    vWaveNormal = normalize(mix(vec3(0.0, 1.0, 0.0), n, shallow));
    vCrest = h;

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

  varying vec3 vWorldPos;
  varying float vDepth;
  varying float vFlow;
  varying vec3 vWaveNormal;
  varying float vCrest;

  vec3 sampleNormal(vec2 uv, float scale) {
    vec3 n = texture2D(uNormalMap, uv * scale).xyz * 2.0 - 1.0;
    return normalize(vec3(n.x, n.z, n.y));
  }

  // Cheap analytic sky used for the reflection.
  vec3 skyColor(vec3 dir) {
    float up = clamp(dir.y, 0.0, 1.0);
    vec3 base = mix(uHorizonColor, uZenithColor, pow(up, 0.55));
    float sunDot = max(dot(dir, uSunDir), 0.0);
    base += uSunColor * pow(sunDot, 9.0) * 0.35;
    return base;
  }

  void main() {
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    float dist = length(cameraPosition - vWorldPos);

    // Detail ripples: two scrolling normal maps at different scales, faded out
    // with distance so the horizon does not shimmer.
    vec2 drift = vec2(uTime * 0.021, uTime * 0.014) + vFlow * uTime * 0.05;
    vec3 n1 = sampleNormal(vWorldPos.xz * 0.045 + drift, 1.0);
    vec3 n2 = sampleNormal(vWorldPos.xz * 0.011 - drift * 0.6, 1.0);
    float detailFade = 1.0 - smoothstep(60.0, 900.0, dist);
    vec3 detail = normalize(mix(vec3(0.0, 1.0, 0.0), normalize(n1 * 0.65 + n2 * 0.55), detailFade * uRipple));

    vec3 normal = normalize(vWaveNormal * 0.65 + detail * uNormalScale);

    float fres = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 4.2);
    fres = mix(0.03, 1.0, fres);

    vec3 refl = reflect(-viewDir, normal);
    refl.y = abs(refl.y);
    vec3 reflection = skyColor(refl);

    // Absorption: the deeper the water, the darker and bluer it gets.
    float depthFade = 1.0 - exp(-max(vDepth, 0.0) * 0.42);
    vec3 body = mix(uShallowColor, uDeepColor, depthFade);
    body *= mix(0.25, 1.0, 1.0 - uNight * 0.8);

    // Specular glitter from the sun.
    vec3 halfVec = normalize(uSunDir + viewDir);
    float spec = pow(max(dot(normal, halfVec), 0.0), 420.0) * 5.0;
    spec += pow(max(dot(normal, halfVec), 0.0), 42.0) * 0.35;

    vec3 color = mix(body, reflection, fres);
    color += uSunColor * spec * (1.0 - uNight);

    // Foam: at the shoreline and on the steepest wave crests.
    float shore = 1.0 - smoothstep(0.05, 1.35, vDepth);
    float crest = smoothstep(0.22, 0.5, vCrest);
    float foamNoise = texture2D(uNormalMap, vWorldPos.xz * 0.16 + drift * 2.0).r;
    float foam = clamp(shore * (0.55 + foamNoise * 0.9) + crest * 0.35 * foamNoise, 0.0, 1.0) * uFoam;
    color = mix(color, vec3(0.92, 0.95, 0.97) * (0.35 + 0.65 * (1.0 - uNight)), foam);

    float alpha = clamp(0.72 + fres * 0.4 + foam * 0.6, 0.0, 1.0);
    alpha *= smoothstep(0.0, 0.35, vDepth + 0.25);

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
