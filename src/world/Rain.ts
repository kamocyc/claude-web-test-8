import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three';

/**
 * Rain.
 *
 * A block of streaks that follows the camera and wraps around it, sheared by
 * the train's own speed so the drops slant past the windscreen the faster you
 * go. Cheap, and it changes the mood of the whole scene.
 */
export class Rain {
  readonly points: Points;
  private readonly material: ShaderMaterial;
  private readonly count = 5000;
  private readonly extent = 34;
  private readonly velocities: Float32Array;
  private readonly positions: Float32Array;

  intensity = 0;

  constructor() {
    this.positions = new Float32Array(this.count * 3);
    this.velocities = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) {
      this.positions[i * 3] = (Math.random() - 0.5) * this.extent * 2;
      this.positions[i * 3 + 1] = Math.random() * this.extent * 1.4;
      this.positions[i * 3 + 2] = (Math.random() - 0.5) * this.extent * 2;
      this.velocities[i] = 14 + Math.random() * 10;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    geometry.setAttribute('aSpeed', new BufferAttribute(this.velocities, 1));

    this.material = new ShaderMaterial({
      uniforms: {
        uOpacity: { value: 0 },
        uShear: { value: new Vector3() },
        uLight: { value: 1 },
      },
      vertexShader: /* glsl */ `
        attribute float aSpeed;
        uniform vec3 uShear;
        varying float vFade;
        void main() {
          vec3 pos = position;
          vec4 mv = modelViewMatrix * vec4(pos, 1.0);
          gl_Position = projectionMatrix * mv;
          // Longer streaks for faster drops and higher train speed.
          gl_PointSize = clamp(220.0 / max(-mv.z, 1.0), 1.0, 9.0) * (0.6 + aSpeed * 0.03 + length(uShear) * 0.02);
          vFade = clamp(1.0 - (-mv.z) / 40.0, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uOpacity;
        uniform float uLight;
        varying float vFade;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          // Vertical streak rather than a round dot.
          float a = smoothstep(0.5, 0.0, abs(d.x) * 5.0) * smoothstep(0.5, 0.0, abs(d.y));
          gl_FragColor = vec4(vec3(0.75, 0.82, 0.9) * uLight, a * uOpacity * vFade);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.points = new Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
    this.points.visible = false;
    this.points.name = 'rain';
  }

  update(dt: number, cameraPosition: Vector3, trainVelocity: Vector3, light: number): void {
    this.points.visible = this.intensity > 0.01;
    if (!this.points.visible) return;

    this.material.uniforms.uOpacity.value = Math.min(1, this.intensity) * 0.55;
    this.material.uniforms.uLight.value = light;
    (this.material.uniforms.uShear.value as Vector3).copy(trainVelocity);

    this.points.position.copy(cameraPosition);

    const fall = dt;
    const driftX = -trainVelocity.x * dt * 0.35;
    const driftZ = -trainVelocity.z * dt * 0.35;
    for (let i = 0; i < this.count; i++) {
      const idx = i * 3;
      this.positions[idx] += driftX;
      this.positions[idx + 1] -= this.velocities[i] * fall;
      this.positions[idx + 2] += driftZ;

      if (this.positions[idx + 1] < -this.extent * 0.5) {
        this.positions[idx] = (Math.random() - 0.5) * this.extent * 2;
        this.positions[idx + 1] = this.extent * 1.4;
        this.positions[idx + 2] = (Math.random() - 0.5) * this.extent * 2;
      }
      if (Math.abs(this.positions[idx]) > this.extent) {
        this.positions[idx] -= Math.sign(this.positions[idx]) * this.extent * 2;
      }
      if (Math.abs(this.positions[idx + 2]) > this.extent) {
        this.positions[idx + 2] -= Math.sign(this.positions[idx + 2]) * this.extent * 2;
      }
    }
    (this.points.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
