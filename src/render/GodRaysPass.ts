import {
  ClampToEdgeWrapping,
  HalfFloatType,
  LinearFilter,
  NoBlending,
  RGBAFormat,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { FULLSCREEN_VERTEX, LUMINANCE, NOISE_UTILS } from './ShaderChunks';

/**
 * Screen-space crepuscular rays.
 *
 * The occlusion mask is simply "is this pixel sky, and how bright is it" -
 * exactly the light that is getting past whatever is in the way - so anything
 * solid casts a shaft without needing a separate occlusion render. The mask and
 * the radial blur are folded into a single quarter-resolution pass: each of the
 * marching steps samples depth and colour together, which is a great deal
 * cheaper than building the mask first and blurring it afterwards.
 *
 * The whole thing is gated on the sun actually being in front of the camera and
 * above the horizon; a train sim spends a lot of its time pointing away from
 * the sun and there is no reason to pay for shafts then.
 */
export class GodRaysPass extends Pass {
  private readonly target: WebGLRenderTarget;
  private readonly material: ShaderMaterial;
  private readonly quad: FullScreenQuad;

  /** Sun position in screen UV, and whether it is on screen at all. */
  private readonly sunUv = new Vector2(0.5, 0.5);
  private sunVisible = 0;

  constructor() {
    super();
    this.needsSwap = false;
    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.material = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uSunUv: { value: new Vector2(0.5, 0.5) },
        uDensity: { value: 0.86 },
        uDecay: { value: 0.955 },
        uWeight: { value: 0.36 },
        uThreshold: { value: 0.62 },
        uStrength: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform vec2 uSunUv;
        uniform float uDensity;
        uniform float uDecay;
        uniform float uWeight;
        uniform float uThreshold;
        uniform float uStrength;
        varying vec2 vUv;
        ${LUMINANCE}
        ${NOISE_UTILS}

        const int STEPS = 24;

        void main() {
          vec2 delta = (vUv - uSunUv) * (uDensity / float(STEPS));
          // Jitter the march so the shafts band into noise rather than steps;
          // the quarter-res blur that follows turns the noise back into smooth
          // light.
          vec2 uv = vUv - delta * interleavedGradientNoise(gl_FragCoord.xy);
          float illumination = 1.0;
          vec3 total = vec3(0.0);

          for (int i = 0; i < STEPS; i++) {
            uv -= delta;
            float d = texture2D(tDepth, uv).x;
            // Only unoccluded sky contributes: that is what a shaft is.
            float sky = step(0.999995, d);
            vec3 c = texture2D(tDiffuse, uv).rgb;
            float l = max(lumaOf(c) - uThreshold, 0.0);
            total += c * min(l, 6.0) * sky * illumination;
            illumination *= uDecay;
          }

          gl_FragColor = vec4(total * (uWeight / float(STEPS)) * uStrength, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  get texture(): Texture {
    return this.target.texture;
  }

  /** How much shaft to composite, 0 when the sun is behind or below. */
  get strength(): number {
    return this.sunVisible;
  }

  /**
   * Projects the sun into screen space. `sunDirection` points from the world
   * towards the sun; `viewProjection` is the camera matrix for this frame.
   */
  setSun(screenX: number, screenY: number, visibility: number): void {
    this.sunUv.set(screenX, screenY);
    this.sunVisible = visibility;
    this.material.uniforms.uSunUv.value.copy(this.sunUv);
  }

  override setSize(width: number, height: number): void {
    this.target.setSize(
      Math.max(1, Math.floor(width * 0.25)),
      Math.max(1, Math.floor(height * 0.25)),
    );
  }

  depthTexture: Texture | null = null;

  override render(
    renderer: WebGLRenderer,
    _write: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    if (!this.depthTexture || this.sunVisible <= 0.001) return;
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.material.uniforms.tDepth.value = this.depthTexture;
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.dispose();
  }
}
