import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  ShaderMaterial,
  Vector3,
} from 'three';

/**
 * Precipitation.
 *
 * Three things happen when it rains, and the old point-sprite block only did
 * the first badly:
 *
 *   streaks   drops stretched along the direction they are actually moving,
 *             which is the fall speed combined with the wind and the train's
 *             own motion, so they slant harder the faster you are going;
 *   splashes  rings bursting off the ballast and the platform, which is what
 *             tells you the rain is hitting something rather than hanging in
 *             the air;
 *   snow      the same drops slowed to a drift, unstretched, and given a sway,
 *             because a snowfall is a different weather, not white rain.
 *
 * Everything is instanced off one quad and driven from a handful of uniforms.
 */

const STREAK_VERTEX = /* glsl */ `
  precision mediump float;
  attribute vec3 aOffset;
  attribute float aSpeed;
  attribute float aSeed;

  uniform vec3 uVelocity;
  uniform float uLength;
  uniform float uWidth;
  uniform float uSnow;
  uniform float uTime;

  varying vec2 vQuad;
  varying float vFade;
  varying float vSeed;

  void main() {
    vec3 world = aOffset;
    // Snow does not fall straight: it wanders on the way down.
    if (uSnow > 0.001) {
      float t = uTime * (0.5 + aSeed);
      world.x += sin(t * 1.7 + aSeed * 30.0) * 0.55 * uSnow;
      world.z += cos(t * 1.3 + aSeed * 17.0) * 0.55 * uSnow;
    }

    vec4 mv = modelViewMatrix * vec4(world, 1.0);

    // The apparent path of a drop is its fall plus the wind plus whatever the
    // train is doing, projected onto the screen.
    vec3 vel = uVelocity - vec3(0.0, aSpeed, 0.0);
    vec3 velView = (viewMatrix * vec4(vel, 0.0)).xyz;
    vec2 axis = length(velView.xy) > 1e-4 ? normalize(velView.xy) : vec2(0.0, -1.0);
    vec2 perp = vec2(-axis.y, axis.x);

    float len = mix(uLength * (0.5 + aSpeed * 0.05), uWidth * 1.6, uSnow);
    float wide = uWidth * mix(1.0, 2.6 + aSeed * 1.5, uSnow);
    mv.xy += axis * (position.y * len) + perp * (position.x * wide);

    gl_Position = projectionMatrix * mv;
    vQuad = position.xy * 2.0;
    // Fade in at the far edge of the block so drops do not pop into being.
    float d = -mv.z;
    vFade = smoothstep(1.2, 3.0, d) * (1.0 - smoothstep(24.0, 38.0, d));
    vSeed = aSeed;
  }
`;

const STREAK_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform float uOpacity;
  uniform vec3 uColor;
  uniform float uSnow;
  varying vec2 vQuad;
  varying float vFade;
  varying float vSeed;

  void main() {
    // A streak is a thin bright core with soft shoulders; a flake is a disc.
    float across = 1.0 - abs(vQuad.x);
    float along = 1.0 - abs(vQuad.y);
    float streak = smoothstep(0.0, 0.85, across) * smoothstep(0.0, 0.35, along);
    float flake = smoothstep(1.0, 0.15, length(vQuad));
    float a = mix(streak, flake, uSnow);
    a *= uOpacity * vFade * (0.55 + fract(vSeed * 7.31) * 0.75);
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

const SPLASH_VERTEX = /* glsl */ `
  precision mediump float;
  attribute vec3 aOffset;
  attribute float aSeed;

  uniform float uTime;
  uniform float uRate;
  uniform float uGroundY;

  varying float vLife;
  varying vec2 vQuad;

  void main() {
    // Each site fires on its own clock, so the ballast fizzes rather than
    // pulsing in time.
    float period = mix(1.6, 0.42, uRate);
    float life = fract(uTime / period + aSeed);
    vLife = life;

    float radius = 0.05 + life * 0.22;
    vec3 world = vec3(aOffset.x, uGroundY + 0.02, aOffset.z);
    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    // The ring lies flat on the ground, so it is built in world axes and only
    // then taken into view space.
    vec3 right = (viewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz;
    vec3 fwd = (viewMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz;
    mv.xyz += right * (position.x * radius * 2.0) + fwd * (position.y * radius * 2.0);

    gl_Position = projectionMatrix * mv;
    vQuad = position.xy * 2.0;
  }
`;

const SPLASH_FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform float uOpacity;
  uniform vec3 uColor;
  varying float vLife;
  varying vec2 vQuad;

  void main() {
    float r = length(vQuad);
    // An expanding ring that thins as it goes.
    float ring = smoothstep(1.0, 0.80, r) * smoothstep(0.48, 0.78, r);
    float a = ring * uOpacity * (1.0 - vLife) * smoothstep(0.0, 0.12, vLife);
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

function instancedQuad(count: number): InstancedBufferGeometry {
  const quad = new PlaneGeometry(1, 1);
  const geometry = new InstancedBufferGeometry();
  geometry.index = quad.index;
  geometry.setAttribute('position', quad.getAttribute('position'));
  geometry.instanceCount = count;
  quad.dispose();
  return geometry;
}

export class Rain {
  readonly points = new Group();

  private readonly streakCount = 4200;
  private readonly splashCount = 420;
  private readonly extent = 30;

  private readonly streakMaterial: ShaderMaterial;
  private readonly splashMaterial: ShaderMaterial;
  private readonly streaks: Mesh;
  private readonly splashes: Mesh;
  private readonly positions: Float32Array;
  private readonly speeds: Float32Array;
  private readonly splashPositions: Float32Array;
  private readonly velocity = new Vector3();
  private readonly colour = new Color();

  intensity = 0;
  /** 0 = rain, 1 = snow. */
  snow = 0;

  constructor() {
    this.positions = new Float32Array(this.streakCount * 3);
    this.speeds = new Float32Array(this.streakCount);
    const seeds = new Float32Array(this.streakCount);
    for (let i = 0; i < this.streakCount; i++) {
      this.positions[i * 3] = (Math.random() - 0.5) * this.extent * 2;
      this.positions[i * 3 + 1] = Math.random() * this.extent * 1.3;
      this.positions[i * 3 + 2] = (Math.random() - 0.5) * this.extent * 2;
      this.speeds[i] = 15 + Math.random() * 11;
      seeds[i] = Math.random();
    }

    const streakGeometry = instancedQuad(this.streakCount);
    streakGeometry.setAttribute('aOffset', new InstancedBufferAttribute(this.positions, 3));
    streakGeometry.setAttribute('aSpeed', new InstancedBufferAttribute(this.speeds, 1));
    streakGeometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 1));

    this.streakMaterial = new ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
        uColor: { value: new Vector3(0.78, 0.84, 0.95) },
        uVelocity: { value: new Vector3() },
        uLength: { value: 0.55 },
        uWidth: { value: 0.016 },
        uSnow: { value: 0 },
        uTime: { value: 0 },
      },
      vertexShader: STREAK_VERTEX,
      fragmentShader: STREAK_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // The screen-space billboard build flips the quad's winding, so the
      // default front-face cull would throw every drop away.
      side: DoubleSide,
      blending: AdditiveBlending,
    });

    this.streaks = new Mesh(streakGeometry, this.streakMaterial);
    this.streaks.frustumCulled = false;
    this.streaks.renderOrder = 20;

    this.splashPositions = new Float32Array(this.splashCount * 3);
    const splashSeeds = new Float32Array(this.splashCount);
    for (let i = 0; i < this.splashCount; i++) {
      // Biased towards the near ground, where the ballast actually shows.
      const r = Math.sqrt(Math.random()) * 17;
      const a = Math.random() * Math.PI * 2;
      this.splashPositions[i * 3] = Math.cos(a) * r;
      this.splashPositions[i * 3 + 2] = Math.sin(a) * r;
      splashSeeds[i] = Math.random();
    }
    const splashGeometry = instancedQuad(this.splashCount);
    splashGeometry.setAttribute('aOffset', new InstancedBufferAttribute(this.splashPositions, 3));
    splashGeometry.setAttribute('aSeed', new InstancedBufferAttribute(splashSeeds, 1));

    this.splashMaterial = new ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
        uColor: { value: new Vector3(0.75, 0.82, 0.92) },
        uTime: { value: 0 },
        uRate: { value: 0 },
        uGroundY: { value: 0 },
      },
      vertexShader: SPLASH_VERTEX,
      fragmentShader: SPLASH_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: NormalBlending,
    });

    this.splashes = new Mesh(splashGeometry, this.splashMaterial);
    this.splashes.frustumCulled = false;
    this.splashes.renderOrder = 19;

    this.points.add(this.streaks);
    this.points.add(this.splashes);
    this.points.visible = false;
    this.points.name = 'rain';
  }

  update(
    dt: number,
    cameraPosition: Vector3,
    trainVelocity: Vector3,
    light: number,
    groundY = cameraPosition.y - 2.6,
    wind = new Vector3(),
    elapsed = 0,
  ): void {
    this.points.visible = this.intensity > 0.01;
    if (!this.points.visible) return;

    const snow = this.snow;
    const strength = Math.min(1, this.intensity);
    this.streakMaterial.uniforms.uOpacity.value = strength * (snow > 0.5 ? 0.9 : 0.85);
    this.streakMaterial.uniforms.uSnow.value = snow;
    this.streakMaterial.uniforms.uTime.value = elapsed;
    this.streakMaterial.uniforms.uLength.value = snow > 0.5 ? 0.12 : 0.75 + strength * 0.6;
    this.streakMaterial.uniforms.uWidth.value = snow > 0.5 ? 0.05 : 0.055;
    this.colour.setRGB(0.78, 0.84, 0.95).multiplyScalar(Math.max(light, 0.15) * 1.7);
    (this.streakMaterial.uniforms.uColor.value as Vector3).set(
      this.colour.r,
      this.colour.g,
      this.colour.b,
    );

    // The wind blows the whole column sideways; the train's motion shears it.
    this.velocity.copy(wind).sub(trainVelocity);
    (this.streakMaterial.uniforms.uVelocity.value as Vector3).copy(this.velocity);

    this.splashMaterial.uniforms.uOpacity.value = strength * (1 - snow) * 0.5 * Math.max(light, 0.2);
    this.splashMaterial.uniforms.uRate.value = strength;
    this.splashMaterial.uniforms.uTime.value = elapsed;
    this.splashMaterial.uniforms.uGroundY.value = groundY - cameraPosition.y;
    (this.splashMaterial.uniforms.uColor.value as Vector3).set(
      this.colour.r * 1.15,
      this.colour.g * 1.15,
      this.colour.b * 1.2,
    );

    this.points.position.copy(cameraPosition);

    const fall = dt * (snow > 0.5 ? 0.16 : 1);
    const driftX = (this.velocity.x - trainVelocity.x * 0.35) * dt;
    const driftZ = (this.velocity.z - trainVelocity.z * 0.35) * dt;
    const extent = this.extent;
    for (let i = 0; i < this.streakCount; i++) {
      const idx = i * 3;
      this.positions[idx] += driftX;
      this.positions[idx + 1] -= this.speeds[i] * fall;
      this.positions[idx + 2] += driftZ;

      if (this.positions[idx + 1] < -extent * 0.5) {
        this.positions[idx] = (Math.random() - 0.5) * extent * 2;
        this.positions[idx + 1] = extent * 1.3;
        this.positions[idx + 2] = (Math.random() - 0.5) * extent * 2;
      }
      if (Math.abs(this.positions[idx]) > extent) {
        this.positions[idx] -= Math.sign(this.positions[idx]) * extent * 2;
      }
      if (Math.abs(this.positions[idx + 2]) > extent) {
        this.positions[idx + 2] -= Math.sign(this.positions[idx + 2]) * extent * 2;
      }
    }
    (this.streaks.geometry.getAttribute('aOffset') as BufferAttribute).needsUpdate = true;

    // Splash sites are anchored to the ground, so they stream past with it.
    const sdx = -trainVelocity.x * dt;
    const sdz = -trainVelocity.z * dt;
    for (let i = 0; i < this.splashCount; i++) {
      const idx = i * 3;
      this.splashPositions[idx] += sdx;
      this.splashPositions[idx + 2] += sdz;
      if (Math.abs(this.splashPositions[idx]) > 18) {
        this.splashPositions[idx] -= Math.sign(this.splashPositions[idx]) * 36;
      }
      if (Math.abs(this.splashPositions[idx + 2]) > 18) {
        this.splashPositions[idx + 2] -= Math.sign(this.splashPositions[idx + 2]) * 36;
      }
    }
    (this.splashes.geometry.getAttribute('aOffset') as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.streaks.geometry.dispose();
    this.splashes.geometry.dispose();
    this.streakMaterial.dispose();
    this.splashMaterial.dispose();
  }
}
