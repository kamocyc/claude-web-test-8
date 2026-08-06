import {
  ClampToEdgeWrapping,
  GLSL3,
  RepeatWrapping,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type IUniform,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SKY_MAPPING_GLSL } from './AtmosphereGlsl';
import { cloudNoise, sampleShape, type CloudNoiseData } from './CloudNoise';

/**
 * Volumetric clouds.
 *
 * A proper raymarch - Perlin-Worley density through a spherical shell, a short
 * march towards the sun for self-shadowing, dual-lobe Henyey-Greenstein phase
 * so the cloud you are looking through towards the sun lights up, Beer-Powder
 * for the dark edges and a three-octave approximation of multiple scattering
 * so the interiors are not black.
 *
 * The expensive part is decoupled from the frame rate by marching into a
 * table indexed by view *direction* rather than by screen pixel. Turning the
 * camera costs nothing, so the table can be refreshed a band at a time over
 * several frames and still be exactly right: only the wind moves it, and the
 * wind is slow.
 */

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const CLOUD_FRAGMENT = /* glsl */ `
  precision highp float;
  precision highp sampler3D;

  // three only declares the fragment output for its own GLSL1 path; asking for
  // GLSL3 (which sampler3D needs) means declaring it here.
  layout(location = 0) out highp vec4 pc_fragColor;
  #define gl_FragColor pc_fragColor

  varying vec2 vUv;

  uniform sampler3D uShape;
  uniform sampler3D uDetail;
  uniform sampler2D uSkyView;
  uniform vec2 uSkyViewTexel;

  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  // The light actually falling on the cloud deck: the sun by day, the moon at
  // night. The sun direction is still needed for the sky table lookup.
  uniform vec3 uKeyDir;
  uniform vec3 uKeyColor;
  uniform vec3 uSunTint;
  uniform vec3 uGroundBounce;
  uniform vec2 uWeatherOffset;
  uniform vec3 uWindOffset;
  uniform float uCameraY;

  uniform float uCoverageLow;
  uniform float uCoverageHigh;
  uniform float uBottom;
  uniform float uTop;
  uniform float uType;        // 0 flat stratus .. 1 heaped cumulus
  uniform float uDensity;
  uniform float uAbsorption;  // extra darkening for storm cloud
  uniform float uDetailStrength;
  uniform float uCirrus;
  uniform float uFloor;
  uniform float uNight;

  ${SKY_MAPPING_GLSL}

  const float PLANET_R = 6360000.0;
  const float WEATHER_SCALE = 0.0000167;
  const float SHAPE_SCALE = 0.00021;
  const float DETAIL_SCALE = 0.0026;

  float remap(float v, float a, float b, float c, float d) {
    return c + (v - a) / (b - a) * (d - c);
  }

  /** Far intersection of a ray starting inside a sphere centred at the origin. */
  float sphereFar(vec3 ro, vec3 rd, float radius) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - radius * radius;
    float d = b * b - c;
    if (d < 0.0) return -1.0;
    return -b + sqrt(d);
  }

  /**
   * The weather field: where clouds are at all, before any vertical shaping.
   * Read from the same volume the CPU reads for cloud shadows.
   */
  float weatherField(vec2 pos) {
    vec2 wp = pos * WEATHER_SCALE + uWeatherOffset;
    float a = texture(uShape, vec3(wp, 0.31)).b;
    float b = texture(uShape, vec3(wp * 2.7, 0.63)).r;
    return a * 0.62 + b * 0.55;
  }

  float heightGradient(float hf) {
    float stratus = smoothstep(0.0, 0.08, hf) * smoothstep(1.0, 0.62, hf);
    float cumulus = smoothstep(0.0, 0.20, hf) * smoothstep(1.0, 0.66, hf);
    return mix(stratus, cumulus, uType);
  }

  float cloudDensity(vec3 p, float hf, bool cheap) {
    float cover = clamp(smoothstep(uCoverageLow, uCoverageHigh, weatherField(p.xz)), 0.0, 1.0);
    if (cover <= 0.002) return 0.0;

    vec3 sp = p * SHAPE_SCALE + uWindOffset;
    vec4 shape = texture(uShape, sp);
    float worleyFbm = shape.g * 0.625 + shape.b * 0.25 + shape.a * 0.125;
    float base = remap(shape.r, worleyFbm - 1.0, 1.0, 0.0, 1.0);
    base *= heightGradient(hf);

    // Coverage narrows with height, which is what gives a cumulus its heaped
    // shape: broad flat base, rounded top, rather than a slab with a texture.
    float shaped = max(cover * mix(1.0, 0.52, hf * hf * uType), 0.004);
    float d = remap(base, 1.0 - shaped, 1.0, 0.0, 1.0);
    // An overcast deck has no holes in it. Without a floor the noise leaves
    // thin patches the sun burns straight through, and a rainy sky ends up
    // looking like a sky that is clearing.
    d = max(d, cover * uFloor * heightGradient(hf));
    if (d <= 0.0) return 0.0;

    if (!cheap) {
      vec3 dp = p * DETAIL_SCALE + uWindOffset * 3.0;
      vec3 det = texture(uDetail, dp).rgb;
      float dw = det.r * 0.625 + det.g * 0.25 + det.b * 0.125;
      // Billows at the base, wisps at the top.
      dw = mix(dw, 1.0 - dw, clamp(hf * 3.0, 0.0, 1.0));
      d = remap(d, dw * uDetailStrength, 1.0, 0.0, 1.0);
    }
    return max(d, 0.0) * uDensity;
  }

  /**
   * Direction for a table texel. Azimuth runs the whole way round (the texture
   * wraps, so there is no seam) and elevation is square-root warped, which
   * spends the rows on the horizon where a cloud field compresses to nothing.
   * An octahedral map was tried first and creased visibly along its folds.
   */
  vec3 tableDir(vec2 uv) {
    float azimuth = (uv.x - 0.5) * 2.0 * SKY_PI;
    float elev = uv.y * uv.y * (SKY_PI * 0.5);
    float y = sin(elev);
    float r = cos(elev);
    return vec3(cos(azimuth) * r, y, sin(azimuth) * r);
  }

  float lightMarch(vec3 p, float baseHeight, float span) {
    float depth = 0.0;
    float t = 0.0;
    float step = span * 0.055;
    for (int i = 0; i < 4; i++) {
      t += step;
      vec3 q = p + uKeyDir * t;
      float hf = clamp((q.y - baseHeight) / span, 0.0, 1.0);
      depth += cloudDensity(q, hf, true) * step;
      step *= 1.9;
    }
    return depth;
  }

  void main() {
    vec3 dir = tableDir(vUv);
    vec3 skyCol = skyRadiance(uSkyView, uSkyViewTexel, dir, uSunDir, uSunTint);
    vec3 ambientTop = skyRadiance(uSkyView, uSkyViewTexel, vec3(0.0, 1.0, 0.0), uSunDir, uSunTint);

    vec3 ro = vec3(0.0, PLANET_R + uCameraY, 0.0);
    float span = uTop - uBottom;

    float tStart = sphereFar(ro, dir, PLANET_R + uBottom);
    float tEnd = sphereFar(ro, dir, PLANET_R + uTop);
    vec3 scattered = vec3(0.0);
    float transmittance = 1.0;
    float depthWeight = 0.0;
    float depthSum = 0.0;

    if (tEnd > 0.0 && dir.y > -0.02) {
      tStart = max(tStart, 0.0);
      float march = min(tEnd - tStart, 55000.0);
      // Steps lengthen with distance: a cloud four kilometres off deserves the
      // detail, one on the horizon is a smudge whatever you spend on it.
      const float GROWTH = 1.055;
      float unit = march * (GROWTH - 1.0) / (pow(GROWTH, float(CLOUD_STEPS)) - 1.0);
      float cosTheta = dot(dir, uKeyDir);

      float t = tStart;
      float dt = unit;
      for (int i = 0; i < CLOUD_STEPS; i++) {
        if (transmittance < 0.015) break;
        vec3 p = ro + dir * (t + dt * 0.5);
        float height = length(p) - PLANET_R;
        float hf = clamp((height - uBottom) / span, 0.0, 1.0);
        float density = cloudDensity(vec3(p.x, height, p.z), hf, false);

        if (density > 0.001) {
          float sigma = density * 0.06 * uAbsorption;
          // Once the ray is mostly blocked the self-shadowing march stops
          // paying for itself, and an overcast sky is nearly all blocked ray.
          float shadowDepth = transmittance > 0.12
            ? lightMarch(vec3(p.x, height, p.z), uBottom, span)
            : density * span * 0.35;

          // Three octaves of Beer's law with the phase flattening as the order
          // rises: the first bounce gives the silver lining towards the sun,
          // the later ones fill the shaded sides so the interior is grey, not
          // black. This is what stops a raymarched cloud looking like soot.
          float energy = 0.0;
          float att = 1.0;
          float contrib = 1.0;
          float ecc = 1.0;
          for (int o = 0; o < 4; o++) {
            float ph = mix(skyHgPhase(cosTheta, 0.78 * ecc), skyHgPhase(cosTheta, -0.32 * ecc), 0.22);
            energy += contrib * exp(-shadowDepth * 0.06 * att * uAbsorption) * ph * 12.566;
            att *= 0.36;
            contrib *= 0.6;
            ecc *= 0.5;
          }

          // Powder: light scattered back out of a thin edge, which is why the
          // rims of a cloud facing away from you go dark.
          float powder = 1.0 - exp(-density * 7.0);
          float powderMix = mix(1.0, powder, 0.6 * clamp(0.5 - cosTheta * 0.5, 0.0, 1.0));

          float shade = exp(-shadowDepth * 0.05 * uAbsorption);
          vec3 sun = uKeyColor * energy * powderMix * 0.62;
          // The underside of an overcast deck is grey, not black: it is lit
          // through by everything above it, and it is what lights the ground.
          vec3 ambient = mix(uGroundBounce, ambientTop * 1.35, hf * 0.7 + 0.3) * (0.62 + 0.7 * shade);
          vec3 source = (sun + ambient) * sigma;

          float stepT = exp(-sigma * dt);
          scattered += transmittance * (source - source * stepT) / max(sigma, 1e-6);
          depthSum += t * transmittance * (1.0 - stepT);
          depthWeight += transmittance * (1.0 - stepT);
          transmittance *= stepT;
        }
        t += dt;
        dt *= GROWTH;
      }
    }

    // High cirrus: a thin shell, too high and too flat to be worth marching.
    if (uCirrus > 0.001 && dir.y > 0.005) {
      float tc = sphereFar(ro, dir, PLANET_R + 8200.0);
      vec3 pc = ro + dir * tc;
      vec2 cp = vec2(pc.x, pc.z) * 0.00004 + uWeatherOffset * 1.7;
      float f = texture(uShape, vec3(cp * vec2(0.45, 1.6), 0.17)).r;
      float g = texture(uShape, vec3(cp * vec2(1.7, 5.0) + 0.4, 0.55)).b;
      float veil = clamp(smoothstep(0.52, 0.86, f * 0.65 + g * 0.5), 0.0, 1.0);
      veil *= uCirrus * smoothstep(0.005, 0.09, dir.y);
      if (veil > 0.001) {
        float cosTheta = dot(dir, uKeyDir);
        float glow = 1.0 + skyHgPhase(cosTheta, 0.62) * 14.0;
        vec3 col = uKeyColor * 0.075 * glow + ambientTop * 0.45;
        float a = veil * 0.26;
        scattered += transmittance * col * a;
        transmittance *= 1.0 - a;
        depthSum += tc * depthWeight * 0.0;
      }
    }

    // Aerial perspective: cloud far enough away is just more sky.
    float meanDepth = depthWeight > 0.001 ? depthSum / depthWeight : 0.0;
    float fade = 1.0 - exp(-meanDepth * 0.000021);
    vec3 target = skyCol * (1.0 - transmittance);
    scattered = mix(scattered, target, fade * 0.85);

    gl_FragColor = vec4(scattered, transmittance);
  }
`;

export interface CloudSettings {
  /** Fractional sky coverage, 0 clear .. 1 overcast. */
  coverage: number;
  /** 0 = flat stratus sheet, 1 = heaped cumulus. */
  type: number;
  bottom: number;
  top: number;
  density: number;
  /** >1 darkens the interior; storm cloud. */
  absorption: number;
  detail: number;
  cirrus: number;
  /** Minimum density inside the deck; what makes an overcast sky solid. */
  floor: number;
}

const scratchScissor = new Vector4();

const LUT_SIZES: Record<string, number> = {
  low: 320,
  medium: 512,
  high: 768,
  ultra: 1024,
};

const STEP_COUNTS: Record<string, number> = {
  low: 22,
  medium: 30,
  high: 44,
  ultra: 60,
};

const BAND_COUNTS: Record<string, number> = {
  low: 12,
  medium: 10,
  high: 8,
  ultra: 8,
};

export class CloudLayer {
  readonly target: WebGLRenderTarget;
  private readonly quad: FullScreenQuad;
  private readonly uniforms: Record<string, IUniform>;
  private readonly noise: CloudNoiseData;
  private readonly bands: number;
  private band = 0;
  private primed = false;
  private lastSignature = -1e9;
  private readonly size: number;

  private readonly weatherOffset = new Vector2();
  private readonly windOffset = new Vector3();

  settings: CloudSettings = {
    coverage: 0.4,
    type: 1,
    bottom: 1250,
    top: 2900,
    density: 1,
    absorption: 1,
    detail: 0.32,
    cirrus: 0.25,
    floor: 0,
  };

  constructor(quality: string) {
    this.noise = cloudNoise();
    this.size = LUT_SIZES[quality] ?? 512;
    this.bands = BAND_COUNTS[quality] ?? 8;
    const steps = STEP_COUNTS[quality] ?? 48;

    this.target = new WebGLRenderTarget(this.size, this.size >> 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: RepeatWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.colorSpace = NoColorSpace;

    this.uniforms = {
      uShape: { value: this.noise.shape },
      uDetail: { value: this.noise.detail },
      uSkyView: { value: null },
      uSkyViewTexel: { value: new Vector2(1, 1) },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uSunColor: { value: new Vector3(1, 1, 1) },
      uKeyDir: { value: new Vector3(0, 1, 0) },
      uKeyColor: { value: new Vector3(1, 1, 1) },
      uSunTint: { value: new Vector3(1, 1, 1) },
      uGroundBounce: { value: new Vector3(0.1, 0.1, 0.1) },
      uWeatherOffset: { value: this.weatherOffset },
      uWindOffset: { value: this.windOffset },
      uCameraY: { value: 0 },
      uCoverageLow: { value: 0.6 },
      uCoverageHigh: { value: 1.0 },
      uBottom: { value: 1250 },
      uTop: { value: 2900 },
      uType: { value: 1 },
      uDensity: { value: 1 },
      uAbsorption: { value: 1 },
      uDetailStrength: { value: 0.32 },
      uCirrus: { value: 0.25 },
      uFloor: { value: 0 },
      uNight: { value: 0 },
    };

    this.quad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: QUAD_VERTEX,
        fragmentShader: `#define CLOUD_STEPS ${steps}\n${CLOUD_FRAGMENT}`,
        glslVersion: GLSL3,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  get texture() {
    return this.target.texture;
  }

  /**
   * Coverage of the sun as seen from a point on the ground, read from the same
   * weather field the raymarch uses. Drives the cloud shadow over the line.
   */
  sunOcclusion(x: number, z: number, sunDir: Vector3): number {
    if (sunDir.y < 0.03) return 0;
    const level = (this.settings.bottom + this.settings.top) * 0.5;
    const t = level / sunDir.y;
    const px = x + sunDir.x * t;
    const pz = z + sunDir.z * t;
    const wp = 0.0000167;
    const ax = px * wp + this.weatherOffset.x;
    const az = pz * wp + this.weatherOffset.y;
    const a = sampleShape(this.noise, ax, az, 0.31, 2);
    const b = sampleShape(this.noise, ax * 2.7, az * 2.7, 0.63, 0);
    const field = a * 0.62 + b * 0.55;
    const low = this.uniforms.uCoverageLow.value as number;
    const high = this.uniforms.uCoverageHigh.value as number;
    const cover = Math.min(1, Math.max(0, (field - low) / Math.max(1e-4, high - low)));
    return cover * cover * (3 - 2 * cover);
  }

  setEnvironment(
    skyView: WebGLRenderTarget,
    skyViewTexel: Vector2,
    sunDir: Vector3,
    keyDir: Vector3,
    keyColor: Vector3,
    sunTint: Vector3,
    groundBounce: Vector3,
    cameraY: number,
    night: number,
  ): void {
    this.uniforms.uSkyView.value = skyView.texture;
    (this.uniforms.uSkyViewTexel.value as Vector2).copy(skyViewTexel);
    (this.uniforms.uSunDir.value as Vector3).copy(sunDir);
    (this.uniforms.uKeyDir.value as Vector3).copy(keyDir);
    (this.uniforms.uKeyColor.value as Vector3).copy(keyColor);
    (this.uniforms.uSunTint.value as Vector3).copy(sunTint);
    (this.uniforms.uGroundBounce.value as Vector3).copy(groundBounce);
    this.uniforms.uCameraY.value = cameraY;
    this.uniforms.uNight.value = night;
  }

  /** Advances the drift and pushes the weather shape into the shader. */
  setWeather(dt: number, windX: number, windZ: number, windSpeed: number): void {
    const s = this.settings;
    // Weather systems crawl; the cloud detail moves with the wind proper.
    this.weatherOffset.x -= windX * windSpeed * dt * 0.0000042;
    this.weatherOffset.y -= windZ * windSpeed * dt * 0.0000042;
    this.windOffset.x -= windX * windSpeed * dt * 0.000021;
    this.windOffset.z -= windZ * windSpeed * dt * 0.000021;
    this.windOffset.y += dt * 0.0000035;

    const cover = Math.min(1, Math.max(0, s.coverage));
    // A wide threshold band gives scattered cumulus; a narrow one at low
    // threshold gives a solid overcast deck.
    const width = 0.42 - cover * 0.3;
    const low = 1.16 - cover * 1.16 - width * 0.5;
    this.uniforms.uCoverageLow.value = low;
    this.uniforms.uCoverageHigh.value = low + width;
    this.uniforms.uBottom.value = s.bottom;
    this.uniforms.uTop.value = s.top;
    this.uniforms.uType.value = s.type;
    this.uniforms.uDensity.value = s.density;
    this.uniforms.uAbsorption.value = s.absorption;
    this.uniforms.uDetailStrength.value = s.detail;
    this.uniforms.uCirrus.value = s.cirrus;
    this.uniforms.uFloor.value = s.floor;
  }

  /**
   * A single number standing for the whole cloudscape. Refreshing the table a
   * band at a time is invisible while only the wind is moving it, but a change
   * of weather would show up as a stack of horizontal steps across the sky, so
   * a material change forces the whole table at once instead.
   */
  private signature(): number {
    const s = this.settings;
    return (
      s.coverage * 12 +
      s.type * 4 +
      s.bottom * 0.002 +
      s.top * 0.002 +
      s.density * 2 +
      s.absorption * 2 +
      s.cirrus * 3 +
      s.floor * 4 +
      (this.uniforms.uKeyDir.value as Vector3).y * 3
    );
  }

  /** Renders one band of the table, or the whole thing the first time round. */
  render(renderer: WebGLRenderer, force = false): void {
    const sig = this.signature();
    if (Math.abs(sig - this.lastSignature) > 0.02) force = true;
    this.lastSignature = sig;

    const previous = renderer.getRenderTarget();
    const previousScissorTest = renderer.getScissorTest();
    const previousScissor = renderer.getScissor(scratchScissor).clone();
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.target);

    if (force || !this.primed) {
      renderer.setScissorTest(false);
      this.quad.render(renderer);
      this.primed = true;
      this.band = 0;
    } else {
      const rows = this.size >> 1;
      const h = Math.ceil(rows / this.bands);
      const y = this.band * h;
      renderer.setScissorTest(true);
      renderer.setScissor(0, y, this.size, Math.min(h, rows - y));
      this.quad.render(renderer);
      renderer.setScissorTest(false);
      this.band = (this.band + 1) % this.bands;
    }

    renderer.setRenderTarget(previous);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.autoClear = previousAutoClear;
  }

  dispose(): void {
    this.target.dispose();
    this.quad.dispose();
  }
}
