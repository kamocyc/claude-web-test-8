import {
  ClampToEdgeWrapping,
  HalfFloatType,
  NearestFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FULLSCREEN_VERTEX, LUMINANCE, SANITISE } from './ShaderChunks';

/**
 * Eye adaptation.
 *
 * Nothing in this game handled the enormous range between a noon sky, a rainy
 * dusk and the inside of a tunnel: exposure was pinned at 0.82 and the tunnels
 * simply went black. This meters the frame on the GPU and hands the result back
 * as a one-by-one texture, so there is no `readPixels` and therefore no
 * pipeline stall.
 *
 * Metering is a log-average, which is robust to the sun being in shot in a way
 * an arithmetic mean is not, weighted towards the centre of the frame and away
 * from the top of it - a driver's eye is on the road ahead, not on the sky, and
 * an unweighted meter would stop the land down to a silhouette every time the
 * line came out from under trees.
 *
 * Adaptation is asymmetric: opening up in the dark is slow, stopping down in
 * the light is fast, which is both what an eye does and what stops a tunnel
 * mouth from strobing.
 */
export class AutoExposure {
  private readonly coarse: WebGLRenderTarget;
  private readonly mid: WebGLRenderTarget;
  private readonly fine: WebGLRenderTarget;
  private adaptA: WebGLRenderTarget;
  private adaptB: WebGLRenderTarget;

  private readonly meterMaterial: ShaderMaterial;
  private readonly reduceMaterial: ShaderMaterial;
  private readonly adaptMaterial: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private primed = false;

  constructor() {
    const options = {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    } as const;
    this.coarse = new WebGLRenderTarget(64, 64, options);
    this.mid = new WebGLRenderTarget(8, 8, options);
    this.fine = new WebGLRenderTarget(1, 1, options);
    this.adaptA = new WebGLRenderTarget(1, 1, options);
    this.adaptB = new WebGLRenderTarget(1, 1, options);

    this.meterMaterial = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        ${LUMINANCE}
        ${SANITISE}
        void main() {
          // The meter reads the raw scene target, ahead of the scrub the blit
          // does, so it has to do its own.
          vec3 c = sanitise(texture2D(tDiffuse, vUv).rgb);
          // Bound the meter at both ends. The ceiling stops a glance at the
          // solar disc from stopping the whole landscape down; the floor
          // matters just as much, because a log average is dominated by its
          // darkest samples and a frame with a strip of shadowed ballast
          // across it would otherwise open up until the sky was gone.
          float l = clamp(lumaOf(c), 0.012, 12.0);
          vec2 d = vUv - vec2(0.5, 0.42);
          float centre = exp(-dot(d, d) * 3.4);
          float sky = 1.0 - 0.6 * smoothstep(0.55, 0.95, vUv.y);
          float w = centre * sky + 0.05;
          gl_FragColor = vec4(log2(l + 0.0008) * w, w, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });

    this.reduceMaterial = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new Vector2(1 / 64, 1 / 64) } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main() {
          vec2 sum = vec2(0.0);
          // Each output texel covers an 8x8 block of the level above.
          for (int y = 0; y < 8; y++) {
            for (int x = 0; x < 8; x++) {
              vec2 uv = vUv + (vec2(float(x), float(y)) - 3.5) * uTexel;
              sum += texture2D(tDiffuse, uv).rg;
            }
          }
          gl_FragColor = vec4(sum / 64.0, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });

    this.adaptMaterial = new ShaderMaterial({
      uniforms: {
        tCurrent: { value: null },
        tPrevious: { value: null },
        uKey: { value: 0.46 },
        uMin: { value: 0.26 },
        uMax: { value: 2.0 },
        uUpRate: { value: 0.55 },
        uDownRate: { value: 2.4 },
        uDelta: { value: 0.016 },
        uPrimed: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tCurrent;
        uniform sampler2D tPrevious;
        uniform float uKey;
        uniform float uMin;
        uniform float uMax;
        uniform float uUpRate;
        uniform float uDownRate;
        uniform float uDelta;
        uniform float uPrimed;
        varying vec2 vUv;

        void main() {
          vec2 meter = texture2D(tCurrent, vec2(0.5)).rg;
          float logL = meter.r / max(meter.g, 1e-4);
          logL = (logL > -40.0 && logL < 40.0) ? logL : 0.0;
          float target = clamp(uKey / max(exp2(logL), 1e-4), uMin, uMax);

          float previous = texture2D(tPrevious, vec2(0.5)).r;
          previous = (previous > 0.02 && previous < 40.0) ? previous : target;

          // Adapt in log space so a stop is a stop whatever the level.
          float lp = log2(previous);
          float lt = log2(target);
          float rate = lt > lp ? uUpRate : uDownRate;
          float k = 1.0 - exp(-uDelta * rate);
          float result = exp2(mix(lp, lt, mix(1.0, k, uPrimed)));
          gl_FragColor = vec4(clamp(result, uMin, uMax), 0.0, 0.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });

    this.quad = new FullScreenQuad(this.meterMaterial);
  }

  /** One-by-one texture holding the current exposure multiplier. */
  get texture(): Texture {
    return this.adaptA.texture;
  }

  configure(key: number, min: number, max: number): void {
    this.adaptMaterial.uniforms.uKey.value = key;
    this.adaptMaterial.uniforms.uMin.value = min;
    this.adaptMaterial.uniforms.uMax.value = max;
  }

  /** Forces the next frame to jump straight to the metered value. */
  reset(): void {
    this.primed = false;
  }

  update(renderer: WebGLRenderer, source: Texture, dt: number): void {
    const previousTarget = renderer.getRenderTarget();

    this.meterMaterial.uniforms.tDiffuse.value = source;
    this.quad.material = this.meterMaterial;
    renderer.setRenderTarget(this.coarse);
    this.quad.render(renderer);

    this.quad.material = this.reduceMaterial;
    this.reduceMaterial.uniforms.tDiffuse.value = this.coarse.texture;
    this.reduceMaterial.uniforms.uTexel.value.set(1 / 64, 1 / 64);
    renderer.setRenderTarget(this.mid);
    this.quad.render(renderer);

    this.reduceMaterial.uniforms.tDiffuse.value = this.mid.texture;
    this.reduceMaterial.uniforms.uTexel.value.set(1 / 8, 1 / 8);
    renderer.setRenderTarget(this.fine);
    this.quad.render(renderer);

    this.adaptMaterial.uniforms.tCurrent.value = this.fine.texture;
    this.adaptMaterial.uniforms.tPrevious.value = this.adaptA.texture;
    this.adaptMaterial.uniforms.uDelta.value = Math.min(dt, 0.1);
    this.adaptMaterial.uniforms.uPrimed.value = this.primed ? 1 : 0;
    this.quad.material = this.adaptMaterial;
    renderer.setRenderTarget(this.adaptB);
    this.quad.render(renderer);

    const swap = this.adaptA;
    this.adaptA = this.adaptB;
    this.adaptB = swap;
    this.primed = true;

    renderer.setRenderTarget(previousTarget);
  }

  dispose(): void {
    this.coarse.dispose();
    this.mid.dispose();
    this.fine.dispose();
    this.adaptA.dispose();
    this.adaptB.dispose();
    this.meterMaterial.dispose();
    this.reduceMaterial.dispose();
    this.adaptMaterial.dispose();
    this.quad.dispose();
  }
}
