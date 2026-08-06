import { Color, Group, Matrix4, MeshBasicMaterial, SpotLight, Vector3 } from 'three';
import { createCab, createCar, WIPER_PARK, type CabModel, type CarModel } from './TrainModel';
import { trackAxes } from '../world/TrackFrame';
import { TRACK_SPACING, type TrackPath } from '../world/TrackPath';
import type { TrainSpec } from './TrainPhysics';
import { clamp01, smoothstep } from '../core/MathUtils';

/**
 * A train: a rake of cars placed on the track from their bogie centres, so the
 * consist swings through curves the way a real one does.
 */

export interface ConsistOptions {
  spec: TrainSpec;
  /** -1 for the left hand road (the player), +1 for the opposite road. */
  road: number;
  /** +1 travelling with increasing chainage, -1 against it. */
  direction: number;
  bodyColor: number;
  accentColor: number;
  destination?: string;
  withCab: boolean;
}

const frontPos = new Vector3();
const rearPos = new Vector3();
const forward = new Vector3();
const right = new Vector3();
const up = new Vector3();
const axisRight = new Vector3();
const axisUp = new Vector3();
const axisFwd = new Vector3();
const back = new Vector3();
const matrix = new Matrix4();

export class Consist {
  readonly group = new Group();
  readonly cars: CarModel[] = [];
  readonly cab: CabModel | null = null;
  readonly lateral: number;
  readonly direction: number;
  readonly spec: TrainSpec;

  private readonly headlight: SpotLight | null = null;
  private headlightsOn = false;

  constructor(
    private readonly track: TrackPath,
    private readonly options: ConsistOptions,
  ) {
    this.spec = options.spec;
    this.lateral = (options.road * TRACK_SPACING) / 2;
    this.direction = options.direction;
    this.group.name = 'consist';

    for (let i = 0; i < options.spec.cars; i++) {
      const isCab = i === 0 || i === options.spec.cars - 1;
      const car = createCar({
        isCab,
        reversed: i === options.spec.cars - 1,
        bodyColor: options.bodyColor,
        accentColor: options.accentColor,
        hasPantograph: i === 1 || i === options.spec.cars - 2,
        destination: i === 0 ? options.destination : undefined,
        length: options.spec.carLength,
      });
      this.cars.push(car);
      this.group.add(car.group);
    }

    if (options.withCab) {
      this.cab = createCab(options.spec.carLength);
      this.cars[0].group.add(this.cab.group);

      this.headlight = new SpotLight(0xfff0d8, 0, 260, 0.42, 0.55, 1.2);
      this.headlight.position.set(0, 1.5, -(options.spec.carLength / 2));
      this.headlight.target.position.set(0, 0.4, -(options.spec.carLength / 2) - 60);
      this.cars[0].group.add(this.headlight);
      this.cars[0].group.add(this.headlight.target);
    }
  }

  /** Places every car from the chainage of the leading cab. */
  update(frontS: number): void {
    const spec = this.spec;
    const dir = this.direction;
    const halfBogie = spec.carLength / 2 - 3.0;

    for (let i = 0; i < this.cars.length; i++) {
      const centreS = frontS - dir * spec.carLength * (i + 0.5);
      const sFront = centreS + dir * halfBogie;
      const sRear = centreS - dir * halfBogie;

      this.sampleTrack(sFront, frontPos);
      this.sampleTrack(sRear, rearPos);

      forward.subVectors(frontPos, rearPos).normalize();
      const mid = this.track.sampleAt(centreS);
      trackAxes(mid, axisRight, axisUp, axisFwd);
      up.copy(axisUp);
      right.crossVectors(forward, up).normalize();
      up.crossVectors(right, forward).normalize();
      back.copy(forward).negate();

      matrix.makeBasis(right, up, back);
      const car = this.cars[i].group;
      car.position.copy(frontPos).add(rearPos).multiplyScalar(0.5);
      car.quaternion.setFromRotationMatrix(matrix);
      car.updateMatrix();
    }
  }

  private sampleTrack(s: number, out: Vector3): void {
    const sample = this.track.sampleAt(s);
    trackAxes(sample, axisRight, axisUp, axisFwd);
    out
      .set(sample.x, sample.y, sample.z)
      .addScaledVector(axisRight, this.lateral)
      .addScaledVector(axisUp, 0);
  }

  /**
   * Head, tail and saloon lighting. `ambient` is 0 in daylight and 1 in the
   * dark; tunnels push it up regardless of the time of day.
   */
  setLighting(darkness: number, headlights: boolean): void {
    this.headlightsOn = headlights;
    const glow = clamp01(darkness);
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const leading = i === 0;
      for (const lamp of car.headlights) {
        const material = lamp.material as MeshBasicMaterial;
        const on = leading && headlights;
        material.color.setRGB(on ? 2.6 : 0.32, on ? 2.5 : 0.32, on ? 2.2 : 0.3);
      }
      for (const lamp of car.taillights) {
        const material = lamp.material as MeshBasicMaterial;
        const on = !leading && headlights;
        material.color.setRGB(on ? 2.4 : 0.16, on ? 0.1 : 0.03, on ? 0.08 : 0.03);
      }
      for (const light of car.interiorLights) {
        const material = light.material as MeshBasicMaterial;
        const level = smoothstep(0.1, 0.6, glow) * 0.9;
        material.color.setRGB(level * 1.1, level * 1.05, level * 0.9);
      }
    }
    if (this.headlight) {
      this.headlight.intensity = headlights ? 220 * clamp01(0.35 + glow) : 0;
    }
  }

  get isHeadlightOn(): boolean {
    return this.headlightsOn;
  }

  /** World position of the driver's eye, for the cab camera. */
  getEyeWorld(out = new Vector3()): Vector3 {
    if (!this.cab) return out.copy(this.cars[0].group.position);
    return out.copy(this.cab.eyePosition).applyMatrix4(this.cars[0].group.matrixWorld);
  }

  setHandlePositions(powerFraction: number, brakeFraction: number): void {
    if (!this.cab) return;
    // Japanese practice: the master controller is pulled back towards the
    // driver to take power, and the brake handle is pulled back to apply.
    this.cab.masterHandle.rotation.x = 0.6 * powerFraction;
    this.cab.brakeHandle.rotation.x = 0.55 * brakeFraction;
  }

  setWiper(angle: number): void {
    if (!this.cab) return;
    this.cab.wiper.rotation.z = WIPER_PARK + angle;
  }

  dispose(): void {
    this.group.traverse((obj) => {
      const mesh = obj as {
        geometry?: { dispose(): void };
        material?: { dispose(): void };
        userData: Record<string, unknown>;
      };
      if (mesh.userData?.ownsGeometry && mesh.geometry) mesh.geometry.dispose();
      if (mesh.userData?.ownsMaterial && mesh.material) mesh.material.dispose();
    });
    this.group.clear();
  }

  get colorAccent(): Color {
    return new Color(this.options.accentColor);
  }
}
