import { clamp, MS_TO_KMH } from '../core/MathUtils';
import type { StationInfo, TrackPath } from '../world/TrackPath';
import type { TrainPhysics } from '../train/TrainPhysics';

/**
 * The service being worked: where the next stop is, whether the train is on
 * time, and how well it is being driven.
 *
 * Scoring rewards the two things a driver is actually judged on - stopping in
 * the right place and keeping to the timetable - with smaller adjustments for
 * riding quality and for keeping inside the speed limit.
 */

export type JourneyPhase = 'running' | 'arrived' | 'boarding' | 'ready';

export interface StopResult {
  station: StationInfo;
  /** Signed stopping error in metres; positive means overshot. */
  error: number;
  /** Seconds late on arrival (negative is early). */
  delay: number;
  points: number;
  rating: 'perfect' | 'good' | 'fair' | 'poor';
}

/** Where the front of the train should come to a stand at a station. */
export function stopPositionFor(station: StationInfo): number {
  return station.s + station.platformLength * 0.5 - 6;
}

export class Journey {
  score = 0;
  /** Seconds behind the timetable; negative means early. */
  delay = 0;
  phase: JourneyPhase = 'running';
  doorsOpen = false;
  /** Progress of the door animation, 0 closed to 1 open. */
  doorProgress = 0;
  stopsMade = 0;
  perfectStops = 0;
  /** The most recent stop, for the results banner. */
  lastStop: StopResult | null = null;
  /** Message shown briefly in the cab display. */
  message = '';
  messageTimer = 0;

  private dwellRemaining = 0;
  private overspeedTime = 0;
  private overspeedPenaltyAccum = 0;
  private lastPosition = 0;
  private emergencyUsed = false;
  private roughness = 0;

  constructor(
    private readonly track: TrackPath,
    /** Seconds since midnight when the service started. */
    public readonly startTime: number,
  ) {}

  /**
   * The station the train is working towards: the first one it has not yet
   * served. A station that has been served is finished with, even while the
   * train is still standing alongside its platform.
   */
  nextStation(_position: number): StationInfo | null {
    for (const station of this.track.stations) {
      if (!station.served) return station;
    }
    return null;
  }

  distanceToStop(position: number): number {
    const station = this.nextStation(position);
    if (!station) return Infinity;
    return stopPositionFor(station) - position;
  }

  /** Current simulated time of day in seconds. */
  timeOfDay(elapsed: number): number {
    return this.startTime + elapsed;
  }

  update(
    dt: number,
    elapsed: number,
    train: TrainPhysics,
    limit: number,
    setMessage: (key: string, seconds: number, suffix?: string) => void,
  ): void {
    const now = this.timeOfDay(elapsed);
    const station = this.nextStation(train.position);

    // Running score: distance covered, scaled down when speeding.
    const travelled = Math.max(0, train.position - this.lastPosition);
    this.lastPosition = train.position;
    this.score += travelled * 0.6;

    // Speed limit enforcement.
    const speedKmh = train.speedKmh;
    if (speedKmh > limit + 2) {
      this.overspeedTime += dt;
      const excess = speedKmh - limit;
      this.overspeedPenaltyAccum += excess * dt * 4;
      if (this.overspeedPenaltyAccum > 25) {
        this.score -= this.overspeedPenaltyAccum;
        this.overspeedPenaltyAccum = 0;
        setMessage('msg.overspeed', 2.5);
      }
    } else {
      this.overspeedTime = Math.max(0, this.overspeedTime - dt * 0.5);
    }

    // Ride quality: harsh changes of acceleration cost a little.
    const jerk = Math.abs(train.acceleration - this.roughness) / Math.max(dt, 1e-3);
    this.roughness = train.acceleration;
    if (jerk > 3.5) this.score -= (jerk - 3.5) * dt * 6;

    if (train.isEmergency && !this.emergencyUsed && train.speed > 1) {
      this.emergencyUsed = true;
      this.score -= 400;
      setMessage('msg.emergency', 3);
    }
    if (!train.isEmergency) this.emergencyUsed = false;

    if (!station) return;

    // Delay against the timetable for the next stop.
    this.delay = now - station.scheduledArrival;

    switch (this.phase) {
      case 'running': {
        const error = train.position - stopPositionFor(station);
        const stopped = Math.abs(train.speed) < 0.12 && train.brakeOutput > 0.05;
        // The arrival window reaches as far as the run-through threshold, so a
        // train that has come to a stand alongside the platform always either
        // arrives or is booked for running through - never neither.
        if (stopped && error < 40 && error > -22) {
          this.completeStop(station, error, now, setMessage);
        } else if (error > 40) {
          // Ran through the platform without stopping.
          station.served = true;
          this.score -= 500;
          setMessage('msg.stationPassed', 3);
        }
        break;
      }
      case 'arrived': {
        // Doors open once the train is at a stand.
        this.doorProgress = Math.min(1, this.doorProgress + dt * 0.9);
        this.doorsOpen = true;
        if (this.doorProgress >= 1) {
          this.phase = 'boarding';
          this.dwellRemaining = Math.max(6, station.dwell);
        }
        break;
      }
      case 'boarding': {
        this.dwellRemaining -= dt;
        if (this.dwellRemaining <= 0) {
          this.phase = 'ready';
          setMessage('msg.doorsClosing', 2.5);
        }
        break;
      }
      case 'ready': {
        this.doorProgress = Math.max(0, this.doorProgress - dt * 0.9);
        if (this.doorProgress <= 0) {
          this.doorsOpen = false;
          station.served = true;
          this.phase = 'running';
        }
        break;
      }
    }
  }

  private completeStop(
    station: StationInfo,
    error: number,
    now: number,
    setMessage: (key: string, seconds: number, suffix?: string) => void,
  ): void {
    const absError = Math.abs(error);
    let points = 0;
    let rating: StopResult['rating'] = 'poor';
    if (absError < 0.35) {
      points = 1500;
      rating = 'perfect';
      this.perfectStops++;
    } else if (absError < 1.0) {
      points = 1000;
      rating = 'good';
    } else if (absError < 2.5) {
      points = 600;
      rating = 'good';
    } else if (absError < 6) {
      points = 250;
      rating = 'fair';
    } else {
      points = 40;
      rating = 'poor';
    }

    const delay = now - station.scheduledArrival;
    const absDelay = Math.abs(delay);
    if (absDelay < 5) points += 700;
    else if (absDelay < 15) points += 400;
    else if (absDelay < 30) points += 180;
    else if (delay > 90) points -= 250;

    this.score += points;
    this.stopsMade++;
    this.delay = delay;
    this.lastStop = { station, error, delay, points, rating };
    this.phase = 'arrived';
    this.doorProgress = 0;

    const label =
      rating === 'perfect'
        ? 'msg.perfectStop'
        : rating === 'good'
          ? 'msg.goodStop'
          : rating === 'fair'
            ? 'msg.fairStop'
            : 'msg.poorStop';
    setMessage(label, 4, `  ${error >= 0 ? '+' : ''}${error.toFixed(2)} m`);
  }

  /**
   * Re-bases the journey after the driver skips ahead down the line, so the
   * running score does not count the skipped distance.
   */
  resetTo(position: number): void {
    this.lastPosition = position;
    this.phase = 'running';
    this.doorsOpen = false;
    this.doorProgress = 0;
    this.dwellRemaining = 0;
  }

  /** True while the train must not move. */
  get heldAtPlatform(): boolean {
    return this.phase === 'arrived' || this.phase === 'boarding';
  }

  /** Seconds of dwell remaining, for the cab display. */
  get dwellLeft(): number {
    return Math.max(0, this.dwellRemaining);
  }

  /** Recommended braking curve target for the driver aid, in km/h. */
  recommendedSpeed(train: TrainPhysics, distance: number, limit: number): number {
    if (!Number.isFinite(distance) || distance <= 0) return 0;
    const rate = train.spec.serviceBrake * 0.62;
    const target = Math.sqrt(Math.max(0, 2 * rate * Math.max(0, distance - 4))) * MS_TO_KMH;
    return clamp(Math.min(target, limit), 0, limit);
  }
}
