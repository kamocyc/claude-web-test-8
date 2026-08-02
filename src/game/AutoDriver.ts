import { clamp, MS_TO_KMH } from '../core/MathUtils';
import { MAX_BRAKE_NOTCH, MAX_POWER_NOTCH, type TrainPhysics } from '../train/TrainPhysics';
import type { TrackPath } from '../world/TrackPath';
import { stopPositionFor, type Journey } from './Journey';

/**
 * Automatic driving (ATO).
 *
 * Drives the way a careful driver does rather than the way a controller does:
 * it works out the deceleration the train actually needs for whatever is
 * coming - the stopping mark, a speed restriction, the line limit - and picks
 * the brake notch that produces it, moving a notch at a time so the ride stays
 * smooth. Choosing the notch from the required rate rather than from the speed
 * error is what makes it hold the braking curve instead of riding above it and
 * running through the platform.
 */

/** Comfortable braking, as a fraction of the full service brake. */
const COMFORT = 0.45;
/** Seconds the brake takes to do anything, allowed for when it is applied. */
const BRAKE_LAG = 0.35;
/** How far short of the mark the train is aimed, metres. */
const STOP_MARGIN = 0.1;

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
   * braking curve down to the next stopping mark. Shown on the cab display;
   * the handles are worked from the required deceleration instead.
   */
  targetSpeed(train: TrainPhysics): number {
    const position = train.position;
    const limit = this.track.limitAt(position);
    let target = limit - 3;

    // Look far enough ahead to brake comfortably for a restriction.
    const restriction = this.track.nextRestriction(position, this.lookahead(train));
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
    const rate = train.spec.serviceBrake * COMFORT;
    const usable = Math.max(0, distance - 6);
    const endMs = Math.max(0, endSpeed) / MS_TO_KMH;
    return Math.sqrt(endMs * endMs + 2 * rate * usable) * MS_TO_KMH;
  }

  /** How far ahead it is worth looking for something to brake for. */
  private lookahead(train: TrainPhysics): number {
    return Math.max(240, train.stoppingDistance(train.spec.serviceBrake * COMFORT) + 180);
  }

  /**
   * Deceleration in m/s^2 needed to be down to `endSpeed` (m/s) in `distance`
   * metres. Infinite once the train can no longer make it.
   */
  private requiredRate(speed: number, distance: number, endSpeed: number): number {
    if (speed <= endSpeed) return 0;
    // The brake does not come on the moment it is asked for, so the train
    // covers a little ground at the current speed before it starts to slow.
    const usable = distance - speed * BRAKE_LAG - STOP_MARGIN;
    if (usable <= 0.05) return Infinity;
    return (speed * speed - endSpeed * endSpeed) / (2 * usable);
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
    const working = station && !station.served ? station : null;
    const toMark = working ? stopPositionFor(working) - train.position : Infinity;
    const speed = Math.abs(train.speed);
    const stationary = speed < 0.15;

    // Doors closing: stay put until the departure time comes round.
    if (working && this.journey.phase === 'ready') {
      train.setPower(0);
      train.setBrake(MAX_BRAKE_NOTCH);
      this.target = 0;
      return;
    }

    if (working && stationary) {
      // Standing at the mark - or past it. Hold the train there with a
      // definite application so the stop registers and nothing rolls.
      if (toMark <= 1.0) {
        train.setPower(0);
        if (train.brakeNotch < 4) train.setBrake(4);
        this.target = 0;
        return;
      }
      // Stopped short of it: creep up rather than sitting there.
      if (toMark < 60) {
        train.setBrake(0);
        train.setPower(1);
        this.target = 6;
        return;
      }
    }

    this.target = this.targetSpeed(train);
    const spec = train.spec;
    const limit = this.track.limitAt(train.position);

    // Work out the hardest deceleration anything ahead calls for.
    let required = 0;
    if (working) required = Math.max(required, this.requiredRate(speed, Math.max(toMark, 0), 0));
    const restriction = this.track.nextRestriction(train.position, this.lookahead(train));
    if (restriction) {
      required = Math.max(
        required,
        this.requiredRate(speed, restriction.s - train.position - 25, (restriction.limit - 2) / MS_TO_KMH),
      );
    }

    if (required >= spec.serviceBrake * COMFORT * 0.8) {
      train.setPower(0);
      const wanted = clamp(Math.ceil((required / spec.serviceBrake) * MAX_BRAKE_NOTCH), 1, MAX_BRAKE_NOTCH);
      this.moveBrake(train, wanted);
      return;
    }

    // Nothing to brake for. Hold the line speed with a light application if
    // the road is falling away, otherwise release and drive to the target.
    if (train.speedKmh > limit + 0.5) {
      train.setPower(0);
      this.moveBrake(train, 2);
      return;
    }

    if (train.brakeNotch > 0) {
      if (this.notchCooldown <= 0) {
        train.setBrake(train.brakeNotch - 1);
        this.notchCooldown = 0.3;
      }
      return;
    }

    if (this.notchCooldown > 0) return;
    const error = this.target - train.speedKmh;
    if (error > 2.5 && train.powerNotch < MAX_POWER_NOTCH) {
      train.setPower(train.powerNotch + 1);
      this.notchCooldown = 0.85;
    } else if (error < 0.5 && train.powerNotch > 0) {
      train.setPower(train.powerNotch - 1);
      this.notchCooldown = 0.7;
    }
  }

  /**
   * Works the brake handle towards `wanted`, a notch at a time. Brake is taken
   * promptly - and straight away when the train is well behind the curve -
   * but released gently, which is what keeps the ride comfortable.
   */
  private moveBrake(train: TrainPhysics, wanted: number): void {
    if (train.brakeNotch === wanted) return;
    if (wanted > train.brakeNotch) {
      if (this.notchCooldown > 0 && wanted < train.brakeNotch + 3) return;
      train.setBrake(train.brakeNotch + 1);
      this.notchCooldown = 0.3;
    } else {
      if (this.notchCooldown > 0) return;
      train.setBrake(train.brakeNotch - 1);
      this.notchCooldown = 0.45;
    }
  }
}
