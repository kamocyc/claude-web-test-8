import {
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type IUniform,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ATMOSPHERE_GLSL, ATMOSPHERE_SAMPLE_GLSL } from './AtmosphereGlsl';

/**
 * Bakes the atmosphere into three small look-up tables.
 *
 * Everything here is evaluated on the GPU into half-float targets. The two
 * expensive tables only depend on the shape of the atmosphere, so they are
 * baked once (and again when the air changes turbidity); the sky-view table is
 * the only one that follows the sun, and it is a hundred texels wide.
 */

const QUAD_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const TRANSMITTANCE_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uTexel;
  ${ATMOSPHERE_GLSL}

  void main() {
    float h, mu;
    transmittanceParams(vUv, uTexel, h, mu);
    vec3 pos = vec3(0.0, GROUND_RADIUS + h, 0.0);
    vec3 dir = vec3(sqrt(max(0.0, 1.0 - mu * mu)), mu, 0.0);

    float tGround = raySphere(pos, dir, GROUND_RADIUS);
    float tTop = raySphere(pos, dir, ATMO_RADIUS);
    float tMax = tGround > 0.0 ? tGround : max(tTop, 0.0);

    const int STEPS = 40;
    float dt = tMax / float(STEPS);
    vec3 depth = vec3(0.0);
    for (int i = 0; i < STEPS; i++) {
      vec3 p = pos + dir * (dt * (float(i) + 0.5));
      vec3 sR, ext;
      float sM;
      sampleMedium(length(p) - GROUND_RADIUS, sR, sM, ext);
      depth += ext * dt;
    }
    gl_FragColor = vec4(exp(-depth), 1.0);
  }
`;

const MULTISCATTER_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uTexel;
  ${ATMOSPHERE_GLSL}
  ${ATMOSPHERE_SAMPLE_GLSL}

  const int DIRS = 16;
  const int STEPS = 18;
  const float ISOTROPIC = 1.0 / (4.0 * PI);

  void main() {
    float h, muSun;
    transmittanceParams(vUv, uTexel, h, muSun);
    muSun = clamp(muSun, -1.0, 1.0);
    vec3 pos = vec3(0.0, GROUND_RADIUS + h, 0.0);
    vec3 sunDir = vec3(sqrt(max(0.0, 1.0 - muSun * muSun)), muSun, 0.0);

    vec3 secondOrder = vec3(0.0);
    vec3 transfer = vec3(0.0);

    for (int d = 0; d < DIRS; d++) {
      // Fibonacci sphere: an even spread of directions without a table.
      float fi = float(d) + 0.5;
      float cosTheta = 1.0 - 2.0 * fi / float(DIRS);
      float sinTheta = sqrt(max(0.0, 1.0 - cosTheta * cosTheta));
      float phi = fi * 2.399963229728653;
      vec3 dir = vec3(cos(phi) * sinTheta, cosTheta, sin(phi) * sinTheta);

      float tGround = raySphere(pos, dir, GROUND_RADIUS);
      float tTop = raySphere(pos, dir, ATMO_RADIUS);
      float tMax = tGround > 0.0 ? tGround : max(tTop, 0.0);
      float dt = tMax / float(STEPS);

      vec3 throughput = vec3(1.0);
      for (int i = 0; i < STEPS; i++) {
        vec3 p = pos + dir * (dt * (float(i) + 0.5));
        float ph = length(p) - GROUND_RADIUS;
        vec3 sR, ext;
        float sM;
        sampleMedium(ph, sR, sM, ext);
        vec3 scatter = sR + vec3(sM);
        vec3 stepT = exp(-ext * dt);

        float shadow = raySphere(p, sunDir, GROUND_RADIUS) >= 0.0 ? 0.0 : 1.0;
        vec3 sunT = sunTransmittance(ph, dot(normalize(p), sunDir)) * shadow;

        // Analytic in-scatter over the step keeps 18 steps from banding.
        vec3 integral = (scatter - scatter * stepT) / max(ext, vec3(1e-7));
        secondOrder += throughput * integral * sunT * ISOTROPIC;
        transfer += throughput * integral * ISOTROPIC;
        throughput *= stepT;
      }

      if (tGround > 0.0) {
        vec3 p = pos + dir * tGround;
        vec3 n = normalize(p);
        float ndl = max(0.0, dot(n, sunDir));
        secondOrder += throughput * uGroundAlbedo * ndl * sunTransmittance(0.0, dot(n, sunDir)) / PI;
      }
    }

    secondOrder /= float(DIRS);
    transfer /= float(DIRS);
    // Geometric series over infinitely many bounces of the isotropic transfer.
    vec3 psi = secondOrder / max(vec3(1.0) - transfer, vec3(1e-4));
    gl_FragColor = vec4(psi, 1.0);
  }
`;

const SKYVIEW_FRAGMENT = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uTexel;
  uniform vec3 uSunDir;
  uniform float uCameraHeight;
  uniform float uSunIrradiance;
  uniform sampler2D uMultiScatterLut;
  uniform vec2 uMultiScatterTexel;
  ${ATMOSPHERE_GLSL}
  ${ATMOSPHERE_SAMPLE_GLSL}

  const int STEPS = 32;

  vec3 multiScatter(float h, float mu) {
    return texture2D(uMultiScatterLut, transmittanceUv(h, mu, uMultiScatterTexel)).rgb;
  }

  void main() {
    // The table is built in a frame where the sun lies in the +X/+Y plane; the
    // atmosphere is rotationally symmetric so that costs nothing and lets the
    // table cover a half turn of azimuth instead of a whole one.
    vec2 p = clamp((vUv - 0.5 * uTexel) / (1.0 - uTexel), 0.0, 1.0);
    float azimuth = p.x * PI;
    float s = p.y * 2.0 - 1.0;
    float l = sign(s) * s * s;
    float horiz = sqrt(max(0.0, 1.0 - l * l));
    vec3 dir = normalize(vec3(cos(azimuth) * horiz, l, sin(azimuth) * horiz));
    vec3 sunDir = normalize(vec3(length(vec2(uSunDir.x, uSunDir.z)), uSunDir.y, 1e-6));

    vec3 pos = vec3(0.0, GROUND_RADIUS + uCameraHeight, 0.0);

    float tGround = raySphere(pos, dir, GROUND_RADIUS);
    float tTop = raySphere(pos, dir, ATMO_RADIUS);
    float tMax = tGround > 0.0 ? tGround : max(tTop, 0.0);
    tMax = min(tMax, 400.0);

    float cosTheta = dot(dir, sunDir);
    float phaseR = rayleighPhase(cosTheta);

    vec3 luminance = vec3(0.0);
    float mieLuminance = 0.0;
    vec3 throughput = vec3(1.0);

    for (int i = 0; i < STEPS; i++) {
      // Quadratic step distribution: dense near the eye where the air is thick.
      float t0 = float(i) / float(STEPS);
      float t1 = float(i + 1) / float(STEPS);
      t0 *= t0;
      t1 *= t1;
      float dt = (t1 - t0) * tMax;
      vec3 p = pos + dir * ((t0 * tMax) + dt * 0.5);

      float h = length(p) - GROUND_RADIUS;
      vec3 sR, ext;
      float sM;
      sampleMedium(h, sR, sM, ext);
      vec3 stepT = exp(-ext * dt);

      float muSun = dot(normalize(p), sunDir);
      float shadow = raySphere(p, sunDir, GROUND_RADIUS) >= 0.0 ? 0.0 : 1.0;
      vec3 sunT = sunTransmittance(h, muSun) * shadow;
      vec3 psi = multiScatter(h, muSun);

      vec3 invExt = 1.0 / max(ext, vec3(1e-7));
      vec3 rayleighSource = sR * (phaseR * sunT + psi);
      vec3 mieSource = vec3(sM) * psi;
      vec3 source = rayleighSource + mieSource;
      luminance += throughput * (source - source * stepT) * invExt;

      // The Mie single-scattering term is kept phase-free so the sharp glow
      // around the sun can be rebuilt per pixel rather than per table texel.
      float mieOnly = sM;
      float mieStep = (mieOnly - mieOnly * stepT.g) * invExt.g;
      mieLuminance += throughput.g * mieStep * dot(sunT, vec3(0.2126, 0.7152, 0.0722));

      throughput *= stepT;
    }

    if (tGround > 0.0) {
      vec3 p = pos + dir * tGround;
      vec3 n = normalize(p);
      float ndl = max(0.0, dot(n, sunDir));
      luminance += throughput * uGroundAlbedo * ndl * sunTransmittance(0.0, dot(n, sunDir)) / PI;
    }

    gl_FragColor = vec4(luminance * uSunIrradiance, mieLuminance * uSunIrradiance);
  }
`;

function makeTarget(width: number, height: number): WebGLRenderTarget {
  const target = new WebGLRenderTarget(width, height, {
    type: HalfFloatType,
    format: RGBAFormat,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  target.texture.colorSpace = NoColorSpace;
  return target;
}

const TRANSMITTANCE_SIZE = new Vector2(160, 48);
const MULTISCATTER_SIZE = new Vector2(32, 32);
const SKYVIEW_SIZE = new Vector2(128, 96);

export class SkyLuts {
  readonly transmittance = makeTarget(TRANSMITTANCE_SIZE.x, TRANSMITTANCE_SIZE.y);
  readonly multiScatter = makeTarget(MULTISCATTER_SIZE.x, MULTISCATTER_SIZE.y);
  readonly skyView = makeTarget(SKYVIEW_SIZE.x, SKYVIEW_SIZE.y);

  readonly skyViewTexel = new Vector2(1 / SKYVIEW_SIZE.x, 1 / SKYVIEW_SIZE.y);
  readonly transmittanceTexel = new Vector2(1 / TRANSMITTANCE_SIZE.x, 1 / TRANSMITTANCE_SIZE.y);

  private readonly transmittanceQuad: FullScreenQuad;
  private readonly multiScatterQuad: FullScreenQuad;
  private readonly skyViewQuad: FullScreenQuad;
  private readonly skyViewUniforms: Record<string, IUniform>;
  private readonly shared: Record<string, IUniform>;

  private bakedTurbidity = -1;
  private bakedAlbedo = -1;
  private bakedSun = new Vector3(0, -2, 0);
  private bakedHeight = -1;

  constructor() {
    this.shared = {
      uTurbidity: { value: 1 },
      uGroundAlbedo: { value: 0.18 },
    };

    this.transmittanceQuad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: { ...this.shared, uTexel: { value: this.transmittanceTexel } },
        vertexShader: QUAD_VERTEX,
        fragmentShader: TRANSMITTANCE_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      }),
    );

    this.multiScatterQuad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: {
          ...this.shared,
          uTexel: { value: new Vector2(1 / MULTISCATTER_SIZE.x, 1 / MULTISCATTER_SIZE.y) },
          uTransmittanceLut: { value: this.transmittance.texture },
          uTransmittanceTexel: { value: this.transmittanceTexel },
        },
        vertexShader: QUAD_VERTEX,
        fragmentShader: MULTISCATTER_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      }),
    );

    this.skyViewUniforms = {
      ...this.shared,
      uTexel: { value: this.skyViewTexel },
      uSunDir: { value: new Vector3(0, 1, 0) },
      uCameraHeight: { value: 0.02 },
      // Scales the whole sky into the range the tone mapper wants; every
      // consumer reads the same table so nothing can drift out of step.
      uSunIrradiance: { value: 9.0 },
      uTransmittanceLut: { value: this.transmittance.texture },
      uTransmittanceTexel: { value: this.transmittanceTexel },
      uMultiScatterLut: { value: this.multiScatter.texture },
      uMultiScatterTexel: { value: new Vector2(1 / MULTISCATTER_SIZE.x, 1 / MULTISCATTER_SIZE.y) },
    };
    this.skyViewQuad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: this.skyViewUniforms,
        vertexShader: QUAD_VERTEX,
        fragmentShader: SKYVIEW_FRAGMENT,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  /**
   * Rebakes whatever has gone stale. The two static tables only move when the
   * air itself changes; the sky-view table follows the sun, but a sun that has
   * moved a thousandth of a radian does not need a new one.
   */
  update(
    renderer: WebGLRenderer,
    sunDir: Vector3,
    turbidity: number,
    groundAlbedo: number,
    cameraHeightKm: number,
    force = false,
  ): boolean {
    const staticStale =
      force ||
      Math.abs(turbidity - this.bakedTurbidity) > 0.03 ||
      Math.abs(groundAlbedo - this.bakedAlbedo) > 0.02;

    const previousTarget = renderer.getRenderTarget();
    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;

    if (staticStale) {
      this.shared.uTurbidity.value = turbidity;
      this.shared.uGroundAlbedo.value = groundAlbedo;
      // The uniform objects were spread, not shared, so push the values across.
      for (const quad of [this.transmittanceQuad, this.multiScatterQuad, this.skyViewQuad]) {
        const u = (quad.material as ShaderMaterial).uniforms;
        u.uTurbidity.value = turbidity;
        u.uGroundAlbedo.value = groundAlbedo;
      }
      this.bakedTurbidity = turbidity;
      this.bakedAlbedo = groundAlbedo;

      renderer.setRenderTarget(this.transmittance);
      this.transmittanceQuad.render(renderer);
      renderer.setRenderTarget(this.multiScatter);
      this.multiScatterQuad.render(renderer);
    }

    const sunStale =
      staticStale ||
      this.bakedSun.dot(sunDir) < 0.99997 ||
      Math.abs(cameraHeightKm - this.bakedHeight) > 0.05;

    if (sunStale) {
      this.bakedSun.copy(sunDir);
      this.bakedHeight = cameraHeightKm;
      (this.skyViewUniforms.uSunDir.value as Vector3).copy(sunDir);
      this.skyViewUniforms.uCameraHeight.value = cameraHeightKm;
      renderer.setRenderTarget(this.skyView);
      this.skyViewQuad.render(renderer);
    }

    renderer.setRenderTarget(previousTarget);
    renderer.autoClear = previousAutoClear;
    return sunStale;
  }

  dispose(): void {
    this.transmittance.dispose();
    this.multiScatter.dispose();
    this.skyView.dispose();
    this.transmittanceQuad.dispose();
    this.multiScatterQuad.dispose();
    this.skyViewQuad.dispose();
  }
}
