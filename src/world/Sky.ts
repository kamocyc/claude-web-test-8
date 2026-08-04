import {
  AmbientLight,
  BackSide,
  Color,
  DirectionalLight,
  FogExp2,
  HemisphereLight,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';
import { SKY_MAPPING_GLSL } from './sky/AtmosphereGlsl';
import { SkyLuts } from './sky/SkyLuts';
import { CloudLayer } from './sky/CloudLayer';
import { NIGHT_GLSL } from './sky/NightGlsl';
import { aerialUniforms, installAerialPerspective } from './sky/AerialPerspective';

/**
 * Sky, atmosphere and natural light.
 *
 * The sky is a physically based scattering model - Rayleigh, Mie and ozone on
 * a spherical planet - baked into small look-up tables at run time, with a
 * raymarched volumetric cloud layer over it and a real star field and moon
 * behind. Everything else in the frame is lit from it: the sun's colour is the
 * atmosphere's transmittance along the sun ray, the ambient is a prefiltered
 * environment map of this same sky, and every distant surface is blended into
 * the sky radiance in its own direction so the horizon has no seam.
 */

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_Position.z = gl_Position.w; // force to the far plane
  }
`;

const skyFragment = /* glsl */ `
  precision highp float;

  uniform sampler2D uSkyView;
  uniform vec2 uSkyViewTexel;
  uniform sampler2D uClouds;

  uniform vec3 uSunDir;
  uniform vec3 uMoonDir;
  uniform vec3 uSunTint;
  uniform vec3 uSunDisc;
  uniform vec3 uMoonTint;
  uniform vec3 uGalacticPole;
  uniform float uTime;
  uniform float uStars;
  uniform float uSunRadius;
  uniform float uMoonRadius;
  uniform float uCloudFade;
  uniform float uGroundFade;

  varying vec3 vDir;

  ${SKY_MAPPING_GLSL}
  ${NIGHT_GLSL}

  vec2 octEncode(vec3 d) {
    vec3 n = d / max(abs(d.x) + abs(d.y) + abs(d.z), 1e-5);
    return vec2(n.x + n.z, n.x - n.z) * 0.5 + 0.5;
  }

  void main() {
    vec3 dir = normalize(vDir);
    vec3 sky = skyRadiance(uSkyView, uSkyViewTexel, dir, uSunDir, uSunTint);

    // How bright the air already is decides whether anything behind it shows.
    float skyLuma = dot(sky, vec3(0.2126, 0.7152, 0.0722));
    float behind = exp(-skyLuma * 26.0);

    if (behind > 0.004) {
      float galacticDensity = 0.0;
      vec3 night = milkyWay(dir, uGalacticPole, galacticDensity) * 0.055;
      vec2 uvFace;
      float face;
      cubeFace(dir, uvFace, face);
      night += starLayer(uvFace, face, 30.0, 0.10, 1.0, uTime, galacticDensity);
      night += starLayer(uvFace, face, 88.0, 0.13, 0.75, uTime * 0.7, galacticDensity) * 0.60;
      night += starLayer(uvFace, face, 230.0, 0.11, 0.55, uTime * 1.3, galacticDensity) * 0.34;
      sky += night * uStars * behind;
    }

    // The moon: its own place in the sky, lit by the real sun direction.
    float moonMask;
    sky += moonDisc(dir, uMoonDir, uSunDir, uMoonRadius, moonMask) * uMoonTint * behind;

    // The solar disc at its true angular size, with limb darkening.
    float sc = dot(dir, uSunDir);
    if (sc > 0.9) {
      float ang = length(dir - uSunDir * sc);
      float x = ang / uSunRadius;
      if (x < 1.35) {
        float mu = sqrt(max(0.0, 1.0 - min(x * x, 1.0)));
        float limb = 1.0 - 0.47 * (1.0 - mu) - 0.23 * (1.0 - mu * mu);
        sky += uSunDisc * limb * smoothstep(1.02, 0.94, x);
      }
    }

    // Clouds, composited over everything that is further away than they are.
    if (dir.y > -0.03) {
      vec4 cl = texture2D(uClouds, octEncode(vec3(dir.x, max(dir.y, 0.0), dir.z)));
      float fade = uCloudFade * smoothstep(-0.03, 0.02, dir.y);
      float t = mix(1.0, cl.a, fade);
      sky = sky * t + cl.rgb * fade;
    }

    // Below the horizon the dome is only ever seen past the edge of the land;
    // dropping it towards the ground haze keeps that join invisible.
    sky *= mix(1.0, uGroundFade, smoothstep(0.0, -0.16, dir.y));

    gl_FragColor = vec4(sky, 1.0);
  }
`;

export interface WeatherState {
  /** 0 = clear, 1 = overcast. */
  cloudCover: number;
  /** 0 = dry, 1 = heavy rain. */
  rain: number;
  /** Wind speed in m/s, drives foliage sway and cloud drift. */
  wind: number;
  windDirection: number;
  /** 0 = clear air, 1 = thick fog bank. */
  fog?: number;
  /** 0 = rain, 1 = snow, for the same precipitation rate. */
  snow?: number;
  /** Aerosol load: 1 crisp winter air, 6 summer murk. */
  turbidity?: number;
}

interface ResolvedWeather {
  cloudCover: number;
  rain: number;
  wind: number;
  windDirection: number;
  fog: number;
  snow: number;
  turbidity: number;
}

const DEG = Math.PI / 180;
/** Roughly Kanto; the sun path and the length of the day follow from it. */
const LATITUDE = 35.7 * DEG;
const AXIAL_TILT = 23.44 * DEG;

const RAYLEIGH = [5.802e-3, 13.558e-3, 33.1e-3];
const MIE_SCATTER = 3.996e-3;
const MIE_ABSORB = 4.4e-3;
const OZONE = [0.65e-3, 1.881e-3, 0.085e-3];
const GROUND_RADIUS_KM = 6360;
const ATMO_RADIUS_KM = 6460;

/** Transmittance of the atmosphere along a ray, evaluated on the CPU. */
function transmittance(out: Color, heightKm: number, mu: number, turbidity: number): void {
  const r = GROUND_RADIUS_KM + Math.max(heightKm, 0);
  const b = r * mu;
  const disc = b * b - (r * r - ATMO_RADIUS_KM * ATMO_RADIUS_KM);
  const tMax = disc > 0 ? -b + Math.sqrt(disc) : 0;
  // A ray that dips into the planet never gets out: the sun is below the
  // horizon and none of its light reaches the observer directly.
  const groundDisc = b * b - (r * r - GROUND_RADIUS_KM * GROUND_RADIUS_KM);
  if (mu < 0 && groundDisc > 0 && -b - Math.sqrt(groundDisc) > 0) {
    out.setRGB(0, 0, 0);
    return;
  }

  const steps = 24;
  const dt = tMax / steps;
  let odR = 0;
  let odM = 0;
  let odO = 0;
  for (let i = 0; i < steps; i++) {
    const t = dt * (i + 0.5);
    const h = Math.sqrt(r * r + t * t + 2 * r * t * mu) - GROUND_RADIUS_KM;
    odR += Math.exp(-Math.max(h, 0) / 8) * dt;
    odM += Math.exp(-Math.max(h, 0) / 1.2) * turbidity * dt;
    odO += Math.max(0, 1 - Math.abs(h - 25) / 15) * dt;
  }
  out.setRGB(
    Math.exp(-(RAYLEIGH[0] * odR + (MIE_SCATTER + MIE_ABSORB) * odM + OZONE[0] * odO)),
    Math.exp(-(RAYLEIGH[1] * odR + (MIE_SCATTER + MIE_ABSORB) * odM + OZONE[1] * odO)),
    Math.exp(-(RAYLEIGH[2] * odR + (MIE_SCATTER + MIE_ABSORB) * odM + OZONE[2] * odO)),
  );
}

/** The cloudscape each weather state should produce. */
function cloudLook(w: ResolvedWeather): {
  type: number;
  bottom: number;
  top: number;
  density: number;
  absorption: number;
  detail: number;
  cirrus: number;
} {
  const storm = clamp01(w.rain * 1.2);
  const overcast = smoothstep(0.6, 0.95, w.cloudCover);
  // Fair weather cumulus lift and shrink as the sky clears; an overcast sky
  // drops to a flat sheet just above the hills; rain brings it lower still and
  // turns it into something with a lot of water in it.
  const type = lerp(lerp(1, 0.25, overcast), 0.55, storm);
  const bottom = lerp(lerp(1500, 780, overcast), 460, storm) + w.fog * -200;
  const top = lerp(lerp(2900, 1750, overcast), 4200, storm);
  return {
    type,
    bottom,
    top,
    density: lerp(1, 1.5, overcast) * lerp(1, 1.5, storm),
    absorption: lerp(1, 1.35, overcast) * lerp(1, 1.6, storm),
    detail: lerp(0.34, 0.2, overcast),
    cirrus: lerp(0.55, 0.0, smoothstep(0.25, 0.7, w.cloudCover)),
  };
}

export class SkySystem {
  readonly sun = new DirectionalLight(0xffffff, 3);
  readonly moon = new DirectionalLight(0x9fb4ff, 0.0);
  readonly hemi = new HemisphereLight(0x9fc4ff, 0x4a4433, 0.6);
  readonly ambient = new AmbientLight(0xffffff, 0.12);
  readonly sunDirection = new Vector3(0.4, 0.5, 0.3).normalize();
  readonly moonDirection = new Vector3(-0.4, 0.5, -0.3).normalize();

  private readonly dome: Mesh;
  private readonly envDome: Mesh;
  private readonly envScene = new Scene();
  private pmrem: PMREMGenerator | null = null;
  private envTarget: WebGLRenderTarget | null = null;
  private envTimer = 0;
  private envSunY = -99;
  private readonly material: ShaderMaterial;
  private readonly fog: FogExp2;
  private readonly horizonColor = new Color();
  private readonly zenithColor = new Color(0.075, 0.215, 0.585);

  private readonly luts = new SkyLuts();
  private readonly clouds: CloudLayer;

  private readonly sunTransmittance = new Color(1, 1, 1);
  private readonly sunTint = new Vector3(1, 1, 1);
  private readonly keyDirection = new Vector3(0, 1, 0);
  private readonly keyColor = new Vector3(1, 1, 1);
  private readonly groundBounce = new Vector3(0.05, 0.05, 0.05);
  private readonly scratch = new Color();
  private cloudShadow = 0;
  private cameraY = 0;

  /** Time of day in seconds since midnight. */
  timeOfDay = 16 * 3600 + 42 * 60;
  /** Simulated day length multiplier; 1 = real time. */
  timeScale = 60;
  /**
   * Day of the year, which sets the sun's declination and so the length of the
   * day. Late September: an even day, a sun that sets around six, and the low
   * autumn light Japanese railway photography is built on.
   */
  dayOfYear = 268;
  /** Lunar phase, 0 new .. 0.5 full .. 1 new. */
  moonPhase = 0.42;

  weather: ResolvedWeather = {
    cloudCover: 0.35,
    rain: 0,
    wind: 3.5,
    windDirection: 0.8,
    fog: 0,
    snow: 0,
    turbidity: 2.2,
  };

  private target: ResolvedWeather = { ...this.weather };

  constructor(private readonly scene: Scene, viewDistance: number, quality = 'high') {
    installAerialPerspective();
    this.clouds = new CloudLayer(quality);

    this.material = new ShaderMaterial({
      uniforms: {
        uSkyView: { value: this.luts.skyView.texture },
        uSkyViewTexel: { value: this.luts.skyViewTexel },
        uClouds: { value: this.clouds.texture },
        uSunDir: { value: this.sunDirection },
        uMoonDir: { value: this.moonDirection },
        uSunTint: { value: this.sunTint },
        uSunDisc: { value: new Vector3(20, 20, 20) },
        uMoonTint: { value: new Vector3(1, 1, 1) },
        uGalacticPole: { value: new Vector3(0.42, 0.62, -0.66).normalize() },
        uTime: { value: 0 },
        uStars: { value: 0 },
        uSunRadius: { value: 0.00465 },
        uMoonRadius: { value: 0.0068 },
        uCloudFade: { value: 1 },
        uGroundFade: { value: 0.6 },
      },
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });

    const domeGeometry = new SphereGeometry(1, 32, 24);
    this.dome = new Mesh(domeGeometry, this.material);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    this.dome.scale.setScalar(Math.max(2000, viewDistance * 1.4));
    scene.add(this.dome);

    // A second dome in its own scene, used to bake the environment map that
    // lights every metal, glass and painted surface in the world.
    this.envDome = new Mesh(domeGeometry, this.material);
    this.envDome.scale.setScalar(500);
    this.envScene.add(this.envDome);

    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.06;
    scene.add(this.sun);
    scene.add(this.sun.target);
    scene.add(this.moon);
    scene.add(this.moon.target);
    scene.add(this.hemi);
    scene.add(this.ambient);

    this.fog = new FogExp2(0x9fb6cc, 0.00016);
    scene.fog = this.fog;

    aerialUniforms.uAerialSkyLut.value = this.luts.skyView.texture;
    (aerialUniforms.uAerialSkyTexel.value as Vector2).copy(this.luts.skyViewTexel);
    (aerialUniforms.uAerialSunDir.value as Vector3).copy(this.sunDirection);

    this.computeSun();
    this.applyLighting(0);
  }

  /**
   * Bakes the sky into a prefiltered environment map. Without it, metals and
   * clear-coated paint render black; with it, the whole scene picks up the
   * colour of the sky it is standing under.
   */
  updateEnvironment(renderer: WebGLRenderer, force = false): void {
    if (!this.pmrem) {
      this.pmrem = new PMREMGenerator(renderer);
      this.pmrem.compileEquirectangularShader();
    }
    if (force) this.bake(renderer, true);
    if (!force && Math.abs(this.sunDirection.y - this.envSunY) < 0.015) return;
    this.envSunY = this.sunDirection.y;
    const previous = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.03, 1, 2000);
    this.scene.environment = this.envTarget.texture;
    previous?.dispose();
  }

  /** Refreshes the environment at most every `seconds`. */
  tickEnvironment(renderer: WebGLRenderer, dt: number, seconds = 4): void {
    this.envTimer -= dt;
    if (this.envTimer > 0) return;
    this.envTimer = seconds;
    this.updateEnvironment(renderer);
  }

  configureShadows(mapSize: number, distance: number): void {
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    const cam = this.sun.shadow.camera;
    cam.left = -distance;
    cam.right = distance;
    cam.top = distance;
    cam.bottom = -distance;
    cam.near = 1;
    cam.far = distance * 4.5;
    cam.updateProjectionMatrix();
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  /** Sun elevation in the range [-1, 1] (sine of the altitude angle). */
  get sunElevation(): number {
    return this.sunDirection.y;
  }

  /** Lens glare strength for the post pass. */
  get glare(): number {
    const low = smoothstep(0.4, 0.02, Math.abs(this.sunDirection.y));
    const clear = 1 - this.cloudShadow * 0.85;
    return clamp01(low * clear * (1 - this.weather.cloudCover * 0.55)) * 0.9;
  }

  /** True when artificial lighting should be on. */
  get isDark(): boolean {
    return this.sunDirection.y < 0.04;
  }

  get nightFactor(): number {
    return 1 - smoothstep(-0.08, 0.10, this.sunDirection.y);
  }

  /** Zenith colour, for water and glass tinting. */
  get zenith(): Color {
    return this.zenithColor;
  }

  setWeather(weather: Partial<WeatherState>): void {
    this.target = {
      ...this.target,
      ...weather,
      fog: weather.fog ?? (weather.cloudCover !== undefined ? 0 : this.target.fog),
      snow: weather.snow ?? (weather.cloudCover !== undefined ? 0 : this.target.snow),
      turbidity:
        weather.turbidity ??
        (weather.cloudCover !== undefined
          ? lerp(1.6, 4.2, weather.cloudCover ?? 0) + (weather.rain ?? 0) * 1.5
          : this.target.turbidity),
    };
  }

  /** Immediately snaps to the target weather, for scenario setup. */
  settleWeather(): void {
    this.weather = { ...this.target };
  }

  // --- astronomy -------------------------------------------------------------

  private computeSun(): void {
    const dayAngle = ((this.dayOfYear + 284) / 365.25) * Math.PI * 2;
    const declination = Math.asin(Math.sin(AXIAL_TILT) * Math.sin(dayAngle));
    const hourAngle = (this.timeOfDay / 3600 - 12) * 15 * DEG;
    this.placeBody(this.sunDirection, declination, hourAngle);

    // The moon lags the sun by a full turn over a lunation, so a full moon sits
    // opposite the sun and rises as it sets, and a crescent hugs the twilight.
    const moonHour = hourAngle - this.moonPhase * Math.PI * 2;
    const moonLongitude = dayAngle + this.moonPhase * Math.PI * 2;
    const moonDec = Math.asin(Math.sin(AXIAL_TILT * 0.92) * Math.sin(moonLongitude));
    this.placeBody(this.moonDirection, moonDec, moonHour);
  }

  private placeBody(out: Vector3, declination: number, hourAngle: number): void {
    const sinAlt =
      Math.sin(LATITUDE) * Math.sin(declination) +
      Math.cos(LATITUDE) * Math.cos(declination) * Math.cos(hourAngle);
    const alt = Math.asin(clamp(sinAlt, -1, 1));
    const cosAlt = Math.cos(alt);
    let azimuth = Math.PI;
    if (cosAlt > 1e-4) {
      const cosAz = clamp(
        (Math.sin(declination) - Math.sin(LATITUDE) * sinAlt) / (Math.cos(LATITUDE) * cosAlt),
        -1,
        1,
      );
      azimuth = Math.acos(cosAz);
      if (Math.sin(hourAngle) > 0) azimuth = Math.PI * 2 - azimuth;
    }
    // Azimuth is measured from north through east; the world's +X is east.
    out.set(Math.sin(azimuth) * cosAlt, Math.sin(alt), -Math.cos(azimuth) * cosAlt).normalize();
  }

  // --- per frame -------------------------------------------------------------

  private bake(renderer: WebGLRenderer, force = false): void {
    const w = this.weather;
    this.luts.update(
      renderer,
      this.sunDirection,
      w.turbidity,
      0.15,
      Math.max(this.cameraY, 0) * 0.001,
      force,
    );
    const look = cloudLook(w);
    Object.assign(this.clouds.settings, look, { coverage: w.cloudCover });

    // After sunset the deck is lit by the moon instead, which is a thousand
    // times weaker and comes from somewhere else entirely.
    const night = this.nightFactor;
    const illum = 0.5 - 0.5 * Math.cos(this.moonPhase * Math.PI * 2);
    const moonUp = smoothstep(-0.05, 0.12, this.moonDirection.y);
    this.keyDirection.copy(this.sunDirection).lerp(this.moonDirection, night).normalize();
    this.keyColor
      .set(this.sunTransmittance.r, this.sunTransmittance.g, this.sunTransmittance.b)
      .multiplyScalar(9 * (1 - night));
    this.keyColor.x += 0.030 * night * illum * moonUp;
    this.keyColor.y += 0.036 * night * illum * moonUp;
    this.keyColor.z += 0.052 * night * illum * moonUp;

    this.clouds.setEnvironment(
      this.luts.skyView,
      this.luts.skyViewTexel,
      this.sunDirection,
      this.keyDirection,
      this.keyColor,
      this.sunTint,
      this.groundBounce,
      this.cameraY,
      night,
    );
    this.clouds.render(renderer, force);
  }

  update(
    renderer: WebGLRenderer,
    dt: number,
    cameraPos: Vector3,
    biomeHaze: number,
    elapsed: number,
  ): void {
    this.timeOfDay = (this.timeOfDay + dt * this.timeScale) % 86400;
    this.cameraY = cameraPos.y;

    // Weather crossfades rather than snapping; a front takes a few seconds to
    // come through instead of appearing between one frame and the next.
    const k = 1 - Math.exp(-dt * 0.28);
    const w = this.weather;
    const t = this.target;
    w.cloudCover = lerp(w.cloudCover, t.cloudCover, k);
    w.rain = lerp(w.rain, t.rain, k);
    w.wind = lerp(w.wind, t.wind, k);
    w.windDirection = lerp(w.windDirection, t.windDirection, k);
    w.fog = lerp(w.fog, t.fog, k);
    w.snow = lerp(w.snow, t.snow, k);
    w.turbidity = lerp(w.turbidity, t.turbidity, k);

    this.computeSun();
    this.clouds.setWeather(
      dt,
      Math.cos(w.windDirection),
      Math.sin(w.windDirection),
      1 + w.wind * 0.35,
    );
    this.cloudShadow = this.clouds.sunOcclusion(cameraPos.x, cameraPos.z, this.sunDirection);

    this.applyLighting(elapsed);
    this.bake(renderer);

    this.dome.position.copy(cameraPos);
    this.sun.position.copy(cameraPos).addScaledVector(this.sunDirection, 260);
    this.sun.target.position.copy(cameraPos);
    this.sun.target.updateMatrixWorld();
    this.moon.position.copy(cameraPos).addScaledVector(this.moonDirection, 260);
    this.moon.target.position.copy(cameraPos);
    this.moon.target.updateMatrixWorld();

    this.updateAerial(biomeHaze);
  }

  private applyLighting(elapsed: number): void {
    const w = this.weather;
    const e = this.sunDirection.y;
    const day = smoothstep(-0.08, 0.16, e);
    const dusk = Math.exp(-Math.pow((e - 0.02) / 0.12, 2));
    const night = this.nightFactor;

    transmittance(this.sunTransmittance, Math.max(this.cameraY, 0) * 0.001, e, w.turbidity);
    const lum =
      this.sunTransmittance.r * 0.2126 +
      this.sunTransmittance.g * 0.7152 +
      this.sunTransmittance.b * 0.0722;

    const maxComponent = Math.max(
      this.sunTransmittance.r,
      Math.max(this.sunTransmittance.g, this.sunTransmittance.b),
      1e-4,
    );
    this.sunTint.set(
      this.sunTransmittance.r / maxComponent,
      this.sunTransmittance.g / maxComponent,
      this.sunTransmittance.b / maxComponent,
    );

    // A cumulus drifting across the sun dims and cools the whole landscape.
    const cloudBlock = clamp01(
      Math.max(this.cloudShadow * 0.55, smoothstep(0.55, 0.98, w.cloudCover)),
    );
    const sunThrough = lerp(1, 0.12, cloudBlock) * lerp(1, 0.5, w.fog);
    const above = smoothstep(-0.03, 0.10, e);

    this.sun.intensity = 6.2 * Math.pow(lum, 0.55) * above * sunThrough;
    this.sun.color.setRGB(
      this.sunTransmittance.r / Math.max(lum, 1e-4),
      this.sunTransmittance.g / Math.max(lum, 1e-4),
      this.sunTransmittance.b / Math.max(lum, 1e-4),
    );

    // Moon light, with the phase actually controlling how much there is.
    const illum = 0.5 - 0.5 * Math.cos(this.moonPhase * Math.PI * 2);
    this.moon.intensity =
      night * 0.30 * illum * smoothstep(-0.04, 0.12, this.moonDirection.y) * lerp(1, 0.25, cloudBlock);
    this.moon.color.setRGB(0.55, 0.63, 0.9);

    // Sky bounce. The environment map carries most of the indirect light, so
    // this is a gentle fill that keeps shadows readable.
    const overcast = w.cloudCover;
    this.hemi.intensity = lerp(0.05, 0.26, day) * lerp(1, 2.1, overcast) + night * 0.03;
    this.hemi.color.setRGB(
      lerp(0.05, 0.48, day) + dusk * 0.30,
      lerp(0.07, 0.66, day) + dusk * 0.12,
      lerp(0.16, 1.0, day),
    );
    this.hemi.groundColor.setRGB(
      lerp(0.03, 0.26, day),
      lerp(0.03, 0.24, day),
      lerp(0.04, 0.19, day),
    );
    this.ambient.intensity = lerp(0.03, 0.06, day) + overcast * 0.04;

    // Colours other systems read: the horizon for fog and water, the zenith
    // for glass. Both follow the transmittance rather than a fixed palette.
    const zenithDay = new Color(0.10, 0.24, 0.62);
    const nightSky = new Color(0.012, 0.02, 0.05);
    this.zenithColor.copy(nightSky).lerp(zenithDay, day);
    this.scratch.setRGB(
      this.sunTransmittance.r,
      this.sunTransmittance.g * 0.85,
      this.sunTransmittance.b * 0.7,
    );
    const horizonDay = new Color(0.60, 0.72, 0.88);
    this.horizonColor.copy(nightSky).lerp(horizonDay, day);
    this.horizonColor.lerp(this.scratch, dusk * 0.7 * (1 - overcast * 0.4));
    if (overcast > 0) this.horizonColor.lerp(new Color(0.5, 0.53, 0.58), overcast * 0.5);

    this.groundBounce.set(
      this.horizonColor.r * 0.24,
      this.horizonColor.g * 0.23,
      this.horizonColor.b * 0.20,
    );

    // Environment intensity: image based lighting tracks the daylight.
    this.scene.environmentIntensity = lerp(0.16, 0.85, day) * lerp(1, 1.25, overcast) + dusk * 0.05;

    // Dome uniforms.
    const u = this.material.uniforms;
    u.uTime.value = elapsed;
    u.uStars.value = 1;
    (u.uSunDisc.value as Vector3).set(
      this.sunTransmittance.r,
      this.sunTransmittance.g,
      this.sunTransmittance.b,
    ).multiplyScalar(90);
    (u.uMoonTint.value as Vector3).set(1, 1, 1).multiplyScalar(lerp(0.35, 1, illum));
    u.uGroundFade.value = lerp(0.55, 0.8, overcast);
    u.uCloudFade.value = 1;
  }

  private updateAerial(biomeHaze: number): void {
    const w = this.weather;
    const haze = clamp(biomeHaze, 0.6, 1.6);
    // One number sets how far you can see: clean air, summer murk, a rain
    // squall and a valley fog bank are the same model at different densities.
    const density =
      (0.0003 + w.turbidity * 0.0001) * haze +
      w.rain * 0.00042 +
      w.fog * 0.0021 +
      w.snow * 0.0004;
    this.fog.density = density;
    this.fog.color.copy(this.horizonColor);

    aerialUniforms.uAerialSkyLut.value = this.luts.skyView.texture;
    (aerialUniforms.uAerialSkyTexel.value as Vector2).copy(this.luts.skyViewTexel);
    (aerialUniforms.uAerialSunDir.value as Vector3).copy(this.sunDirection);
    (aerialUniforms.uAerialSunTint.value as Vector3).copy(this.sunTint);
    aerialUniforms.uAerialCameraY.value = this.cameraY;
    // Fog banks hug the ground; clean air reaches much higher.
    aerialUniforms.uAerialHeightScale.value = lerp(1400, 220, clamp01(w.fog));
    aerialUniforms.uAerialStrength.value = 1;
    aerialUniforms.uAerialGround.value = lerp(0.55, 0.85, w.cloudCover);
    // Rain and fog wash the colour out of the haze.
    const grey = clamp01(w.rain * 0.5 + w.fog * 0.75);
    (aerialUniforms.uAerialTint.value as Vector3).set(
      lerp(1, 1.08, grey),
      lerp(1, 1.06, grey),
      lerp(1, 1.02, grey),
    );

    this.scene.background = null;
  }

  /** Colour of the ambient sky light, used to tint water and windows. */
  get horizon(): Color {
    return this.horizonColor;
  }

  /** How much of the sun a cloud is currently taking away, 0..1. */
  get sunOcclusion(): number {
    return this.cloudShadow;
  }

  dispose(): void {
    this.luts.dispose();
    this.clouds.dispose();
    this.material.dispose();
    this.dome.geometry.dispose();
    this.envTarget?.dispose();
    this.pmrem?.dispose();
  }
}
