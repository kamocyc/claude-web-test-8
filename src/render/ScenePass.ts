import {
  DepthFormat,
  DepthTexture,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  NoBlending,
  NoColorSpace,
  RGBAFormat,
  ShaderMaterial,
  UnsignedIntType,
  WebGLRenderTarget,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { FULLSCREEN_VERTEX } from './ShaderChunks';

/**
 * Draws the world into a half-float colour target that also carries a
 * sampleable depth texture, then blits it into the composer chain.
 *
 * `RenderPass` renders straight into the composer's own buffers, whose depth
 * lives in a renderbuffer that no later pass can read. Occlusion, aerial
 * perspective, god rays and depth of field all need the depth of the frame
 * they are shading, so the scene gets its own target and the composer gets a
 * copy. The extra full-screen copy is the price of having depth at all, and it
 * also leaves the untouched HDR scene around for the exposure meter.
 *
 * `simple` mode drops the private target and renders straight into the
 * composer, which is what the black-frame watchdog falls back to: it removes
 * both the depth texture and the second float target from the picture.
 */
export class ScenePass extends Pass {
  /** Colour + depth of the frame just drawn. Null while in simple mode. */
  target: WebGLRenderTarget | null = null;
  private depthTexture: DepthTexture | null = null;
  private readonly quad: FullScreenQuad;
  private readonly material: ShaderMaterial;
  private width = 1;
  private height = 1;
  private simpleMode = false;

  constructor(
    private readonly scene: Scene,
    private camera: Camera,
  ) {
    super();
    this.needsSwap = true;
    this.material = new ShaderMaterial({
      uniforms: { tDiffuse: { value: null } },
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        varying vec2 vUv;
        void main() { gl_FragColor = texture2D(tDiffuse, vUv); }
      `,
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setCamera(camera: Camera): void {
    this.camera = camera;
  }

  /** True when the private HDR + depth target is in use. */
  get hasDepth(): boolean {
    return !this.simpleMode && this.target !== null;
  }

  get depth(): DepthTexture | null {
    return this.simpleMode ? null : this.depthTexture;
  }

  setSimple(simple: boolean): void {
    if (this.simpleMode === simple) return;
    this.simpleMode = simple;
    if (simple) this.releaseTarget();
    else this.ensureTarget();
  }

  private releaseTarget(): void {
    this.target?.dispose();
    this.depthTexture?.dispose();
    this.target = null;
    this.depthTexture = null;
  }

  private ensureTarget(): void {
    if (this.simpleMode || this.target) return;
    const depth = new DepthTexture(this.width, this.height, UnsignedIntType);
    depth.format = DepthFormat;
    depth.minFilter = NearestFilter;
    depth.magFilter = NearestFilter;
    const target = new WebGLRenderTarget(this.width, this.height, {
      type: HalfFloatType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      colorSpace: NoColorSpace,
    });
    target.texture.name = 'ScenePass.hdr';
    target.depthTexture = depth;
    this.depthTexture = depth;
    this.target = target;
  }

  override setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    // The colour target and its depth texture have to agree exactly, and
    // `setSize` does not carry the depth texture with it, so the pair is simply
    // rebuilt. Resizes are rare enough that this costs nothing.
    if (this.target) {
      this.releaseTarget();
      this.ensureTarget();
    }
  }

  override render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    _readBuffer: WebGLRenderTarget,
  ): void {
    if (this.simpleMode) {
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      renderer.clear(true, true, true);
      renderer.render(this.scene, this.camera);
      return;
    }

    this.ensureTarget();
    const target = this.target;
    if (!target) return;

    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
    renderer.render(this.scene, this.camera);

    this.material.uniforms.tDiffuse.value = target.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  override dispose(): void {
    this.releaseTarget();
    this.material.dispose();
    this.quad.dispose();
  }
}
