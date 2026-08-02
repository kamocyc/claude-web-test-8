import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  Vector2,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GradeShader } from './GradeShader';
import { QUALITY_PROFILES, type GameSettings, type QualityProfile } from './Settings';
import { clamp } from './MathUtils';

export type FrameCallback = (dt: number, elapsed: number) => void;

/**
 * Owns the WebGL context, the render graph and the frame loop.
 *
 * The simulation is stepped at a fixed rate (120 Hz) independently of the
 * display refresh so train physics stay stable; rendering happens once per
 * animation frame with the leftover accumulator used for interpolation.
 */
export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly composer: EffectComposer;

  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private readonly gradePass: ShaderPass;
  private readonly smaaPass: SMAAPass;
  private readonly outputPass: OutputPass;

  private lastTime = 0;
  private totalTime = 0;
  private accumulator = 0;
  private readonly fixedStep = 1 / 120;
  private running = false;
  private rafId = 0;

  private updateCb: FrameCallback = () => {};
  private renderCb: FrameCallback = () => {};

  /**
   * Post-processing watchdog.
   *
   * Some drivers cannot render the half-float targets the bloom pass needs and
   * return a completely black frame instead of failing, which loses the whole
   * picture even though the scene itself is fine. The first few seconds of
   * output are sampled; if the composer only ever produces black, bloom is
   * dropped, and if that does not help post-processing is bypassed entirely.
   * Rendering something plain is always better than rendering nothing.
   */
  private postStage: 'full' | 'nobloom' | 'off' = 'full';
  private watchdogTimer = 0;
  private blackFrames = 0;
  private watchdogChecks = 12;
  private readonly pixelProbe = new Uint8Array(4 * 16);

  /** Smoothed frame time in milliseconds, for the debug overlay. */
  frameMs = 16;
  fps = 60;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private resolutionScale = 1;
  private lowFrameStreak = 0;
  private highFrameStreak = 0;

  profile: QualityProfile;
  /** Screenshot mode: stable buffer, no dynamic resolution. */
  private readonly captureMode =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('capture');

  constructor(
    readonly canvas: HTMLCanvasElement,
    settings: GameSettings,
  ) {
    this.profile = QUALITY_PROFILES[settings.quality];

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false, // SMAA in the composer instead
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      // Keeping the drawing buffer lets screenshot tooling capture a frame.
      preserveDrawingBuffer: this.captureMode,
    });
    this.renderer.setPixelRatio(this.targetPixelRatio());
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    // A touch under one: the daylight sun is bright enough to clip greens to a
    // pale wash at unity exposure, which drains the colour out of the land.
    this.renderer.toneMappingExposure = 0.82;
    this.renderer.info.autoReset = true;

    this.camera = new PerspectiveCamera(
      settings.fov,
      window.innerWidth / window.innerHeight,
      0.12,
      this.profile.viewDistance * 1.6,
    );

    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.targetPixelRatio());

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(
      new Vector2(window.innerWidth, window.innerHeight),
      0.36, // strength - a gentle bloom, not a haze
      0.75, // radius
      0.92, // threshold: only genuine highlights bloom
    );
    this.bloomPass.enabled = this.profile.bloom;
    this.composer.addPass(this.bloomPass);

    this.outputPass = new OutputPass();
    this.composer.addPass(this.outputPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.uniforms.uGrain.value = this.profile.grain ? 0.035 : 0;
    this.composer.addPass(this.gradePass);

    this.smaaPass = new SMAAPass();
    this.composer.addPass(this.smaaPass);

    // `?post=off` renders the scene straight to the canvas, which is the first
    // thing to try if a device shows a black or broken picture.
    if (
      typeof location !== 'undefined' &&
      new URLSearchParams(location.search).get('post') === 'off'
    ) {
      this.disablePost();
    }

    this.resize();
    window.addEventListener('resize', this.resize);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private targetPixelRatio(): number {
    const ratio = clamp(
      window.devicePixelRatio * this.resolutionScale,
      0.6,
      this.profile.maxPixelRatio,
    );
    // The composer holds two full-size half-float buffers and the bloom pass
    // ten more, so a retina 4K panel at ratio 1.5 asks for far more video
    // memory than the picture is worth - and on a tight GPU that is where a
    // frame quietly turns black. Cap the drawing buffer by area as well.
    const budget = 6_200_000;
    const pixels = window.innerWidth * window.innerHeight * ratio * ratio;
    if (pixels <= budget) return ratio;
    return Math.max(0.6, ratio * Math.sqrt(budget / pixels));
  }

  applySettings(settings: GameSettings): void {
    this.profile = QUALITY_PROFILES[settings.quality];
    this.camera.fov = settings.fov;
    this.camera.far = this.profile.viewDistance * 1.6;
    this.camera.updateProjectionMatrix();
    this.bloomPass.enabled = this.profile.bloom && this.postStage === 'full';
    this.gradePass.uniforms.uGrain.value = this.profile.grain ? 0.035 : 0;
    this.renderer.shadowMap.enabled = true;
    this.resolutionScale = 1;
    this.resize();
    // A new quality level is a new pipeline: watch this one too.
    if (this.postStage !== 'off') {
      this.blackFrames = 0;
      this.watchdogChecks = 12;
      this.watchdogTimer = 0.4;
    }
  }

  /** Exposed so the sky/weather system can drive lens glare and wet glass. */
  setGrade(glare: number, wet: number): void {
    this.gradePass.uniforms.uGlare.value = glare;
    this.gradePass.uniforms.uWet.value = wet;
  }

  private resize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = this.targetPixelRatio();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.gradePass.uniforms.uResolution.value.set(w * pr, h * pr);
    this.bloomPass.resolution.set(w, h);
  };

  private onContextLost = (e: Event): void => {
    // Preventing the default asks the browser for a restored context rather
    // than leaving the canvas dead.
    e.preventDefault();
    this.stop();
    console.error('WebGL context lost - waiting for it to be restored');
  };

  private onContextRestored = (): void => {
    console.warn('WebGL context restored - dropping post-processing to be safe');
    this.disablePost();
    this.resize();
    this.start();
  };

  onUpdate(cb: FrameCallback): void {
    this.updateCb = cb;
  }

  onRender(cb: FrameCallback): void {
    this.renderCb = cb;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    const now = performance.now() / 1000;
    const rawDt = Math.min(now - this.lastTime, 0.25);
    this.lastTime = now;
    this.totalTime += rawDt;
    const elapsed = this.totalTime;

    // Fixed-step simulation, capped so a long stall cannot spiral.
    this.accumulator += rawDt;
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < 8) {
      this.updateCb(this.fixedStep, elapsed);
      this.accumulator -= this.fixedStep;
      steps++;
    }
    if (steps === 8) this.accumulator = 0;

    this.renderCb(rawDt, elapsed);
    this.gradePass.uniforms.uTime.value = elapsed;

    const t0 = performance.now();
    this.renderFrame(rawDt);
    const cost = performance.now() - t0;

    this.frameMs = this.frameMs * 0.9 + (rawDt * 1000) * 0.1;
    this.fpsAccum += rawDt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.adaptResolution();
    }
    void cost;
  };

  /**
   * Draws one frame through whichever pipeline is still known to work, and
   * watches the result for the all-black output some drivers produce instead
   * of an error.
   */
  private renderFrame(dt: number): void {
    if (this.postStage === 'off') {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    try {
      this.composer.render(dt);
    } catch (error) {
      console.error('post-processing failed, rendering directly', error);
      this.disablePost();
      return;
    }

    if (this.watchdogChecks > 0) {
      this.watchdogTimer -= dt;
      if (this.watchdogTimer <= 0) {
        this.watchdogTimer = 0.4;
        this.watchdogChecks--;
        this.checkForBlackFrame();
      }
    }
  }

  /**
   * Reads back a few pixels from the middle of the frame that was just drawn.
   * The sky is always lit at this point, so an exactly black result means the
   * pipeline - not the scene - is at fault.
   */
  private checkForBlackFrame(): void {
    const gl = this.renderer.getContext();
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;
    if (w < 8 || h < 8) return;

    this.renderer.setRenderTarget(null);
    try {
      gl.readPixels(
        Math.floor(w / 2) - 2,
        Math.floor(h / 2) - 2,
        4,
        4,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        this.pixelProbe,
      );
    } catch {
      this.watchdogChecks = 0;
      return;
    }

    let sum = 0;
    for (let i = 0; i < this.pixelProbe.length; i += 4) {
      sum += this.pixelProbe[i] + this.pixelProbe[i + 1] + this.pixelProbe[i + 2];
    }
    if (sum > 0) {
      // A picture came out: nothing to do, and stop looking.
      this.blackFrames = 0;
      this.watchdogChecks = 0;
      return;
    }

    if (++this.blackFrames < 3) return;
    this.blackFrames = 0;
    if (this.postStage === 'full' && this.bloomPass.enabled) {
      console.warn('bloom produced a black frame on this device - disabling it');
      this.postStage = 'nobloom';
      this.bloomPass.enabled = false;
      this.watchdogChecks = 12;
    } else {
      console.warn('post-processing produced a black frame on this device - bypassing it');
      this.disablePost();
    }
  }

  /** Falls back to drawing the scene straight to the canvas. */
  private disablePost(): void {
    this.postStage = 'off';
    this.watchdogChecks = 0;
    this.bloomPass.enabled = false;
  }

  /** True while the picture is going through the full post chain. */
  get postProcessing(): 'full' | 'nobloom' | 'off' {
    return this.postStage;
  }

  /**
   * Dynamic resolution: nudges the drawing buffer scale to hold ~50 fps
   * without touching scene detail, which would pop visibly.
   */
  private adaptResolution(): void {
    if (this.captureMode) return;
    if (this.fps < 42) {
      this.lowFrameStreak++;
      this.highFrameStreak = 0;
    } else if (this.fps > 58) {
      this.highFrameStreak++;
      this.lowFrameStreak = 0;
    } else {
      this.lowFrameStreak = 0;
      this.highFrameStreak = 0;
    }

    if (this.lowFrameStreak >= 3 && this.resolutionScale > 0.62) {
      this.resolutionScale = Math.max(0.62, this.resolutionScale - 0.08);
      this.lowFrameStreak = 0;
      this.resize();
    } else if (this.highFrameStreak >= 8 && this.resolutionScale < 1) {
      this.resolutionScale = Math.min(1, this.resolutionScale + 0.06);
      this.highFrameStreak = 0;
      this.resize();
    }
  }

  get drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  get triangles(): number {
    return this.renderer.info.render.triangles;
  }
}
