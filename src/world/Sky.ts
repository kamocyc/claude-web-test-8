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
  Vector3,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';

/**
 * Sky, sun and atmosphere.
 *
 * An analytic sky dome (gradient + Mie sun glow + procedural cloud deck +
 * stars) drives the scene's directional and ambient light, the fog colour and
 * the lens glare, so a change of time of day or weather ripples through the
 * whole image consistently.
 */

const skyVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize((modelMatrix * vec4(position, 1.0)).xyz - cameraPosition);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_Position.z = gl_Position.w; // force to the far plane
  }
`;

const skyFragment = /* glsl */ `
  precision highp float;

  uniform vec3 uSunDir;
  uniform float uTime;
  uniform float uCloudCover;
  uniform float uCloudSpeed;
  uniform float uHaze;
  uniform float uExposure;
  uniform vec3 uWindDir;

  varying vec3 vDir;

  float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 5; i++) {
      v += a * valueNoise(p);
      p = rot * p * 2.02;
      a *= 0.5;
    }
    return v;
  }

  float starField(vec3 dir) {
    vec2 uv = dir.xz / max(abs(dir.y), 0.08) * 1.4;
    vec2 cell = floor(uv * 60.0);
    float r = hash(cell);
    if (r < 0.9955) return 0.0;
    vec2 local = fract(uv * 60.0) - 0.5;
    float d = length(local);
    float twinkle = 0.65 + 0.35 * sin(uTime * 2.1 + r * 90.0);
    return smoothstep(0.14, 0.0, d) * twinkle;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float elev = uSunDir.y;
    float up = clamp(dir.y, -1.0, 1.0);

    float day = smoothstep(-0.10, 0.18, elev);
    float night = 1.0 - smoothstep(-0.20, -0.02, elev);
    float dusk = exp(-pow((elev - 0.02) / 0.11, 2.0));

    vec3 zenithDay = vec3(0.075, 0.215, 0.585);
    vec3 horizonDay = vec3(0.62, 0.735, 0.885);
    vec3 zenithDusk = vec3(0.115, 0.135, 0.34);
    vec3 horizonDusk = vec3(1.15, 0.46, 0.22);
    vec3 zenithNight = vec3(0.008, 0.014, 0.036);
    vec3 horizonNight = vec3(0.035, 0.05, 0.085);

    vec3 zenith = mix(zenithNight, zenithDay, day);
    vec3 horizon = mix(horizonNight, horizonDay, day);
    zenith = mix(zenith, zenithDusk, dusk * 0.85);
    horizon = mix(horizon, horizonDusk, dusk * 0.9);

    float t = pow(clamp(1.0 - up, 0.0, 1.0), 3.2 - uHaze * 0.6);
    vec3 sky = mix(zenith, horizon, t);

    // Ground bounce below the horizon so the dome does not read as a hard edge.
    float below = smoothstep(0.0, -0.12, up);
    sky = mix(sky, mix(vec3(0.10, 0.11, 0.10), horizon * 0.55, 0.5), below);

    float sunDot = max(dot(dir, uSunDir), 0.0);

    // Mie forward scattering halo, stronger in hazy air and at low sun.
    float halo = pow(sunDot, 7.0) * (0.28 + uHaze * 0.35) + pow(sunDot, 2.0) * 0.06;
    vec3 sunTint = mix(vec3(1.0, 0.93, 0.82), vec3(1.35, 0.55, 0.24), dusk);
    sky += sunTint * halo * (0.35 + day * 0.9);

    // The solar disc itself, kept bright enough to bloom.
    float disc = smoothstep(0.99965, 0.99992, sunDot);
    sky += sunTint * disc * 22.0 * smoothstep(-0.06, 0.02, elev);

    // Moon.
    float moonDot = max(dot(dir, -uSunDir), 0.0);
    float moon = smoothstep(0.99975, 0.99994, moonDot);
    sky += vec3(0.85, 0.88, 1.0) * moon * 6.0 * night;
    sky += vec3(0.5, 0.55, 0.72) * pow(moonDot, 220.0) * 0.25 * night;

    sky += vec3(0.9, 0.94, 1.0) * starField(dir) * night * step(0.02, dir.y);

    // Cloud deck projected onto a plane above the observer.
    if (dir.y > 0.005) {
      vec2 cuv = dir.xz / dir.y;
      vec2 drift = uWindDir.xz * uTime * uCloudSpeed;
      float base = fbm(cuv * 0.055 + drift * 0.01);
      float detail = fbm(cuv * 0.18 + drift * 0.026 + base);
      float density = base * 0.75 + detail * 0.35;
      float coverage = mix(0.78, 0.24, uCloudCover);
      float cloud = smoothstep(coverage, coverage + 0.22, density);
      cloud *= smoothstep(0.005, 0.09, dir.y); // fade into the horizon haze

      // Shade the cloud by sampling the field towards the sun.
      vec2 lightUv = cuv * 0.055 + drift * 0.01 + uSunDir.xz * 0.35;
      float lit = smoothstep(coverage, coverage + 0.3, fbm(lightUv) * 0.75 + detail * 0.35);
      vec3 cloudLit = mix(vec3(1.0, 0.97, 0.93), sunTint * 1.25, dusk * 0.8) * (0.45 + day * 0.75);
      vec3 cloudDark = mix(vec3(0.16, 0.18, 0.22), vec3(0.30, 0.22, 0.24), dusk) * (0.35 + day * 0.8);
      vec3 cloudCol = mix(cloudLit, cloudDark, clamp(lit * 0.85, 0.0, 1.0));
      cloudCol += sunTint * pow(sunDot, 12.0) * 0.5 * (1.0 - lit);
      sky = mix(sky, cloudCol, cloud * 0.94);
    }

    gl_FragColor = vec4(sky * uExposure, 1.0);
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
}

export class SkySystem {
  readonly sun = new DirectionalLight(0xffffff, 3);
  readonly moon = new DirectionalLight(0x9fb4ff, 0.0);
  readonly hemi = new HemisphereLight(0x9fc4ff, 0x4a4433, 0.6);
  readonly ambient = new AmbientLight(0xffffff, 0.12);
  readonly sunDirection = new Vector3(0.4, 0.5, 0.3).normalize();

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

  /** Time of day in seconds since midnight. */
  timeOfDay = 16 * 3600 + 42 * 60;
  /** Simulated day length multiplier; 1 = real time. */
  timeScale = 60;

  weather: WeatherState = { cloudCover: 0.35, rain: 0, wind: 3.5, windDirection: 0.8 };

  /** Latitude-like tilt of the solar path. */
  private readonly declination = 0.32;

  constructor(private readonly scene: Scene, viewDistance: number) {
    this.material = new ShaderMaterial({
      uniforms: {
        uSunDir: { value: this.sunDirection },
        uTime: { value: 0 },
        uCloudCover: { value: this.weather.cloudCover },
        uCloudSpeed: { value: 1 },
        uHaze: { value: 1 },
        uExposure: { value: 1 },
        uWindDir: { value: new Vector3(1, 0, 0.3).normalize() },
      },
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      side: BackSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
    });

    const domeGeometry = new SphereGeometry(1, 48, 32);
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

    this.fog = new FogExp2(0x9fb6cc, 0.0011);
    scene.fog = this.fog;
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
    if (!force && Math.abs(this.sunDirection.y - this.envSunY) < 0.02) return;
    this.envSunY = this.sunDirection.y;
    const previous = this.envTarget;
    this.envTarget = this.pmrem.fromScene(this.envScene, 0.03, 1, 2000);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 1.0;
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
    const low = smoothstep(0.35, 0.02, Math.abs(this.sunDirection.y));
    return clamp01(low * (1 - this.weather.cloudCover * 0.8)) * 0.9;
  }

  /** True when artificial lighting should be on. */
  get isDark(): boolean {
    return this.sunDirection.y < 0.04;
  }

  get nightFactor(): number {
    return 1 - smoothstep(-0.08, 0.10, this.sunDirection.y);
  }

  setWeather(weather: Partial<WeatherState>): void {
    this.weather = { ...this.weather, ...weather };
  }

  update(dt: number, cameraPos: Vector3, biomeHaze: number, elapsed: number): void {
    this.timeOfDay = (this.timeOfDay + dt * this.timeScale) % 86400;

    // Solar position: a simple tilted circle, good enough for a rolling sky.
    const dayAngle = ((this.timeOfDay / 86400) * Math.PI * 2) - Math.PI / 2;
    const alt = Math.sin(dayAngle) * (1 - this.declination * 0.35) + this.declination * 0.12;
    const az = dayAngle * 0.55 + 0.9;
    const horiz = Math.sqrt(Math.max(0, 1 - alt * alt));
    this.sunDirection.set(Math.cos(az) * horiz, alt, Math.sin(az) * horiz).normalize();

    const e = this.sunDirection.y;
    const day = smoothstep(-0.08, 0.16, e);
    const dusk = Math.exp(-Math.pow((e - 0.02) / 0.12, 2));
    const night = this.nightFactor;
    const overcast = this.weather.cloudCover;

    // Sun light: warm and weak at the horizon, neutral and strong at noon.
    // Kept well above the sky bounce so shadows read as shadows.
    const sunIntensity = lerp(0.0, 5.4, smoothstep(-0.05, 0.28, e)) * lerp(1, 0.20, overcast);
    this.sun.intensity = sunIntensity;
    this.sun.color.setRGB(
      lerp(1.0, 1.0, day),
      lerp(0.56, 0.96, smoothstep(-0.02, 0.24, e)),
      lerp(0.26, 0.90, smoothstep(-0.02, 0.30, e)),
    );

    this.moon.intensity = night * 0.28 * lerp(1, 0.4, overcast);
    this.moon.color.setRGB(0.55, 0.63, 0.9);

    // Sky bounce. The prefiltered environment map already provides most of the
    // indirect light, so this is only a gentle fill.
    const hemiIntensity = lerp(0.04, 0.10, day) * lerp(1, 3.2, overcast) + night * 0.03;
    this.hemi.intensity = hemiIntensity;
    this.hemi.color.setRGB(
      lerp(0.05, 0.55, day) + dusk * 0.25,
      lerp(0.07, 0.72, day) + dusk * 0.10,
      lerp(0.16, 1.0, day),
    );
    this.hemi.groundColor.setRGB(
      lerp(0.03, 0.28, day),
      lerp(0.03, 0.26, day),
      lerp(0.04, 0.20, day),
    );
    this.ambient.intensity = lerp(0.02, 0.035, day) + overcast * 0.04;

    // Keep the sun rig centred on the camera so shadows follow the train.
    const dist = 260;
    this.sun.position.copy(cameraPos).addScaledVector(this.sunDirection, dist);
    this.sun.target.position.copy(cameraPos);
    this.sun.target.updateMatrixWorld();
    this.moon.position.copy(cameraPos).addScaledVector(this.sunDirection, -dist);
    this.moon.target.position.copy(cameraPos);
    this.moon.target.updateMatrixWorld();
    this.dome.position.copy(cameraPos);

    // Fog colour tracks the horizon so distant land dissolves into the sky.
    const dayFog = new Color(0.62, 0.735, 0.885);
    const duskFog = new Color(0.86, 0.52, 0.36);
    const nightFog = new Color(0.035, 0.05, 0.085);
    this.horizonColor.copy(nightFog).lerp(dayFog, day).lerp(duskFog, dusk * 0.75);
    if (overcast > 0) this.horizonColor.lerp(new Color(0.55, 0.58, 0.62), overcast * 0.55);
    this.fog.color.copy(this.horizonColor);
    this.scene.background = null;

    const rainHaze = this.weather.rain * 0.0016;
    this.fog.density = (0.00055 + overcast * 0.00035) * clamp(biomeHaze, 0.6, 1.6) + rainHaze;

    this.material.uniforms.uTime.value = elapsed;
    this.material.uniforms.uCloudCover.value = overcast;
    this.material.uniforms.uHaze.value = clamp(biomeHaze, 0.6, 1.6);
    this.material.uniforms.uCloudSpeed.value = 0.4 + this.weather.wind * 0.12;
    this.material.uniforms.uWindDir.value.set(
      Math.cos(this.weather.windDirection),
      0,
      Math.sin(this.weather.windDirection),
    );
    this.material.uniforms.uExposure.value = lerp(0.9, 1.0, day);
    // Image based lighting carries the ambient term, so it tracks the daylight.
    this.scene.environmentIntensity = lerp(0.10, 0.46, day) * lerp(1, 1.5, overcast) + dusk * 0.08;
  }

  /** Colour of the ambient sky light, used to tint water and windows. */
  get horizon(): Color {
    return this.horizonColor;
  }
}
