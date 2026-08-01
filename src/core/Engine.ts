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
    this.renderer.toneMappingExposure = 0.95;
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

    this.resize();
    window.addEventListener('resize', this.resize);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
  }

  private targetPixelRatio(): number {
    return clamp(window.devicePixelRatio * this.resolutionScale, 0.6, this.profile.maxPixelRatio);
  }

  applySettings(settings: GameSettings): void {
    this.profile = QUALITY_PROFILES[settings.quality];
    this.camera.fov = settings.fov;
    this.camera.far = this.profile.viewDistance * 1.6;
    this.camera.updateProjectionMatrix();
    this.bloomPass.enabled = this.profile.bloom;
    this.gradePass.uniforms.uGrain.value = this.profile.grain ? 0.035 : 0;
    this.renderer.shadowMap.enabled = true;
    this.resolutionScale = 1;
    this.resize();
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
    e.preventDefault();
    this.stop();
    console.error('WebGL context lost');
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
    this.composer.render(rawDt);
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
