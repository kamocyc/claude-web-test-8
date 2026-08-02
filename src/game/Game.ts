import { Color, Vector3 } from 'three';
import { Engine } from '../core/Engine';
import { Input } from '../core/Input';
import { Rng } from '../core/Random';
import {
  QUALITY_PROFILES,
  loadSettings,
  saveSettings,
  type GameSettings,
} from '../core/Settings';
import { clamp, clamp01, damp, formatMilepost, lerp, MS_TO_KMH, smoothstep } from '../core/MathUtils';
import { World } from '../world/World';
import { SkySystem } from '../world/Sky';
import { Rain } from '../world/Rain';
import { STRUCT_TUNNEL } from '../world/TrackPath';
import { BIOME_INDEX } from '../world/Biome';
import { updateWind } from '../materials/Materials';
import { textures } from '../materials/TextureFactory';
import { Consist } from '../train/Consist';
import { Traffic } from '../train/Traffic';
import {
  COMMUTER_EMU,
  EMERGENCY_NOTCH,
  MAX_BRAKE_NOTCH,
  MAX_POWER_NOTCH,
  TrainPhysics,
} from '../train/TrainPhysics';
import { CameraRig, CAMERA_LABELS } from './CameraRig';
import { Journey, stopPositionFor } from './Journey';
import { AutoDriver } from './AutoDriver';
import { Hud } from '../ui/Hud';
import { Menu } from '../ui/Menu';
import { getLanguage, setLanguage, t } from '../ui/i18n';
import { AudioEngine } from '../audio/AudioEngine';
import { generateRouteName, generateService, type RouteName, type ServiceInfo } from '../world/Names';

/**
 * The game.
 *
 * Owns the simulation and wires the systems together: input drives the train,
 * the train drives the world stream and the camera, and the sky drives the
 * light that everything is seen by.
 */

const WEATHER_PRESETS = [
  { key: 'weather.clear', cloudCover: 0.18, rain: 0, wind: 2.4 },
  { key: 'weather.fair', cloudCover: 0.42, rain: 0, wind: 3.6 },
  { key: 'weather.overcast', cloudCover: 0.85, rain: 0, wind: 5.2 },
  { key: 'weather.rain', cloudCover: 0.95, rain: 0.75, wind: 7.5 },
];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export class Game {
  private readonly engine: Engine;
  private readonly input: Input;
  private readonly hud: Hud;
  private readonly menu: Menu;
  private readonly audio = new AudioEngine();

  private settings: GameSettings;
  private seed: number;

  private world!: World;
  private sky!: SkySystem;
  private rain!: Rain;
  private train!: TrainPhysics;
  private consist!: Consist;
  private traffic!: Traffic;
  private camera!: CameraRig;
  private journey!: Journey;
  private auto!: AutoDriver;
  private route!: RouteName;
  private service!: ServiceInfo;

  private running = false;
  private paused = false;
  private started = false;
  private elapsed = 0;
  private mileageOffset = 0;
  private weatherIndex = 0;
  private tunnelFactor = 0;
  private headlights = false;
  private wiperPhase = 0;
  private crossingActive = false;
  private debugVisible = false;
  private readonly baseDate = new Date();
  private readonly cameraPos = new Vector3();
  private readonly trainVelocity = new Vector3();
  private readonly zenith = new Color(0.075, 0.215, 0.585);
  /** Start hour forced by the URL, or null for a random departure time. */
  private readonly forcedStartHour: number | null;

  constructor(canvas: HTMLCanvasElement, container: HTMLElement) {
    this.settings = loadSettings();
    // ?seed= and ?time= make a route reproducible, which is how you share one.
    const params = new URLSearchParams(location.search);
    const seedParam = Number(params.get('seed'));
    this.seed = Number.isFinite(seedParam) && params.has('seed')
      ? seedParam >>> 0
      : (Math.random() * 0xffffffff) >>> 0;
    const timeParam = Number(params.get('time'));
    this.forcedStartHour = params.has('time') && Number.isFinite(timeParam) ? timeParam : null;

    setLanguage(this.settings.language);

    this.engine = new Engine(canvas, this.settings);
    this.input = new Input(canvas);
    this.hud = new Hud(container);
    this.menu = new Menu(container, this.settings, {
      onStart: () => this.beginDriving(),
      onResume: () => this.resume(),
      onRestart: (seed) => this.restart(seed),
      onSettingsChanged: (settings) => this.applySettings(settings),
    });

    this.hud.addTransport(
      () => (this.started ? this.resume() : this.beginDriving()),
      () => this.pause(),
    );

    textures.setAnisotropy(this.engine.profile.anisotropy);
    this.build();

    this.engine.onUpdate((dt) => this.update(dt));
    this.engine.onRender((dt, elapsed) => this.render(dt, elapsed));
    this.engine.start();
    this.menu.showTitle(String(this.seed));
  }

  // --- construction --------------------------------------------------------

  private build(): void {
    const profile = QUALITY_PROFILES[this.settings.quality];
    const rng = new Rng(this.seed ^ 0x5117);
    const startTime =
      this.forcedStartHour !== null
        ? this.forcedStartHour * 3600
        : 6 * 3600 + rng.range(0, 14 * 3600);

    this.sky = new SkySystem(this.engine.scene, profile.viewDistance);
    this.sky.timeOfDay = startTime;
    this.sky.timeScale = 1;
    this.sky.configureShadows(profile.shadowMapSize, profile.shadowDistance);
    this.applyWeather();

    this.world = new World(this.seed, startTime, profile);
    this.engine.scene.add(this.world.group);

    this.rain = new Rain();
    this.engine.scene.add(this.rain.points);

    this.route = generateRouteName(rng, this.world.track.biomeAt(0));
    this.mileageOffset = rng.int(4, 180) * 1000 + rng.int(0, 900);

    this.train = new TrainPhysics(COMMUTER_EMU);
    this.train.position = 160;
    this.train.applyFullBrake();

    const destination = this.world.track.stations[Math.min(4, this.world.track.stations.length - 1)];
    this.service = generateService(
      rng,
      destination ? destination.name : { ja: '終点', ro: 'Terminus' },
    );

    this.consist = new Consist(this.world.track, {
      spec: COMMUTER_EMU,
      road: -1,
      direction: 1,
      bodyColor: 0xd8dde2,
      accentColor: 0x1d6fb8,
      destination: this.service.destination.ja,
      withCab: true,
    });
    this.consist.update(this.train.position);
    this.engine.scene.add(this.consist.group);

    this.traffic = new Traffic(this.world.track, this.seed);
    this.engine.scene.add(this.traffic.group);

    this.camera = new CameraRig(this.world.track, this.world.field);
    this.camera.shake = this.settings.shake;

    this.journey = new Journey(this.world.track, startTime);
    this.auto = new AutoDriver(this.world.track, this.journey);
    this.sky.updateEnvironment(this.engine.renderer, true);

    // Prime the world so the first frame is already populated.
    this.consist.update(this.train.position);
    this.consist.cars[0].group.updateMatrixWorld(true);
    this.consist.getEyeWorld(this.cameraPos);
    for (let i = 0; i < 8; i++) {
      this.world.update(this.train.position, this.cameraPos, 60);
    }
    this.world.tiles.processQueue(220);
  }

  private teardown(): void {
    this.engine.scene.remove(this.world.group);
    this.engine.scene.remove(this.consist.group);
    this.engine.scene.remove(this.traffic.group);
    this.engine.scene.remove(this.rain.points);
    this.world.dispose();
    this.consist.dispose();
    this.traffic.dispose();
    this.rain.dispose();
    this.engine.scene.remove(this.sky.sun);
    this.engine.scene.remove(this.sky.moon);
  }

  restart(seed?: number): void {
    this.seed = seed ?? ((Math.random() * 0xffffffff) >>> 0);
    this.teardown();
    this.engine.scene.clear();
    this.elapsed = 0;
    this.started = false;
    this.running = false;
    this.paused = false;
    this.build();
    this.menu.showTitle(String(this.seed));
  }

  private applySettings(settings: GameSettings): void {
    this.settings = settings;
    setLanguage(settings.language);
    saveSettings(settings);
    this.engine.applySettings(settings);
    this.camera.shake = settings.shake;
    this.audio.setVolume(settings.masterVolume);
    const profile = QUALITY_PROFILES[settings.quality];
    this.sky.configureShadows(profile.shadowMapSize, profile.shadowDistance);
    this.world.setProfile(profile);
    this.menu.updateSettings(settings);
  }

  // --- transport -----------------------------------------------------------

  private beginDriving(): void {
    void this.audio.start().then(() => this.audio.setVolume(this.settings.masterVolume));
    this.started = true;
    this.running = true;
    this.paused = false;
    this.menu.hide();
    this.hud.showMessage(t('msg.depart'), 3);
  }

  pause(): void {
    if (!this.started) return;
    this.paused = true;
    this.running = false;
    this.audio.setMuted(true);
    this.menu.showPaused();
  }

  resume(): void {
    if (!this.started) {
      this.beginDriving();
      return;
    }
    this.paused = false;
    this.running = true;
    this.audio.setMuted(false);
    this.menu.hide();
  }

  // --- simulation ----------------------------------------------------------

  private update(dt: number): void {
    this.handleInput();
    if (!this.running) return;

    this.elapsed += dt;

    const track = this.world.track;
    const sample = track.sampleAt(this.train.position);
    const radius = Math.abs(sample.curvature) > 1e-6 ? 1 / Math.abs(sample.curvature) : Infinity;

    this.auto.update(dt, this.train, this.sky.timeOfDay);

    // Doors open: the train is held.
    if (this.journey.heldAtPlatform) {
      this.train.setPower(0);
      if (this.train.brakeNotch < 5) this.train.setBrake(MAX_BRAKE_NOTCH);
    }

    const before = this.train.position;
    this.train.update(dt, { grade: sample.grade, radius });
    const travelled = this.train.position - before;

    const limit = track.limitAt(this.train.position);
    this.journey.update(dt, this.elapsed, this.train, limit, (key, seconds, suffix) => {
      this.hud.showMessage(t(key) + (suffix ?? ''), seconds);
      if (key === 'msg.doorsClosing') this.audio.doorAir();
    });

    if (this.journey.phase === 'arrived' && this.journey.doorProgress < 0.05) {
      this.audio.doorChime();
    }

    this.traffic.update(this.train.position, dt);
    if (this.traffic.passEvent > 0) this.audio.passingTrain(this.traffic.passEvent);

    this.world.updateSignals(this.train.position, this.traffic.positions());
    this.crossingActive = this.world.updateCrossings(
      this.train.position,
      Math.abs(this.train.speed),
      dt,
      this.elapsed,
    );

    // Tunnels: darkness, sound and headlights.
    const inTunnel = sample.structure === STRUCT_TUNNEL ? 1 : 0;
    this.tunnelFactor = damp(this.tunnelFactor, inTunnel, 3.2, dt);

    this.consist.update(this.train.position);
    this.consist.setHandlePositions(
      this.train.powerNotch / MAX_POWER_NOTCH,
      Math.min(this.train.brakeNotch, MAX_BRAKE_NOTCH) / MAX_BRAKE_NOTCH,
    );

    // Wipers when it is raining.
    const rainLevel = this.sky.weather.rain;
    if (rainLevel > 0.05) {
      this.wiperPhase += dt * (1.1 + rainLevel);
      this.consist.setWiper(Math.abs(Math.sin(this.wiperPhase)) * 1.15);
    } else {
      this.consist.setWiper(0);
    }

    this.audio.update(dt, {
      speed: this.train.speed,
      distance: Math.abs(travelled),
      traction: this.train.tractionOutput,
      brake: this.train.brakeOutput,
      tunnel: this.tunnelFactor,
      rain: rainLevel,
      sea: sample.weights[BIOME_INDEX.coast],
      town: sample.weights[BIOME_INDEX.city] + sample.weights[BIOME_INDEX.suburb] * 0.6,
      crossing: this.crossingActive,
      doorsOpen: this.journey.doorsOpen,
    });
  }

  private handleInput(): void {
    const input = this.input;

    if (input.wasPressed('KeyP') || input.wasPressed('Escape')) {
      if (this.paused || !this.started) this.resume();
      else this.pause();
    }
    if (input.wasPressed('F3')) this.debugVisible = !this.debugVisible;
    if (input.wasPressed('KeyJ')) this.toggleLanguage();
    if (input.wasPressed('KeyU')) this.toggleInterface();

    if (!this.running) {
      input.endFrame();
      return;
    }

    const shift = input.isDown('ShiftLeft') || input.isDown('ShiftRight');

    // Master controller: Z or / notch up, A or : notch down. The two handles
    // are independent, so the brake never drags the controller with it.
    // Loops rather than single checks, so a quick double tap moves two notches
    // even if both land in the same frame.
    while (input.wasPressed('KeyZ') || input.wasPressed('Slash')) {
      this.driveManually();
      this.train.setPower(this.train.powerNotch + 1);
    }
    while (input.wasPressed('KeyA') || input.wasPressed('Quote')) {
      this.driveManually();
      this.train.setPower(this.train.powerNotch - 1);
    }

    // Brake: . applies a step, , releases one.
    while (input.wasPressed('Period')) {
      this.driveManually();
      this.train.setBrake(Math.min(this.train.brakeNotch + 1, MAX_BRAKE_NOTCH));
    }
    while (input.wasPressed('Comma')) {
      this.driveManually();
      this.train.setBrake(Math.max(0, this.train.brakeNotch - 1));
    }

    // Emergency: Q or @.
    if (input.wasPressed('KeyQ') || input.wasPressed('BracketLeft')) {
      this.driveManually();
      this.train.setBrake(EMERGENCY_NOTCH);
    }

    // Reverser, which only moves at a stand.
    while (input.wasPressed('ArrowUp')) {
      if (!this.train.moveReverser(1)) this.hud.showMessage(t('msg.reverserStop'), 1.6);
    }
    while (input.wasPressed('ArrowDown')) {
      if (!this.train.moveReverser(-1)) this.hud.showMessage(t('msg.reverserStop'), 1.6);
    }

    // Horn: Enter for the low note, Shift+Enter for the high one.
    this.audio.setHorn(input.isDown('Enter'), shift);

    if (input.wasPressed('KeyC')) {
      if (shift && this.camera.mode === 'window') this.camera.flipWindowSide();
      else this.camera.cycle();
      this.hud.showMessage(t(CAMERA_LABELS[this.camera.mode]), 1.2);
    }
    if (input.wasPressed('KeyF')) {
      this.auto.enabled = !this.auto.enabled;
      this.hud.showMessage(t(this.auto.enabled ? 'msg.autoOn' : 'msg.autoOff'), 1.8);
    }
    if (input.wasPressed('KeyB')) this.skipToNextBiome();
    if (input.wasPressed('KeyL')) {
      this.headlights = !this.headlights;
      this.hud.showMessage(t(this.headlights ? 'msg.headlightsOn' : 'msg.headlightsOff'), 1.2);
    }
    if (input.wasPressed('KeyT')) {
      const step = 45 * 60;
      this.sky.timeOfDay = (this.sky.timeOfDay + step) % 86400;
      this.world.track.shiftSchedule(step);
      this.elapsed -= step;
    }
    if (input.wasPressed('KeyW')) {
      this.weatherIndex = (this.weatherIndex + 1) % WEATHER_PRESETS.length;
      this.applyWeather();
      this.hud.showMessage(t(WEATHER_PRESETS[this.weatherIndex].key), 1.6);
    }

    this.camera.look(input.lookYaw, input.lookPitch);
    input.endFrame();
  }

  /** Any manual handle movement drops the train out of automatic driving. */
  private driveManually(): void {
    if (!this.auto.enabled) return;
    this.auto.enabled = false;
    this.hud.showMessage(t('msg.autoOff'), 1.5);
  }

  private toggleLanguage(): void {
    const next = getLanguage() === 'ja' ? 'en' : 'ja';
    setLanguage(next);
    this.applySettings({ ...this.settings, language: next });
  }

  private toggleInterface(): void {
    const visible = !this.hud.isVisible;
    this.hud.setVisible(visible);
    if (!visible) console.info(t('msg.uiHidden'));
  }

  /**
   * Runs the train forward to wherever the landscape next changes character,
   * carrying the timetable with it so the service is still running to time
   * when it gets there.
   */
  private skipToNextBiome(): void {
    const track = this.world.track;
    const from = this.train.position;
    const target = track.findNextBiomeChange(from);
    if (target === null) return;

    // Everything skipped counts as worked, and the timetable moves with us.
    for (const station of track.stations) if (station.s < target - 60) station.served = true;
    const averageSpeed = 70 / MS_TO_KMH;
    track.shiftSchedule((target - from) / averageSpeed);

    this.train.position = target;
    this.train.speed = 0;
    this.train.applyFullBrake();
    this.journey.resetTo(target);
    this.hud.showMessage(
      `${t('msg.skipping')} ${t(`biome.${track.biomeAt(target)}`)}`,
      2.5,
    );
  }

  private applyWeather(): void {
    const preset = WEATHER_PRESETS[this.weatherIndex];
    this.sky.setWeather({
      cloudCover: preset.cloudCover,
      rain: preset.rain,
      wind: preset.wind,
      windDirection: 0.7,
    });
  }

  // --- rendering -----------------------------------------------------------

  private render(dt: number, elapsed: number): void {
    const track = this.world.track;
    const sample = track.sampleAt(this.train.position);

    this.camera.update(
      this.engine.camera,
      this.consist,
      this.train.speed,
      dt,
      elapsed,
      this.train.position,
    );
    this.engine.camera.getWorldPosition(this.cameraPos);

    const haze = this.world.hazeAt(this.train.position) * lerp(1, 1.5, this.tunnelFactor);
    this.sky.update(dt, this.cameraPos, haze, elapsed);
    this.sky.tickEnvironment(this.engine.renderer, dt);

    const darkness = Math.max(this.sky.nightFactor, this.tunnelFactor * 0.85);
    const wantHeadlights = this.headlights || darkness > 0.35;
    this.consist.setLighting(darkness, wantHeadlights);
    this.traffic.setLighting(darkness, wantHeadlights);
    this.world.updateNightLighting(darkness);

    // The world streams around the camera, not the train, so looking backwards
    // from a rear view still has scenery.
    this.world.update(this.train.position, this.cameraPos, this.engine.profile.buildBudgetMs);

    this.world.water.update(
      elapsed,
      this.sky.sunDirection,
      this.sky.sun.color,
      this.sky.horizon,
      this.zenith,
      darkness,
    );

    updateWind(
      elapsed,
      Math.cos(this.sky.weather.windDirection),
      Math.sin(this.sky.weather.windDirection),
      0.4 + this.sky.weather.wind * 0.09,
    );

    this.trainVelocity
      .set(Math.cos(sample.heading), 0, Math.sin(sample.heading))
      .multiplyScalar(this.train.speed);
    this.rain.intensity = this.sky.weather.rain * (1 - this.tunnelFactor);
    this.rain.update(dt, this.cameraPos, this.trainVelocity, lerp(0.4, 1, 1 - darkness));

    this.engine.setGrade(
      this.sky.glare * (1 - this.tunnelFactor),
      this.sky.weather.rain * 0.8,
    );

    this.updateHud(dt);
  }

  private updateHud(dt: number): void {
    const track = this.world.track;
    const station = this.journey.nextStation(this.train.position);
    const distanceToStop = station ? stopPositionFor(station) - this.train.position : Infinity;
    const limit = track.limitAt(this.train.position);
    const previous = this.previousStationS(station?.s ?? this.train.position);
    const span = Math.max(1, (station?.s ?? this.train.position + 1) - previous);
    const progress = clamp01((this.train.position - previous) / span);

    const timeOfDay = this.sky.timeOfDay;
    const day = new Date(this.baseDate.getTime());
    const label = `${MONTHS[day.getMonth()]} ${day.getDate()}, ${day.getFullYear()}`;

    const stations = track.stationsAhead(this.train.position - 1200, 8);
    const routeSpan = Math.max(1200, (stations[stations.length - 1]?.s ?? this.train.position) - this.train.position + 1400);

    this.hud.update(dt, {
      nextStation: station,
      distanceToStation: station ? station.s - this.train.position : Infinity,
      stationProgress: progress,
      score: this.journey.score,
      delay: this.journey.delay,
      speed: Math.abs(this.train.speedKmh),
      limit,
      milepost: formatMilepost(this.mileageOffset + this.train.position),
      routeTitle: `${this.route.operator} ${this.route.line}`,
      serviceLine: `${this.service.kind} #${this.service.number}`,
      operator: this.route.operator.replace('JR ', 'JR'),
      serviceBadge: this.service.kind,
      stations,
      position: this.train.position,
      routeSpan,
      powerNotch: this.train.powerNotch,
      brakeNotch: this.train.brakeNotch,
      reverser: this.train.reverser,
      autoDriving: this.auto.enabled,
      brakePressure: clamp(this.train.brakeOutput, 0, 1),
      distanceToStop,
      timeOfDay,
      dateLabel: label,
      assistTarget: this.auto.enabled
        ? this.auto.target
        : this.journey.recommendedSpeed(this.train, distanceToStop, limit),
      assistEnabled: this.settings.assist,
      doorsOpen: this.journey.doorsOpen,
      dwellLeft: this.journey.dwellLeft,
    });

    this.hud.setDebug(
      [
        `${this.engine.fps.toFixed(0)} fps  ${this.engine.frameMs.toFixed(1)} ms`,
        `draws ${this.engine.drawCalls}  tris ${(this.engine.triangles / 1000).toFixed(0)}k`,
        `chunks ${this.world.chunkCount}  tiles ${this.world.tiles.tileCount} (+${this.world.tiles.pendingCount})`,
        `biome ${track.biomeAt(this.train.position)}  seed ${this.seed}`,
        `quality ${this.settings.quality}  post ${this.engine.postProcessing}`,
        `s ${this.train.position.toFixed(0)} m  a ${this.train.acceleration.toFixed(2)} m/s²`,
      ],
      this.debugVisible,
    );
  }

  private previousStationS(nextS: number): number {
    let previous = 0;
    for (const station of this.world.track.stations) {
      if (station.s >= nextS) break;
      previous = station.s;
    }
    return previous;
  }

  /** Speed shown on the HUD, exposed for tests and debugging. */
  get speedKmh(): number {
    return this.train.speed * MS_TO_KMH;
  }

  get smoothing(): number {
    return smoothstep(0, 1, this.tunnelFactor);
  }
}
