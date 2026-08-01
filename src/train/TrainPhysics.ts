import { clamp, damp, GRAVITY, KMH, MS_TO_KMH, moveTowards } from '../core/MathUtils';

/**
 * Longitudinal dynamics of an electric multiple unit.
 *
 * Notched power and brake handles, a tractive effort curve that rolls off with
 * speed, Davis running resistance, gradient and curve resistance, and a brake
 * system with realistic build-up and release delays. The result is a train
 * that has to be driven: you brake for a curve long before you reach it and
 * you feel the difference between a 25 permille climb and a level run.
 */

export const MAX_POWER_NOTCH = 5;
export const MAX_BRAKE_NOTCH = 8;
export const EMERGENCY_NOTCH = 9;

export interface TrainSpec {
  cars: number;
  /** Tare mass per car in kilograms. */
  massPerCar: number;
  /** Length of one car over couplers, metres. */
  carLength: number;
  /** Maximum tractive effort at rail, newtons. */
  maxTractiveEffort: number;
  /** Speed up to which full effort is available, m/s. */
  baseSpeed: number;
  /** Speed above which effort falls off faster, m/s. */
  fieldWeakeningSpeed: number;
  /** Deceleration at full service brake, m/s^2. */
  serviceBrake: number;
  /** Deceleration in emergency, m/s^2. */
  emergencyBrake: number;
  /** Maximum design speed, km/h. */
  maxSpeed: number;
}

export const COMMUTER_EMU: TrainSpec = {
  cars: 4,
  massPerCar: 35000,
  carLength: 20,
  maxTractiveEffort: 132000,
  baseSpeed: 11,
  fieldWeakeningSpeed: 26,
  serviceBrake: 1.15,
  emergencyBrake: 1.45,
  maxSpeed: 120,
};

export interface TrackForces {
  /** dy/ds at the train's position. */
  grade: number;
  /** Curve radius in metres (Infinity on straight track). */
  radius: number;
}

export class TrainPhysics {
  readonly spec: TrainSpec;

  /** Chainage of the front of the train, metres. */
  position = 0;
  /** Speed along the track, m/s. Always non-negative in normal service. */
  speed = 0;
  /** Longitudinal acceleration, m/s^2. */
  acceleration = 0;

  powerNotch = 0;
  brakeNotch = 0;
  /** 1 forward, 0 neutral, -1 reverse. */
  reverser = 1;

  /** Smoothed traction demand, 0..1 - the motors take a moment to respond. */
  tractionOutput = 0;
  /** Brake cylinder pressure as a fraction of maximum, 0..1. */
  brakeOutput = 0;
  /** Main reservoir pressure in kPa, shown on the cab gauge. */
  reservoirPressure = 780;

  /** True while the train is held at a stand by the brakes. */
  stopped = true;

  /** Last computed forces, exposed for the HUD and the sound engine. */
  tractiveEffort = 0;
  brakeForce = 0;
  resistance = 0;
  gradeForce = 0;

  constructor(spec: TrainSpec = COMMUTER_EMU) {
    this.spec = spec;
  }

  get mass(): number {
    return this.spec.cars * this.spec.massPerCar;
  }

  get length(): number {
    return this.spec.cars * this.spec.carLength;
  }

  get speedKmh(): number {
    return this.speed * MS_TO_KMH;
  }

  get isEmergency(): boolean {
    return this.brakeNotch >= EMERGENCY_NOTCH;
  }

  /**
   * The two handles are mechanically independent, as they are on Japanese
   * two-handle stock: moving the brake never drags the master controller with
   * it. Traction is cut electrically while the brake is applied instead, which
   * is what actually happens on the train.
   */
  setPower(notch: number): void {
    this.powerNotch = clamp(Math.round(notch), 0, MAX_POWER_NOTCH);
  }

  setBrake(notch: number): void {
    this.brakeNotch = clamp(Math.round(notch), 0, EMERGENCY_NOTCH);
  }

  /** True while the brake interlock is holding traction off. */
  get tractionCutOff(): boolean {
    return this.brakeNotch > 0 || this.reverser === 0;
  }

  /**
   * Moves the reverser one step towards forward (+1) or reverse (-1).
   * Only possible at a stand, as the interlock on the real thing requires.
   */
  moveReverser(direction: number): boolean {
    if (Math.abs(this.speed) > 0.2) return false;
    this.reverser = clamp(this.reverser + Math.sign(direction), -1, 1);
    return true;
  }

  /** Full service brake and power off, used when the game is paused or reset. */
  applyFullBrake(): void {
    this.powerNotch = 0;
    this.brakeNotch = MAX_BRAKE_NOTCH;
  }

  /** Label for the reverser position, for the cab display. */
  get reverserKey(): string {
    return this.reverser > 0 ? 'reverser.forward' : this.reverser < 0 ? 'reverser.reverse' : 'reverser.neutral';
  }

  /**
   * Tractive effort available at the current speed, in newtons.
   * Constant force to base speed, constant power beyond it, falling away
   * quickly once the motors are into field weakening.
   */
  effortAt(speed: number): number {
    const s = Math.max(Math.abs(speed), 0.1);
    const spec = this.spec;
    if (s <= spec.baseSpeed) return spec.maxTractiveEffort;
    const constantPower = (spec.maxTractiveEffort * spec.baseSpeed) / s;
    if (s <= spec.fieldWeakeningSpeed) return constantPower;
    const falloff = spec.fieldWeakeningSpeed / s;
    return constantPower * falloff;
  }

  /** Davis running resistance in newtons at a given speed. */
  resistanceAt(speed: number): number {
    const v = Math.abs(speed) * MS_TO_KMH;
    const tonnes = this.mass / 1000;
    const specific = 20 + 0.35 * v + 0.0075 * v * v; // N per tonne
    return specific * tonnes;
  }

  /** Extra resistance from running through a curve, in newtons. */
  curveResistanceAt(radius: number): number {
    if (!Number.isFinite(radius) || radius <= 0) return 0;
    const tonnes = this.mass / 1000;
    return (6000 / Math.max(radius, 80)) * tonnes;
  }

  /**
   * Distance needed to come to a stand from the current speed using the
   * given brake rate, including the time the brakes take to build up.
   */
  stoppingDistance(rate = this.spec.serviceBrake * 0.82): number {
    const v = Math.abs(this.speed);
    const buildUp = v * 1.4; // metres travelled while the brake applies
    return buildUp + (v * v) / (2 * Math.max(rate, 0.05));
  }

  update(dt: number, forces: TrackForces): void {
    const spec = this.spec;

    // Traction and brake systems respond with a lag.
    const powerDemand = this.tractionCutOff ? 0 : this.powerNotch / MAX_POWER_NOTCH;
    const powerRate = powerDemand > this.tractionOutput ? 1.6 : 3.2;
    this.tractionOutput = damp(this.tractionOutput, powerDemand, powerRate, dt);

    const brakeDemand = this.isEmergency ? 1.25 : this.brakeNotch / MAX_BRAKE_NOTCH;
    // Air brakes apply faster than they release.
    const brakeRate = brakeDemand > this.brakeOutput ? 2.6 : 1.7;
    this.brakeOutput = damp(this.brakeOutput, brakeDemand, brakeRate, dt);

    const v = this.speed;
    const dir = this.reverser >= 0 ? 1 : -1;

    // Cut traction near the maximum design speed.
    const speedFactor = 1 - Math.max(0, Math.abs(v) * MS_TO_KMH - spec.maxSpeed + 4) / 8;
    this.tractiveEffort = this.effortAt(v) * this.tractionOutput * clamp(speedFactor, 0, 1) * dir;

    // Brake force opposes motion; it holds the train at a stand rather than
    // pushing it backwards.
    const maxBrake = spec.serviceBrake * this.mass;
    this.brakeForce = maxBrake * this.brakeOutput;

    this.resistance = this.resistanceAt(v) + this.curveResistanceAt(forces.radius);
    this.gradeForce = -this.mass * GRAVITY * forces.grade;

    let netForce = this.tractiveEffort + this.gradeForce;
    netForce -= Math.sign(v || dir) * this.resistance;

    const brakeDecel = this.brakeForce;
    if (Math.abs(v) > 0.05) {
      netForce -= Math.sign(v) * brakeDecel;
      this.stopped = false;
    } else {
      // At a stand the brakes hold against gravity up to their capacity.
      const hold = Math.min(Math.abs(netForce), brakeDecel);
      netForce -= Math.sign(netForce) * hold;
      this.stopped = brakeDecel > 0 && Math.abs(netForce) < 1;
    }

    this.acceleration = netForce / this.mass;
    let newSpeed = v + this.acceleration * dt;

    // Do not let the brakes drag the train backwards.
    if (v > 0 && newSpeed < 0 && this.brakeOutput > 0.02) newSpeed = 0;
    if (v < 0 && newSpeed > 0 && this.brakeOutput > 0.02) newSpeed = 0;
    if (Math.abs(newSpeed) < 0.02 && this.powerNotch === 0) newSpeed = 0;

    this.speed = newSpeed;
    this.position += this.speed * dt;

    // Compressor keeps the main reservoir topped up.
    const consumption = this.brakeOutput * 42 * dt;
    this.reservoirPressure = clamp(
      moveTowards(this.reservoirPressure - consumption, 830, 26 * dt),
      420,
      880,
    );
  }

  /** Speed in km/h that would be reached coasting for `seconds`. */
  predictSpeed(seconds: number): number {
    const decel = this.resistanceAt(this.speed) / this.mass;
    return Math.max(0, this.speed - decel * seconds) * MS_TO_KMH;
  }

  /** Recommended brake notch to stop in `distance` metres. */
  suggestedBrakeNotch(distance: number): number {
    if (distance <= 0.5) return MAX_BRAKE_NOTCH;
    const required = (this.speed * this.speed) / (2 * distance);
    const fraction = required / this.spec.serviceBrake;
    return clamp(Math.ceil(fraction * MAX_BRAKE_NOTCH), 0, MAX_BRAKE_NOTCH);
  }
}

/** Converts a km/h limit into m/s. */
export function limitToMs(limitKmh: number): number {
  return limitKmh * KMH;
}
