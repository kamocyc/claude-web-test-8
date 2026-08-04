import {
  ACESFilmicToneMapping,
  Color,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  type DirectionalLight,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GradeShader } from './GradeShader';
import { QUALITY_PROFILES, type GameSettings, type QualityProfile } from './Settings';
import { clamp, clamp01, lerp, smoothstep } from './MathUtils';
import { ScenePass } from '../render/ScenePass';
import { AmbientOcclusionPass } from '../render/AmbientOcclusionPass';
import { GodRaysPass } from '../render/GodRaysPass';
import { AtmospherePass } from '../render/AtmospherePass';
import { BloomPass } from '../render/BloomPass';
import { AutoExposure } from '../render/AutoExposure';
import { ShadowFitter } from '../render/ShadowFitter';
import { SharpenShader } from '../render/SharpenPass';

export type FrameCallback = (dt: number, elapsed: number) => void;

/** Everything the render pipeline needs to know about the world it is drawing. */
export interface EnvironmentState {
  /** Unit vector from the world towards the sun. */
  sunDirection: Vector3;
  sunColor: Color;
  /** Colour of the sky at the horizon; the base tint of the haze. */
  horizonColor: Color;
  zenithColor: Color;
  /** Windscreen glare from the sun, 0-1. */
  glare: number;
  /** Rain and grease on the glass, 0-1. */
  wet: number;
  /** 0 clear, 1 overcast. */
  overcast: number;
  /** 0 daylight, 1 full night. */
  night: number;
  /** 0 outside, 1 fully inside a tunnel. */
  tunnel: number;
  /** Air thickness multiplier from the biome (coast and river valleys haze). */
  haze: number;
}

/** One point on the time-of-day look curve. */
interface Look {
  slope: [number, number, number];
  offset: [number, number, number];
  power: [number, number, number];
  contrast: number;
  saturation: number;
  vibrance: number;
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  exposureBias: number;
}

/**
 * Daylight: neutral, a touch of contrast, cool shadows from the sky bounce and
 * barely-warm highlights. The reference the other looks are graded against.
 */
const LOOK_DAY: Look = {
  slope: [1.0, 1.0, 1.0],
  offset: [0.0, 0.0, 0.002],
  power: [1.0, 1.0, 1.0],
  contrast: 1.22,
  saturation: 1.2,
  vibrance: 0.22,
  shadowTint: [0.9, 0.96, 1.12],
  highlightTint: [1.05, 1.0, 0.94],
  exposureBias: 1.0,
};

/**
 * Golden hour. The whole point of the split tone: gold in the highlights,
 * genuinely blue in the shadows, and more saturation than noon because low sun
 * through thick air is more saturated.
 */
const LOOK_GOLDEN: Look = {
  slope: [1.04, 1.0, 0.95],
  offset: [-0.004, -0.002, 0.006],
  power: [0.98, 1.0, 1.04],
  contrast: 1.2,
  saturation: 1.24,
  vibrance: 0.3,
  shadowTint: [0.8, 0.9, 1.22],
  highlightTint: [1.16, 1.0, 0.79],
  exposureBias: 1.02,
};

/**
 * Night. Desaturated but not monochrome, blue in everything that is not lit,
 * blacks crushed a little so the frame still has a true black in it.
 */
const LOOK_NIGHT: Look = {
  slope: [0.97, 0.99, 1.05],
  offset: [-0.006, -0.004, 0.004],
  power: [1.06, 1.04, 0.97],
  contrast: 1.02,
  saturation: 0.82,
  vibrance: 0.12,
  shadowTint: [0.7, 0.83, 1.3],
  highlightTint: [0.96, 0.99, 1.1],
  exposureBias: 0.86,
};

/** Overcast: flat, milky, drained. Blended over whatever the sun is doing. */
const LOOK_OVERCAST: Look = {
  slope: [0.99, 1.0, 1.01],
  offset: [0.01, 0.011, 0.014],
  power: [1.0, 1.0, 1.0],
  contrast: 0.96,
  saturation: 0.88,
  vibrance: 0.24,
  shadowTint: [0.94, 0.97, 1.06],
  highlightTint: [0.99, 1.0, 1.02],
  exposureBias: 0.98,
};

function mixLook(a: Look, b: Look, t: number, out: Look): Look {
  for (let i = 0; i < 3; i++) {
    out.slope[i] = lerp(a.slope[i], b.slope[i], t);
    out.offset[i] = lerp(a.offset[i], b.offset[i], t);
    out.power[i] = lerp(a.power[i], b.power[i], t);
    out.shadowTint[i] = lerp(a.shadowTint[i], b.shadowTint[i], t);
    out.highlightTint[i] = lerp(a.highlightTint[i], b.highlightTint[i], t);
  }
  out.contrast = lerp(a.contrast, b.contrast, t);
  out.saturation = lerp(a.saturation, b.saturation, t);
  out.vibrance = lerp(a.vibrance, b.vibrance, t);
  out.exposureBias = lerp(a.exposureBias, b.exposureBias, t);
  return out;
}

function cloneLook(source: Look): Look {
  return {
    slope: [...source.slope],
    offset: [...source.offset],
    power: [...source.power],
    contrast: source.contrast,
    saturation: source.saturation,
    vibrance: source.vibrance,
    shadowTint: [...source.shadowTint],
    highlightTint: [...source.highlightTint],
    exposureBias: source.exposureBias,
  };
}

/**
 * Owns the WebGL context, the render graph and the frame loop.
 *
 * The simulation is stepped at a fixed rate (120 Hz) independently of the
 * display refresh so train physics stay stable; rendering happens once per
 * animation frame with the leftover accumulator used for interpolation.
 *
 * The render graph is:
 *
 *   scene -> HDR + depth        ScenePass
 *   ambient occlusion           AmbientOcclusionPass  (half res, own buffer)
 *   crepuscular rays            GodRaysPass           (quarter res, own buffer)
 *   composite + aerial persp.   AtmospherePass
 *   bloom pyramid               BloomPass
 *   exposure, AgX, grade        GradePass
 *   antialiasing                SMAAPass
 *
 * Everything from the occlusion pass to the bloom can be switched off by the
 * quality profile or by the black-frame watchdog without breaking the chain,
 * and the whole composer can be bypassed for a plain forward render.
 */
export class Engine {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;
  readonly composer: EffectComposer;

  private readonly scenePass: ScenePass;
  private readonly aoPass: AmbientOcclusionPass;
  private readonly godRaysPass: GodRaysPass;
  private readonly atmospherePass: AtmospherePass;
  private readonly bloomPass: BloomPass;
  private readonly gradePass: ShaderPass;
  private readonly smaaPass: SMAAPass;
  private readonly sharpenPass: ShaderPass;
  private readonly exposure = new AutoExposure();
  private readonly shadowFitter = new ShadowFitter();

  private sun: DirectionalLight | null = null;

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
   * output are sampled; if the composer only ever produces black, everything
   * that needs an off-screen float buffer is dropped - the occlusion, aerial
   * perspective, god ray and bloom buffers together with the scene's own HDR
   * target - and if that does not help post-processing is bypassed entirely.
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

  private readonly look = cloneLook(LOOK_DAY);
  private readonly lookScratch = cloneLook(LOOK_DAY);
  private readonly sunWorld = new Vector3();
  private readonly cameraForward = new Vector3();
  private readonly cameraWorld = new Vector3();

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
    // r185's PCF filter is a rotated Vogel disk whose radius is a real
    // parameter, so plain PCF is both softer and more controllable than
    // PCFSoftShadowMap's fixed dilation.
    this.renderer.shadowMap.type = PCFShadowMap;
    // Tone mapping only ever applies when the renderer draws straight to the
    // canvas, which is the watchdog's last-resort path; the composer does its
    // own AgX curve in the grade pass.
    this.renderer.toneMapping = ACESFilmicToneMapping;
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

    this.scenePass = new ScenePass(this.scene, this.camera);
    this.composer.addPass(this.scenePass);

    this.aoPass = new AmbientOcclusionPass(this.camera);
    this.composer.addPass(this.aoPass);

    this.godRaysPass = new GodRaysPass();
    this.composer.addPass(this.godRaysPass);

    this.atmospherePass = new AtmospherePass();
    this.composer.addPass(this.atmospherePass);

    this.bloomPass = new BloomPass();
    this.composer.addPass(this.bloomPass);

    this.gradePass = new ShaderPass(GradeShader);
    this.gradePass.uniforms.tExposure.value = this.exposure.texture;
    this.composer.addPass(this.gradePass);

    this.smaaPass = new SMAAPass();
    this.composer.addPass(this.smaaPass);

    // After the antialiasing, never before it: this exists to give back the
    // edge contrast SMAA has just spent to stop the wires crawling.
    this.sharpenPass = new ShaderPass(SharpenShader);
    this.composer.addPass(this.sharpenPass);

    this.applyProfile();

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

  /**
   * Hands the engine the sun so its shadow cascade can be aimed at what is on
   * screen. Without this the shadows still work, they are just softer and
   * spend most of their resolution behind the camera.
   */
  setSunLight(light: DirectionalLight | null): void {
    this.sun = light;
  }

  private targetPixelRatio(): number {
    const ratio = clamp(
      window.devicePixelRatio * this.resolutionScale,
      0.6,
      this.profile.maxPixelRatio,
    );
    // The composer holds two full-size half-float buffers, the scene pass a
    // third, and the bloom pyramid another two-thirds of one, so a retina 4K
    // panel at ratio 1.5 asks for far more video memory than the picture is
    // worth - and on a tight GPU that is where a frame quietly turns black.
    // Cap the drawing buffer by area as well.
    const budget = 6_200_000;
    const pixels = window.innerWidth * window.innerHeight * ratio * ratio;
    if (pixels <= budget) return ratio;
    return Math.max(0.6, ratio * Math.sqrt(budget / pixels));
  }

  /** Switches the optional passes on and off to match the quality profile. */
  private applyProfile(): void {
    const p = this.profile;
    const full = this.postStage === 'full';

    this.scenePass.setSimple(!full);
    this.scenePass.setDepthEnabled(p.ao || p.atmosphere || p.godRays);

    const wantAo = full && p.ao;
    const wantAtmosphere = full && p.atmosphere;
    const wantRays = full && p.godRays;
    const wantBloom = full && p.bloom && p.bloomLevels > 0;
    const wantExposure = full && p.autoExposure;

    this.aoPass.enabled = wantAo;
    this.aoPass.configure(p.aoScale, p.aoSamples, 1.15, 1.05);
    this.godRaysPass.enabled = wantRays;
    this.atmospherePass.enabled = wantAtmosphere;
    this.atmospherePass.setFeatures(wantAo, wantRays);
    this.bloomPass.enabled = wantBloom;
    if (wantBloom) {
      this.bloomPass.setLevels(p.bloomLevels);
      this.bloomPass.strength = p.bloomStrength;
      // Well above the exposed value of a daylight sky: a wide pyramid fed a
      // half-frame of bright sky turns the whole picture milky, and the things
      // that should actually glow are the sun, wet rail heads and lamps.
      this.bloomPass.threshold = 1.35;
    }
    this.bloomPass.setAutoExposure(wantExposure);
    this.bloomPass.exposureTexture = wantExposure ? this.exposure.texture : null;

    const defines = this.gradePass.material.defines;
    const flag = wantExposure ? 1 : 0;
    if (defines.AUTO_EXPOSURE !== flag) {
      defines.AUTO_EXPOSURE = flag;
      this.gradePass.material.needsUpdate = true;
    }
    this.gradePass.uniforms.tExposure.value = this.exposure.texture;
    this.gradePass.uniforms.uGrain.value = p.grain ? 0.028 : 0;
  }

  applySettings(settings: GameSettings): void {
    this.profile = QUALITY_PROFILES[settings.quality];
    this.camera.fov = settings.fov;
    this.camera.far = this.profile.viewDistance * 1.6;
    this.camera.updateProjectionMatrix();
    this.renderer.shadowMap.enabled = true;
    this.resolutionScale = 1;
    this.applyProfile();
    this.exposure.reset();
    this.resize();
    // A new quality level is a new pipeline: watch this one too.
    if (this.postStage !== 'off') {
      this.blackFrames = 0;
      this.watchdogChecks = 12;
      this.watchdogTimer = 0.4;
    }
  }

  /**
   * Feeds the pipeline the state of the world it is drawing: where the sun is,
   * what colour the air is, and what time of day the grade should be wearing.
   */
  setEnvironment(state: EnvironmentState): void {
    const elevation = state.sunDirection.y;
    const daylight = clamp01(1 - state.night);

    // --- the look ------------------------------------------------------
    const golden = Math.exp(-Math.pow((elevation - 0.11) / 0.15, 2));
    const night = clamp01(state.night);
    const look = mixLook(LOOK_DAY, LOOK_GOLDEN, golden * (1 - night), this.lookScratch);
    mixLook(look, LOOK_NIGHT, night, this.look);
    mixLook(this.look, LOOK_OVERCAST, state.overcast * 0.8 * daylight, this.look);
    // A tunnel is a concrete tube lit by its own lamps: no colour in it at all.
    if (state.tunnel > 0.001) {
      mixLook(this.look, LOOK_NIGHT, state.tunnel * 0.55, this.look);
    }

    const g = this.gradePass.uniforms;
    g.uGlare.value = state.glare;
    g.uWet.value = state.wet;
    // The veil on the lens is a fraction of the wash on the glass: the two
    // together are what a low sun through a windscreen actually looks like,
    // and either one alone at full strength looks like a filter.
    this.atmospherePass.uniforms.uGlare.value = state.glare * 0.4;
    g.uSlope.value.fromArray(this.look.slope);
    g.uOffset.value.fromArray(this.look.offset);
    g.uPower.value.fromArray(this.look.power);
    g.uContrast.value = this.look.contrast;
    g.uSaturation.value = this.look.saturation;
    g.uVibrance.value = this.look.vibrance;
    g.uShadowTint.value.setRGB(
      this.look.shadowTint[0],
      this.look.shadowTint[1],
      this.look.shadowTint[2],
    );
    g.uHighlightTint.value.setRGB(
      this.look.highlightTint[0],
      this.look.highlightTint[1],
      this.look.highlightTint[2],
    );
    g.uExposureBias.value = this.look.exposureBias;
    // Grain is film, and film gets grainier the less light there is.
    g.uGrain.value = this.profile.grain
      ? 0.024 + night * 0.026 + state.tunnel * 0.012
      : 0;
    g.uDirt.value = 0.35 + state.wet * 0.5;

    // --- sun on screen -------------------------------------------------
    this.camera.getWorldPosition(this.cameraWorld);
    this.camera.getWorldDirection(this.cameraForward);
    this.sunWorld.copy(this.cameraWorld).addScaledVector(state.sunDirection, 4000);
    this.sunWorld.project(this.camera);
    const sunU = this.sunWorld.x * 0.5 + 0.5;
    const sunV = this.sunWorld.y * 0.5 + 0.5;
    const inFront = this.cameraForward.dot(state.sunDirection);
    // Off-screen by more than half a frame and the shafts have nothing to do.
    const onScreen =
      smoothstep(1.5, 0.9, Math.abs(this.sunWorld.x)) *
      smoothstep(1.5, 0.9, Math.abs(this.sunWorld.y));
    const visibility =
      clamp01(inFront * 3) *
      onScreen *
      clamp01(smoothstep(-0.02, 0.09, elevation)) *
      (1 - state.overcast * 0.75) *
      (1 - state.tunnel);

    g.uSunUv.value.set(sunU, sunV);
    this.godRaysPass.setSun(sunU, sunV, visibility);

    // --- atmosphere ----------------------------------------------------
    const a = this.atmospherePass.uniforms;
    a.uSunDir.value.copy(state.sunDirection);
    a.uSunColor.value.copy(state.sunColor);
    a.uHazeColor.value.copy(state.horizonColor);
    a.uZenithColor.value.copy(state.zenithColor);
    a.uSunUv.value.set(sunU, sunV);
    a.uDaylight.value = daylight;
    // Thicker air near the coast and in river valleys, thicker again in rain,
    // and thicker still when the sun is low and going through more of it.
    const thickness = state.haze * lerp(1, 1.5, state.overcast) * lerp(1, 1.45, state.wet);
    a.uRayleigh.value = 0.00013 * thickness;
    a.uMie.value = 0.00012 * thickness * lerp(1, 1.9, golden);
    a.uGodRayStrength.value = visibility * 0.85;
    a.uAoStrength.value = 0.95;
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
    this.sharpenPass.uniforms.uTexel.value.set(1 / (w * pr), 1 / (h * pr));
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

    this.renderFrame(rawDt);

    this.frameMs = this.frameMs * 0.9 + (rawDt * 1000) * 0.1;
    this.fpsAccum += rawDt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      this.adaptResolution();
    }
  };

  /**
   * Draws one frame through whichever pipeline is still known to work, and
   * watches the result for the all-black output some drivers produce instead
   * of an error.
   */
  private renderFrame(dt: number): void {
    if (this.sun) {
      this.shadowFitter.fit(
        this.sun,
        this.camera,
        this.profile.shadowDistance,
        this.profile.shadowFocus,
        this.profile.shadowSoftness,
      );
    }

    if (this.postStage === 'off') {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }

    try {
      // The occlusion and aerial perspective passes read the depth of the
      // frame the scene pass has just drawn, so they are wired up here rather
      // than held as long-lived references: the scene pass rebuilds its target
      // whenever the window resizes or the watchdog changes its mind.
      const depth = this.scenePass.depth;
      this.aoPass.depthTexture = depth;
      this.godRaysPass.depthTexture = depth;
      this.atmospherePass.depthTexture = depth;
      this.atmospherePass.aoTexture = this.aoPass.enabled ? this.aoPass.texture : null;
      this.atmospherePass.godRayTexture = this.godRaysPass.enabled
        ? this.godRaysPass.texture
        : null;
      this.atmospherePass.uniforms.uInvProjection.value.copy(this.camera.projectionMatrixInverse);
      this.atmospherePass.uniforms.uCameraRange.value.set(this.camera.near, this.camera.far);
      this.atmospherePass.uniforms.uViewToWorld.value.copy(this.camera.matrixWorld);

      this.composer.render(dt);

      // Meter the HDR scene for the next frame's exposure. Reading it after
      // the composer keeps it one frame stale, which nobody can see and which
      // costs nothing.
      if (this.profile.autoExposure && this.scenePass.target) {
        this.exposure.update(this.renderer, this.scenePass.target.texture, dt);
      }
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
    if (this.postStage === 'full') {
      console.warn(
        'the float buffers produced a black frame on this device - dropping to a plain render plus grade',
      );
      this.postStage = 'nobloom';
      this.applyProfile();
      // Without a metered exposure the grade needs a fixed one.
      this.gradePass.uniforms.uExposure.value = 0.95;
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
    this.applyProfile();
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
