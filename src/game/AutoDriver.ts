import { clamp, MS_TO_KMH } from '../core/MathUtils';
import { MAX_BRAKE_NOTCH, MAX_POWER_NOTCH, type TrainPhysics } from '../train/TrainPhysics';
import type { TrackPath } from '../world/TrackPath';
import { stopPositionFor, type Journey } from './Journey';

/**
 * Automatic driving (ATO).
 *
 * Drives the way a careful driver does rather than the way a controller does:
 * it works to a target speed built from the line limit ahead and the braking
 * curve to the next stopping mark, moves one notch at a time with a pause
 * between movements so the ride stays smooth, and eases the brake off as the
 * train comes to rest so the stop is soft.
 */
export class AutoDriver {
  enabled = false;

  /** Seconds until the next notch movement is allowed. */
  private notchCooldown = 0;
  /** Target speed in km/h, exposed for the cab display. */
  target = 0;

  constructor(
    private readonly track: TrackPath,
    private readonly journey: Journey,
  ) {}

  /**
   * The speed the train should be doing right now: the lowest of the current
   * limit, any lower limit close enough ahead to have to brake for, and the
   * braking curve down to the next stopping mark.
   */
  targetSpeed(train: TrainPhysics): number {
    const position = train.position;
    const limit = this.track.limitAt(position);
    let target = limit - 3;

    // Look far enough ahead to brake comfortably for a restriction.
    const lookahead = Math.max(220, train.stoppingDistance(train.spec.serviceBrake * 0.5) + 160);
    const restriction = this.track.nextRestriction(position, lookahead);
    if (restriction) {
      const distance = Math.max(0, restriction.s - position - 30);
      const allowed = this.curveSpeed(train, distance, restriction.limit - 3);
      target = Math.min(target, allowed);
    }

    const station = this.journey.nextStation(position);
    if (station && !station.served) {
      const distance = stopPositionFor(station) - position;
      target = Math.min(target, this.curveSpeed(train, Math.max(0, distance), 0));
    }

    return clamp(target, 0, limit);
  }

  /** Speed from which the train can still reach `endSpeed` in `distance`. */
  private curveSpeed(train: TrainPhysics, distance: number, endSpeed: number): number {
    // Brake at roughly half the available rate: comfortable, and it leaves
    // something in hand if the driver's aid has under-estimated.
    const rate = train.spec.serviceBrake * 0.45;
    const usable = Math.max(0, distance - 6);
    const endMs = Math.max(0, endSpeed) / MS_TO_KMH;
    return Math.sqrt(endMs * endMs + 2 * rate * usable) * MS_TO_KMH;
  }

  /** Drives the train for one simulation step. */
  update(dt: number, train: TrainPhysics, _timeOfDay: number): void {
    if (!this.enabled) return;
    this.notchCooldown -= dt;

    // Held at a platform: keep the brake on and wait for the booked departure.
    if (this.journey.heldAtPlatform) {
      train.setPower(0);
      train.setBrake(MAX_BRAKE_NOTCH);
      this.target = 0;
      return;
    }

    const station = this.journey.nextStation(train.position);
    if (station && !station.served && Math.abs(train.speed) < 0.1) {
      const distance = stopPositionFor(station) - train.position;
      // Stopped short of the mark: creep up to it rather than sitting there.
      if (distance > 1.2 && distance < 60) {
        train.setBrake(0);
        train.setPower(1);
        this.target = 8;
        return;
      }
    }

    // Wait for the departure time once the doors have closed.
    if (station && station.served === false && this.journey.phase === 'ready') {
      train.setPower(0);
      train.setBrake(MAX_BRAKE_NOTCH);
      return;
    }
    const target = this.targetSpeed(train);
    this.target = target;
    const speed = train.speedKmh;
    const error = target - speed;

    if (this.notchCooldown > 0) return;

    if (error < -1.0) {
      // Too fast: shut off, then brake progressively.
      if (train.powerNotch > 0) {
        train.setPower(train.powerNotch - 1);
      } else {
        const wanted = clamp(Math.ceil(-error / 3), 1, MAX_BRAKE_NOTCH - 1);
        // Ease off as the train comes to rest so the stop is soft.
        const softened = speed < 12 ? Math.min(wanted, 3) : wanted;
        if (train.brakeNotch < softened) train.setBrake(train.brakeNotch + 1);
        else if (train.brakeNotch > softened) train.setBrake(train.brakeNotch - 1);
      }
      this.notchCooldown = 0.55;
      return;
    }

    if (error > 2.5) {
      // Room to accelerate: release the brake first, then take power.
      if (train.brakeNotch > 0) {
        train.setBrake(train.brakeNotch - 1);
        this.notchCooldown = 0.4;
      } else if (train.powerNotch < MAX_POWER_NOTCH) {
        train.setPower(train.powerNotch + 1);
        this.notchCooldown = 0.85;
      }
      return;
    }

    // Close to the target: coast, trimming a notch off at a time.
    if (error < 0.6 && train.powerNotch > 0) {
      train.setPower(train.powerNotch - 1);
      this.notchCooldown = 0.7;
    } else if (error > 1.4 && train.brakeNotch > 0) {
      train.setBrake(train.brakeNotch - 1);
      this.notchCooldown = 0.5;
    }
  }
}
