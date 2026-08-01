import { Group } from 'three';
import { Consist } from './Consist';
import { COMMUTER_EMU, type TrainSpec } from './TrainPhysics';
import type { TrackPath } from '../world/TrackPath';
import { Rng } from '../core/Random';
import { KMH } from '../core/MathUtils';

/**
 * Trains on the opposite road.
 *
 * Nothing sells a running line like meeting another train: the flash of a
 * passing unit, the pressure wave against the cab, the block signals stepping
 * back to red behind it.
 */

interface AiTrain {
  consist: Consist;
  /** Chainage of its leading cab. */
  position: number;
  speed: number;
  passed: boolean;
}

const LIVERIES: { body: number; accent: number }[] = [
  { body: 0xd6dbe0, accent: 0x1f6fb5 },
  { body: 0xd2d7dc, accent: 0xc8352b },
  { body: 0xcfd5da, accent: 0x2f9e63 },
  { body: 0xd4d6d4, accent: 0xe08a1e },
  { body: 0xc8ced4, accent: 0x5b4b8a },
];

export class Traffic {
  readonly group = new Group();
  private readonly trains: AiTrain[] = [];
  private readonly rng: Rng;
  private nextSpawnS = 0;

  /** Set for one frame when a train passes the player, for the sound engine. */
  passEvent = 0;

  constructor(
    private readonly track: TrackPath,
    seed: number,
  ) {
    this.rng = new Rng(seed ^ 0x7a11);
    this.group.name = 'traffic';
    this.nextSpawnS = 900;
  }

  update(playerS: number, dt: number): void {
    this.passEvent = 0;

    if (playerS > this.nextSpawnS && this.trains.length < 2) {
      this.spawn(playerS + this.rng.range(1400, 2600));
      this.nextSpawnS = playerS + this.rng.range(1200, 3400);
    }

    for (let i = this.trains.length - 1; i >= 0; i--) {
      const train = this.trains[i];
      train.position -= train.speed * dt;
      train.consist.update(train.position);

      const gap = train.position - playerS;
      if (!train.passed && gap < 0) {
        train.passed = true;
        this.passEvent = Math.abs(train.speed);
      }

      // Retire once well behind, or if the player somehow outruns it.
      if (train.position < playerS - 700 || train.position > playerS + 5000) {
        this.group.remove(train.consist.group);
        train.consist.dispose();
        this.trains.splice(i, 1);
      }
    }
  }

  private spawn(atS: number): void {
    this.track.extendTo(atS + 400);
    const livery = this.rng.pick(LIVERIES);
    const spec: TrainSpec = { ...COMMUTER_EMU, cars: this.rng.pick([2, 3, 4, 6]) };
    const consist = new Consist(this.track, {
      spec,
      road: 1,
      direction: -1,
      bodyColor: livery.body,
      accentColor: livery.accent,
      withCab: false,
    });
    const train: AiTrain = {
      consist,
      position: atS,
      speed: this.rng.range(55, 105) * KMH,
      passed: false,
    };
    consist.update(atS);
    this.group.add(consist.group);
    this.trains.push(train);
  }

  /** Chainages of the leading cabs, used by the signalling. */
  positions(): number[] {
    return this.trains.map((t) => t.position);
  }

  /** Distance to the nearest approaching train, or Infinity. */
  nearestGap(playerS: number): number {
    let best = Infinity;
    for (const train of this.trains) {
      const gap = Math.abs(train.position - playerS);
      if (gap < best) best = gap;
    }
    return best;
  }

  setLighting(darkness: number, headlights: boolean): void {
    for (const train of this.trains) train.consist.setLighting(darkness, headlights);
  }

  dispose(): void {
    for (const train of this.trains) train.consist.dispose();
    this.trains.length = 0;
    this.group.clear();
  }
}
