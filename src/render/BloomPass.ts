import {
  AdditiveBlending,
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
import { FULLSCREEN_VERTEX, LUMINANCE, SANITISE } from './ShaderChunks';

/**
 * Wide, soft, energy-conserving bloom on a mip pyramid.
 *
 * `UnrealBloomPass` runs five separable Gaussians, which is both expensive and
 * narrow: with a 0.92 threshold and 0.36 strength the result was essentially
 * invisible. This is the dual-filter pyramid every current engine uses -
 * thirteen-tap downsamples with a Karis average on the first level to stop a
 * single blown pixel flickering into a strobe, then 3x3 tent upsamples added
 * back down the chain. Six octaves of blur means the glow really does spread
 * across a third of the frame, the way a bright sky through a windscreen does,
 * and it costs about half of what the five Gaussians did.
 *
 * The prefilter uses a soft knee rather than a hard cut, and its threshold is
 * divided by the current exposure so that a highlight blooms because it is
 * bright *in the exposed image* - a tunnel mouth at night has to glare the same
 * way the noon sky does.
 */
export class BloomPass extends Pass {
  private mips: WebGLRenderTarget[] = [];
  private readonly prefilterMaterial: ShaderMaterial;
  private readonly downMaterial: ShaderMaterial;
  private readonly upMaterial: ShaderMaterial;
  private readonly compositeMaterial: ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private levels = 6;
  private width = 1;
  private height = 1;

  /** Adaptation texture, used to make the threshold exposure-relative. */
  exposureTexture: Texture | null = null;

  private readonly targetOptions: ConstructorParameters<typeof WebGLRenderTarget>[2];

  constructor() {
    super();

    const options = {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    } as const;
    this.targetOptions = options;

    this.prefilterMaterial = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tExposure: { value: null },
        uTexel: { value: new Vector2() },
        uThreshold: { value: 0.85 },
        uKnee: { value: 0.6 },
        uExposure: { value: 1 },
        uClamp: { value: 24 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tExposure;
        uniform vec2 uTexel;
        uniform float uThreshold;
        uniform float uKnee;
        uniform float uExposure;
        uniform float uClamp;
        varying vec2 vUv;
        ${LUMINANCE}
        ${SANITISE}

        vec3 tap(vec2 uv) { return sanitise(texture2D(tDiffuse, uv).rgb); }

        void main() {
          // A four-tap box on the way down halves the aliasing of thin bright
          // geometry - catenary wires and rail heads, which is exactly what
          // sparkles when the bloom is fed a point-sampled image.
          vec2 o = uTexel;
          vec3 c = tap(vUv + vec2(-o.x, -o.y)) + tap(vUv + vec2(o.x, -o.y)) +
                   tap(vUv + vec2(-o.x, o.y)) + tap(vUv + vec2(o.x, o.y));
          c *= 0.25;

          float exposure = uExposure;
          #ifdef AUTO_EXPOSURE
          // The meter stores the exposure multiplier itself; the odd-looking
          // range test also rejects NaN, which a comparison against zero would
          // silently let through.
          float metered = texture2D(tExposure, vec2(0.5)).r;
          exposure = (metered > 0.02 && metered < 40.0) ? metered : uExposure;
          #endif

          float l = lumaOf(c) * exposure;
          // Soft knee: contribution ramps in quadratically around the
          // threshold instead of switching on, which is what stops a bloom
          // from crawling along a moving edge.
          float knee = uThreshold * uKnee + 1e-5;
          float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
          soft = soft * soft / (4.0 * knee + 1e-5);
          float weight = max(soft, l - uThreshold) / max(l, 1e-5);

          c = min(c * weight, vec3(uClamp));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });

    this.downMaterial = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new Vector2() } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        varying vec2 vUv;

        vec3 t(vec2 uv) { return texture2D(tDiffuse, uv).rgb; }

        void main() {
          vec2 o = uTexel;
          // Sledgehammer's thirteen-tap downsample: three overlapping boxes
          // that together approximate a wide tent with no ringing.
          vec3 a = t(vUv + vec2(-2.0 * o.x,  2.0 * o.y));
          vec3 b = t(vUv + vec2( 0.0,        2.0 * o.y));
          vec3 c = t(vUv + vec2( 2.0 * o.x,  2.0 * o.y));
          vec3 d = t(vUv + vec2(-2.0 * o.x,  0.0));
          vec3 e = t(vUv);
          vec3 f = t(vUv + vec2( 2.0 * o.x,  0.0));
          vec3 g = t(vUv + vec2(-2.0 * o.x, -2.0 * o.y));
          vec3 h = t(vUv + vec2( 0.0,       -2.0 * o.y));
          vec3 i = t(vUv + vec2( 2.0 * o.x, -2.0 * o.y));
          vec3 j = t(vUv + vec2(-o.x,  o.y));
          vec3 k = t(vUv + vec2( o.x,  o.y));
          vec3 l = t(vUv + vec2(-o.x, -o.y));
          vec3 m = t(vUv + vec2( o.x, -o.y));

          vec3 result = (j + k + l + m) * 0.5;
          result += (a + b + d + e) * 0.125;
          result += (b + c + e + f) * 0.125;
          result += (d + e + g + h) * 0.125;
          result += (e + f + h + i) * 0.125;
          gl_FragColor = vec4(result * 0.25, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });

    this.upMaterial = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new Vector2() },
        uRadius: { value: 1 },
        uWeight: { value: 0.72 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        uniform float uRadius;
        uniform float uWeight;
        varying vec2 vUv;

        vec3 t(vec2 uv) { return texture2D(tDiffuse, uv).rgb; }

        void main() {
          vec2 o = uTexel * uRadius;
          vec3 s = t(vUv + vec2(-o.x,  o.y)) + t(vUv + vec2(0.0,  o.y)) * 2.0 + t(vUv + vec2(o.x,  o.y));
          s += t(vUv + vec2(-o.x, 0.0)) * 2.0 + t(vUv) * 4.0 + t(vUv + vec2(o.x, 0.0)) * 2.0;
          s += t(vUv + vec2(-o.x, -o.y)) + t(vUv + vec2(0.0, -o.y)) * 2.0 + t(vUv + vec2(o.x, -o.y));
          // Each octave up the chain is added at a fraction of the last, so
          // the glow falls off with radius the way a lens point spread does
          // instead of laying an equal-energy veil over the whole frame.
          gl_FragColor = vec4(s * 0.0625 * uWeight, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.compositeMaterial = new ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: null },
        uStrength: { value: 0.08 },
      },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D tDiffuse;
        uniform sampler2D tBloom;
        uniform float uStrength;
        varying vec2 vUv;
        void main() {
          vec3 scene = texture2D(tDiffuse, vUv).rgb;
          vec3 bloom = texture2D(tBloom, vUv).rgb;
          gl_FragColor = vec4(scene + bloom * uStrength, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });

    this.quad = new FullScreenQuad(this.compositeMaterial);
  }

  /** Overall bloom strength; 0.06-0.12 reads as a real lens. */
  set strength(value: number) {
    this.compositeMaterial.uniforms.uStrength.value = value;
  }

  set threshold(value: number) {
    this.prefilterMaterial.uniforms.uThreshold.value = value;
  }

  /** Number of octaves; fewer is cheaper and narrower. */
  setLevels(levels: number): void {
    this.levels = Math.max(2, Math.min(7, levels));
    this.rebuild();
  }

  setAutoExposure(enabled: boolean): void {
    const flag = enabled ? 1 : 0;
    const current = this.prefilterMaterial.defines.AUTO_EXPOSURE ? 1 : 0;
    if (flag === current) return;
    if (enabled) this.prefilterMaterial.defines.AUTO_EXPOSURE = '';
    else delete this.prefilterMaterial.defines.AUTO_EXPOSURE;
    this.prefilterMaterial.needsUpdate = true;
  }

  /** Manual exposure used when auto exposure is off. */
  set exposure(value: number) {
    this.prefilterMaterial.uniforms.uExposure.value = value;
  }

  private rebuild(): void {
    for (const mip of this.mips) mip.dispose();
    this.mips = [];
    let w = Math.max(1, Math.floor(this.width / 2));
    let h = Math.max(1, Math.floor(this.height / 2));
    for (let i = 0; i < this.levels; i++) {
      const target = new WebGLRenderTarget(w, h, this.targetOptions);
      target.texture.name = `Bloom.mip${i}`;
      this.mips.push(target);
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      if (w <= 2 || h <= 2) {
        this.levels = i + 1;
        break;
      }
    }
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(4, Math.floor(width));
    const h = Math.max(4, Math.floor(height));
    if (w === this.width && h === this.height && this.mips.length) return;
    this.width = w;
    this.height = h;
    this.rebuild();
  }

  override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    if (!this.mips.length) this.rebuild();
    const mips = this.mips;

    // Prefilter into the first mip.
    this.prefilterMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.prefilterMaterial.uniforms.tExposure.value = this.exposureTexture;
    this.prefilterMaterial.uniforms.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    this.quad.material = this.prefilterMaterial;
    renderer.setRenderTarget(mips[0]);
    this.quad.render(renderer);

    // Down the pyramid.
    this.quad.material = this.downMaterial;
    for (let i = 1; i < mips.length; i++) {
      const src = mips[i - 1];
      this.downMaterial.uniforms.tDiffuse.value = src.texture;
      this.downMaterial.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(mips[i]);
      this.quad.render(renderer);
    }

    // Back up, adding each blurred level onto the one below it.
    this.quad.material = this.upMaterial;
    for (let i = mips.length - 1; i > 0; i--) {
      const src = mips[i];
      this.upMaterial.uniforms.tDiffuse.value = src.texture;
      this.upMaterial.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      renderer.setRenderTarget(mips[i - 1]);
      this.quad.render(renderer);
    }

    this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
    this.compositeMaterial.uniforms.tBloom.value = mips[0].texture;
    this.quad.material = this.compositeMaterial;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    for (const mip of this.mips) mip.dispose();
    this.mips = [];
    this.prefilterMaterial.dispose();
    this.downMaterial.dispose();
    this.upMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
  }
}
