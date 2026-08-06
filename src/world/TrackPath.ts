import { Vector3 } from 'three';
import { Rng, Noise1D } from '../core/Random';
import { clamp, lerp, moveTowards, smoothstep, MS_TO_KMH } from '../core/MathUtils';
import {
  BIOME_IDS,
  BIOME_INDEX,
  biome,
  transitionWeights,
  type BiomeId,
  dominantBiome,
} from './Biome';
import { generateStationName, type PlaceName } from './Names';
import type { RiverAxis } from './River';

/** Distance between stored centre-line samples, metres. */
export const SAMPLE_STEP = 2;
/** Narrow gauge, as used by most JR regional lines. */
export const TRACK_GAUGE = 1.067;
/** Centre-to-centre distance between the two running lines. */
export const TRACK_SPACING = 4.1;
/** Height of the rail head above the formation. */
export const RAIL_HEIGHT = 0.145;

export type StructureKind = 0 | 1 | 2; // ground | bridge | tunnel
export const STRUCT_GROUND: StructureKind = 0;
export const STRUCT_BRIDGE: StructureKind = 1;
export const STRUCT_TUNNEL: StructureKind = 2;

export interface TrackSample {
  s: number;
  x: number;
  y: number;
  z: number;
  /** Heading in radians; forward = (cos h, 0, sin h). */
  heading: number;
  /** dy/ds. */
  grade: number;
  /** Signed curvature 1/m; positive curves to the right. */
  curvature: number;
  /** Superelevation as a roll angle in radians. */
  cant: number;
  /** Permitted speed in km/h. */
  speedLimit: number;
  /** Biome mix at this chainage. */
  weights: Float32Array;
  seaSide: number;
  riverSide: number;
  riverStrength: number;
  structure: StructureKind;
  /** Nearby-station flag: suppresses lineside clutter through platforms. */
  stationZone: number;
  /**
   * Set by `TerrainField.project` when the query fell past the end of the
   * generated route: how far past, in metres. Everything the railway does to
   * the ground fades out over it, so the horizon is never shaped by whatever
   * happened to be at the last sleeper.
   */
  beyond?: number;
}

export interface StationInfo {
  index: number;
  s: number;
  name: PlaceName;
  /** -1 = platform on the left only, 1 = right only, 0 = island/both. */
  platformSide: number;
  platformLength: number;
  scheduledArrival: number;
  scheduledDeparture: number;
  dwell: number;
  biome: BiomeId;
  hasCanopy: boolean;
  hasFootbridge: boolean;
  /** Set once the player has served the station. */
  served: boolean;
}

export interface SignalInfo {
  s: number;
  side: number;
  kind: 'block' | 'home' | 'distant';
  /** 0 = red, 1 = yellow, 2 = green. */
  aspect: number;
}

export interface CrossingInfo {
  s: number;
  width: number;
  skew: number;
  /** Road importance 0..1, controls barrier count and road width. */
  grade: number;
}

export interface RiverInfo {
  s: number;
  width: number;
  skew: number;
  bankHeight: number;
  /**
   * World-space axis, resolved on first use by `riverAxis` and cached here so
   * the terrain, the water surface and the bridge all see the same river.
   */
  axis?: RiverAxis;
}

export interface TunnelInfo {
  sStart: number;
  sEnd: number;
}

export interface BridgeInfo {
  sStart: number;
  sEnd: number;
  height: number;
  kind: 'girder' | 'truss' | 'viaduct';
}

export interface SpeedSign {
  s: number;
  limit: number;
}

const MAX_LINE_SPEED = 120;

/**
 * The route: an endlessly extendable centre line plus everything attached to
 * it (stations, signals, structures).
 *
 * The geometry is integrated sample by sample from a rate-limited curvature and
 * gradient, which is exactly how real alignments are built: straights joined to
 * circular curves by clothoid transitions, and gradients joined by vertical
 * curves. That makes the ride feel right and keeps the maths trivial to sample
 * at any chainage.
 */
export class TrackPath {
  readonly seed: number;
  private readonly rng: Rng;
  private readonly wobble: Noise1D;

  private samples: TrackSample[] = [];
  /** Chainage of samples[0]. */
  private startS = 0;

  readonly stations: StationInfo[] = [];
  readonly signals: SignalInfo[] = [];
  readonly crossings: CrossingInfo[] = [];
  readonly rivers: RiverInfo[] = [];
  readonly tunnels: TunnelInfo[] = [];
  readonly bridges: BridgeInfo[] = [];
  readonly speedSigns: SpeedSign[] = [];

  /** Chainage generated so far. */
  private headS = 0;
  private head: TrackSample;

  // --- planner state -------------------------------------------------------
  private targetCurvature = 0;
  private segmentEnd = 0;
  private segmentLimit = MAX_LINE_SPEED;
  private targetGrade = 0;
  private verticalEnd = 0;
  private targetElevation = 30;

  private biomeCurrent: BiomeId = 'coast';
  private biomeNext: BiomeId = 'coast';
  private biomeChangeS = 0;
  private biomeBlendStart = 0;
  private weights = new Float32Array(BIOME_IDS.length);

  private seaSide = -1;
  private riverSide = 1;
  private riverStrength = 0;

  private nextStationS = 1500;
  private nextSignalS = 700;
  private nextCrossingS = 1200;
  private stationCounter = 0;
  private readonly usedNames = new Set<string>();

  private tunnelUntil = -1;
  private bridgeUntil = -1;
  private nextStructureCheck = 800;

  /** Timetable bookkeeping. */
  private lastDeparture: number;
  private lastStationS = 0;

  constructor(seed: number, startTimeOfDay: number) {
    this.seed = seed;
    this.rng = new Rng(seed);
    this.wobble = new Noise1D(seed ^ 0x5eed);
    this.lastDeparture = startTimeOfDay;

    const firstBiome = this.rng.pick(['coast', 'farmland', 'suburb', 'forest'] as BiomeId[]);
    this.biomeCurrent = firstBiome;
    this.biomeNext = firstBiome;
    this.weights[BIOME_INDEX[firstBiome]] = 1;
    this.seaSide = this.rng.chance(0.5) ? -1 : 1;
    this.riverSide = this.rng.chance(0.5) ? -1 : 1;
    this.targetElevation = this.pickElevationTarget();

    const def = biome(firstBiome);
    this.segmentLimit = def.lineSpeed;

    this.head = {
      s: 0,
      x: 0,
      y: this.targetElevation,
      z: 0,
      heading: this.rng.range(0, Math.PI * 2),
      grade: 0,
      curvature: 0,
      cant: 0,
      speedLimit: def.lineSpeed,
      weights: this.weights.slice(),
      seaSide: this.seaSide,
      riverSide: this.riverSide,
      riverStrength: 0,
      structure: STRUCT_GROUND,
      stationZone: 0,
    };
    this.samples.push(this.head);
    this.biomeChangeS = this.rng.range(1400, 3200);
    this.extendTo(600);
  }

  get generatedTo(): number {
    return this.headS;
  }

  get firstSample(): TrackSample {
    return this.samples[0];
  }

  private pickElevationTarget(): number {
    const def = biome(this.biomeNext);
    return this.rng.range(def.elevation[0], def.elevation[1]);
  }

  // --- sampling ------------------------------------------------------------

  /** Nearest stored sample, clamped to the generated range. */
  sampleIndex(s: number): number {
    const i = Math.round((s - this.startS) / SAMPLE_STEP);
    return clamp(i, 0, this.samples.length - 1);
  }

  /** Raw stored sample by index (no interpolation). */
  at(index: number): TrackSample {
    return this.samples[clamp(index, 0, this.samples.length - 1)];
  }

  get sampleCount(): number {
    return this.samples.length;
  }

  get baseS(): number {
    return this.startS;
  }

  /** Linearly interpolated sample at an arbitrary chainage. */
  sampleAt(s: number, out?: TrackSample): TrackSample {
    const f = (s - this.startS) / SAMPLE_STEP;
    const i0 = clamp(Math.floor(f), 0, this.samples.length - 1);
    const i1 = clamp(i0 + 1, 0, this.samples.length - 1);
    const t = clamp(f - i0, 0, 1);
    const a = this.samples[i0];
    const b = this.samples[i1];
    const r = out ?? ({ weights: new Float32Array(BIOME_IDS.length) } as TrackSample);
    r.s = s;
    r.x = lerp(a.x, b.x, t);
    r.y = lerp(a.y, b.y, t);
    r.z = lerp(a.z, b.z, t);
    r.heading = a.heading + shortestAngle(a.heading, b.heading) * t;
    r.grade = lerp(a.grade, b.grade, t);
    r.curvature = lerp(a.curvature, b.curvature, t);
    r.cant = lerp(a.cant, b.cant, t);
    r.speedLimit = t < 0.5 ? a.speedLimit : b.speedLimit;
    r.seaSide = a.seaSide;
    r.riverSide = a.riverSide;
    r.riverStrength = lerp(a.riverStrength, b.riverStrength, t);
    r.structure = t < 0.5 ? a.structure : b.structure;
    r.stationZone = lerp(a.stationZone, b.stationZone, t);
    r.beyond = 0;
    if (!r.weights) r.weights = new Float32Array(BIOME_IDS.length);
    for (let k = 0; k < r.weights.length; k++) r.weights[k] = lerp(a.weights[k], b.weights[k], t);
    return r;
  }

  /** World position offset laterally and vertically from the centre line. */
  positionAt(s: number, lateral = 0, height = 0, out = new Vector3()): Vector3 {
    const sample = this.sampleAt(s, scratchSample);
    return offsetPosition(sample, lateral, height, out);
  }

  /** Speed limit in km/h at a chainage. */
  limitAt(s: number): number {
    return this.at(this.sampleIndex(s)).speedLimit;
  }

  /** Dominant biome at a chainage. */
  biomeAt(s: number): BiomeId {
    return dominantBiome(this.at(this.sampleIndex(s)).weights);
  }

  /**
   * Chainage at which the line has fully entered a different landscape,
   * generating more route as needed. Returns null if nothing changes within
   * `maxDistance`, which in practice never happens.
   */
  findNextBiomeChange(from: number, maxDistance = 24000): number | null {
    const current = this.biomeAt(from);
    for (let s = from + 300; s < from + maxDistance; s += 120) {
      this.extendTo(s + 900);
      if (this.biomeAt(s) !== current) {
        // Land a little way in, so the arrival is unmistakably the new scenery.
        const target = s + 500;
        this.extendTo(target + 1200);
        return target;
      }
    }
    return null;
  }

  /** Lowest speed limit between two chainages - used by the driving aid. */
  minLimitBetween(s0: number, s1: number): number {
    const i0 = this.sampleIndex(s0);
    const i1 = this.sampleIndex(s1);
    let min = Infinity;
    for (let i = i0; i <= i1; i += 2) min = Math.min(min, this.samples[i].speedLimit);
    return Number.isFinite(min) ? min : MAX_LINE_SPEED;
  }

  /** Next chainage ahead of `s` where the limit drops, or null. */
  nextRestriction(s: number, lookahead = 3000): { s: number; limit: number } | null {
    const i0 = this.sampleIndex(s);
    const current = this.samples[i0].speedLimit;
    const iEnd = this.sampleIndex(s + lookahead);
    for (let i = i0; i <= iEnd; i++) {
      if (this.samples[i].speedLimit < current - 0.5) {
        return { s: this.samples[i].s, limit: this.samples[i].speedLimit };
      }
    }
    return null;
  }

  /**
   * Shifts every scheduled time, so the player can skip the clock forward
   * without becoming instantly late.
   */
  shiftSchedule(seconds: number): void {
    for (const station of this.stations) {
      station.scheduledArrival += seconds;
      station.scheduledDeparture += seconds;
    }
    this.lastDeparture += seconds;
  }

  nextStation(s: number): StationInfo | null {
    for (const st of this.stations) if (st.s + 40 > s) return st;
    return null;
  }

  stationsAhead(s: number, count: number): StationInfo[] {
    const out: StationInfo[] = [];
    for (const st of this.stations) {
      if (st.s + 40 > s) out.push(st);
      if (out.length >= count) break;
    }
    return out;
  }

  // --- generation ----------------------------------------------------------

  /** Generates samples until at least `s` metres of route exist. */
  extendTo(s: number): void {
    while (this.headS < s) this.step();
  }

  /** Drops samples behind `s` to bound memory on a long run. */
  prune(s: number): void {
    const keepFrom = s - 800;
    const drop = Math.floor((keepFrom - this.startS) / SAMPLE_STEP);
    if (drop > 256) {
      this.samples.splice(0, drop);
      this.startS += drop * SAMPLE_STEP;
    }
    while (this.stations.length && this.stations[0].s < s - 1200) this.stations.shift();
    while (this.signals.length && this.signals[0].s < s - 1200) this.signals.shift();
    while (this.crossings.length && this.crossings[0].s < s - 1200) this.crossings.shift();
    while (this.rivers.length && this.rivers[0].s < s - 1600) this.rivers.shift();
    while (this.tunnels.length && this.tunnels[0].sEnd < s - 1200) this.tunnels.shift();
    while (this.bridges.length && this.bridges[0].sEnd < s - 1200) this.bridges.shift();
    while (this.speedSigns.length && this.speedSigns[0].s < s - 1200) this.speedSigns.shift();
  }

  private step(): void {
    const prev = this.head;
    const s = prev.s + SAMPLE_STEP;

    this.planIfNeeded(s);

    // Curvature is rate limited: the ramp between straight and circular curve
    // is a clothoid, which is what makes a curve feel progressive from the cab.
    const curvRate = 3.6e-5 * SAMPLE_STEP;
    const curvature = moveTowards(prev.curvature, this.targetCurvature, curvRate);

    // Gradients change through a vertical curve of ~5000 m radius.
    const gradeRate = 2.0e-4 * SAMPLE_STEP;
    const grade = moveTowards(prev.grade, this.targetGrade, gradeRate);

    const heading = prev.heading + curvature * SAMPLE_STEP;
    const x = prev.x + Math.cos(heading) * SAMPLE_STEP;
    const z = prev.z + Math.sin(heading) * SAMPLE_STEP;
    const y = prev.y + grade * SAMPLE_STEP;

    this.advanceBiome(s);

    // Superelevation balances part of the lateral acceleration at line speed.
    const limitMs = this.segmentLimit / MS_TO_KMH;
    // Negative sign so that the outer rail rises: a right hand curve
    // (positive curvature) lifts the left rail and the train leans right.
    const idealCant = clamp(
      -(curvature * limitMs * limitMs) / 9.80665,
      -0.105,
      0.105,
    ); // ~110 mm cant on 1067 mm gauge
    const cant = lerp(prev.cant, idealCant, 0.02);

    const structure = this.structureAt(s);
    const stationZone = this.stationZoneAt(s);

    const sample: TrackSample = {
      s,
      x,
      y,
      z,
      heading,
      grade,
      curvature,
      cant,
      speedLimit: this.speedLimitAt(s, curvature),
      weights: this.weights.slice(),
      seaSide: this.seaSide,
      riverSide: this.riverSide,
      riverStrength: this.riverStrength,
      structure,
      stationZone,
    };

    this.samples.push(sample);
    this.head = sample;
    this.headS = s;
  }

  private structureAt(s: number): StructureKind {
    if (s <= this.tunnelUntil) return STRUCT_TUNNEL;
    if (s <= this.bridgeUntil) return STRUCT_BRIDGE;
    return STRUCT_GROUND;
  }

  private stationZoneAt(s: number): number {
    let zone = 0;
    for (const st of this.stations) {
      if (Math.abs(st.s - s) < 420) {
        zone = Math.max(zone, 1 - smoothstep(120, 420, Math.abs(st.s - s)));
      }
    }
    return zone;
  }

  private speedLimitAt(s: number, curvature: number): number {
    const def = biome(dominantBiome(this.weights));
    let limit = Math.min(this.segmentLimit, def.lineSpeed);

    // Curve limit from an unbalanced lateral acceleration of ~0.65 m/s^2.
    const radius = Math.abs(curvature) > 1e-6 ? 1 / Math.abs(curvature) : Infinity;
    if (Number.isFinite(radius)) {
      const vCurve = Math.sqrt(radius * 1.35) * MS_TO_KMH;
      limit = Math.min(limit, Math.round(vCurve / 5) * 5);
    }

    // Station throats are taken at reduced speed over the pointwork.
    for (const st of this.stations) {
      const d = Math.abs(st.s - s);
      if (d < 240) limit = Math.min(limit, 75);
    }
    if (s <= this.tunnelUntil) limit = Math.min(limit, 95);

    return clamp(Math.round(limit / 5) * 5, 25, MAX_LINE_SPEED);
  }

  private advanceBiome(s: number): void {
    if (s >= this.biomeChangeS && this.biomeNext === this.biomeCurrent) {
      // Choose the next biome and start a long cross-fade into it.
      const idx = this.rng.weighted(transitionWeights(this.biomeCurrent));
      this.biomeNext = BIOME_IDS[idx];
      this.biomeBlendStart = s;
      if (this.biomeNext !== this.biomeCurrent) {
        this.targetElevation = this.pickElevationTarget();
        if (this.biomeNext === 'coast') this.seaSide = this.rng.chance(0.5) ? -1 : 1;
        if (this.biomeNext === 'riverside') this.riverSide = this.rng.chance(0.5) ? -1 : 1;
      }
    }

    if (this.biomeNext !== this.biomeCurrent) {
      const t = smoothstep(0, 900, s - this.biomeBlendStart);
      const from = BIOME_INDEX[this.biomeCurrent];
      const to = BIOME_INDEX[this.biomeNext];
      this.weights.fill(0);
      this.weights[from] = 1 - t;
      this.weights[to] = t;
      if (t >= 1) {
        this.biomeCurrent = this.biomeNext;
        this.biomeChangeS = s + this.rng.range(1600, 4200);
      }
    }

    // A river accompanies riverside sections and fades in and out.
    const target = this.biomeCurrent === 'riverside' || this.biomeNext === 'riverside' ? 1 : 0;
    this.riverStrength = moveTowards(this.riverStrength, target, SAMPLE_STEP / 700);
  }

  private planIfNeeded(s: number): void {
    if (s >= this.segmentEnd) this.planHorizontal(s);
    if (s >= this.verticalEnd) this.planVertical(s);
    if (s >= this.nextStationS) this.placeStation(s);
    if (s >= this.nextSignalS) this.placeSignal(s);
    if (s >= this.nextCrossingS) this.placeCrossing(s);
    if (s >= this.nextStructureCheck) this.considerStructure(s);
  }

  private planHorizontal(s: number): void {
    const def = biome(this.biomeCurrent);
    const inStationZone = this.stations.some((st) => Math.abs(st.s - s) < 320);
    const nearStationAhead = this.nextStationS - s < 320;

    if (inStationZone || nearStationAhead || this.tunnelUntil > s) {
      // Platforms and tunnel bores are built straight.
      this.targetCurvature = 0;
      this.segmentEnd = s + 220;
      this.segmentLimit = def.lineSpeed;
      return;
    }

    const straight = this.rng.next() > def.curviness;
    if (straight) {
      this.targetCurvature = 0;
      this.segmentEnd = s + this.rng.range(240, 1100 - def.curviness * 600);
      this.segmentLimit = def.lineSpeed;
    } else {
      const radius = def.minRadius * this.rng.range(1.0, 3.4);
      const dir = this.rng.chance(0.5) ? 1 : -1;
      this.targetCurvature = dir / radius;
      this.segmentEnd = s + this.rng.range(160, 620);
      const vCurve = Math.sqrt(radius * 1.35) * MS_TO_KMH;
      this.segmentLimit = Math.min(def.lineSpeed, Math.round(vCurve / 5) * 5);
      const rounded = clamp(Math.round(this.segmentLimit / 5) * 5, 25, MAX_LINE_SPEED);
      if (rounded < def.lineSpeed - 4) {
        this.speedSigns.push({ s: s - 60, limit: rounded });
      }
    }
  }

  private planVertical(s: number): void {
    const def = biome(this.biomeCurrent);
    const limit = def.gradeLimit / 1000;

    // Aim for the biome's characteristic elevation, but wander on the way.
    const error = this.targetElevation - this.head.y;
    const wander = this.wobble.fbm(s * 0.0006, 3) * limit * 0.55;
    let g = clamp(error / 900 + wander, -limit, limit);

    // Stations are level; approaching one, flatten out.
    if (Math.abs(this.nextStationS - s) < 400) g *= 0.15;
    if (this.stations.some((st) => Math.abs(st.s - s) < 260)) g = 0;

    this.targetGrade = g;
    this.verticalEnd = s + this.rng.range(220, 700);

    if (this.rng.chance(0.25)) this.targetElevation = this.pickElevationTarget();
  }

  private placeStation(s: number): void {
    const def = biome(this.biomeCurrent);
    const b = this.biomeCurrent;
    const name = generateStationName(this.rng, b, this.usedNames);
    const platformLength = this.rng.pick([90, 110, 130, 160]);

    // Timetable: run time from the previous station at a realistic average.
    const distance = Math.max(400, s - this.lastStationS);
    const avg = (def.lineSpeed * 0.62) / MS_TO_KMH;
    const runTime = distance / avg + 55;
    const dwell = b === 'city' || b === 'suburb' ? this.rng.range(30, 60) : this.rng.range(18, 40);
    const arrival = this.lastDeparture + runTime;

    const station: StationInfo = {
      index: this.stationCounter++,
      s,
      name,
      platformSide: this.rng.chance(0.35) ? 0 : this.rng.chance(0.5) ? -1 : 1,
      platformLength,
      scheduledArrival: arrival,
      scheduledDeparture: arrival + dwell,
      dwell,
      biome: b,
      hasCanopy: this.rng.chance(b === 'city' || b === 'suburb' ? 0.95 : 0.55),
      hasFootbridge: this.rng.chance(b === 'city' ? 0.8 : 0.3),
      served: false,
    };
    this.stations.push(station);
    this.lastDeparture = station.scheduledDeparture;
    this.lastStationS = s;

    const spacingBase = 2600 / clamp(def.stationBias, 0.3, 2.2);
    this.nextStationS = s + this.rng.range(spacingBase * 0.7, spacingBase * 1.6);

    // Home signal protecting the platform.
    this.signals.push({ s: s - platformLength * 0.5 - 60, side: 1, kind: 'home', aspect: 2 });
  }

  private placeSignal(s: number): void {
    this.signals.push({ s, side: 1, kind: 'block', aspect: 2 });
    this.nextSignalS = s + this.rng.range(650, 1300);
  }

  private placeCrossing(s: number): void {
    const def = biome(this.biomeCurrent);
    const density = def.roadDensity;
    if (density > 0.25 && this.structureAt(s) === STRUCT_GROUND && this.rng.chance(density * 0.7)) {
      this.crossings.push({
        s,
        width: this.rng.range(5, 11),
        skew: this.rng.range(-0.5, 0.5),
        grade: this.rng.next(),
      });
    }
    this.nextCrossingS = s + this.rng.range(300, 900) / clamp(density, 0.15, 2);
  }

  private considerStructure(s: number): void {
    this.nextStructureCheck = s + 300;
    if (s < this.tunnelUntil || s < this.bridgeUntil) return;
    if (this.stations.some((st) => Math.abs(st.s - s) < 500)) return;
    if (this.nextStationS - s < 500) return;

    const def = biome(this.biomeCurrent);

    // Tunnels where the line would otherwise have to climb over a ridge.
    if ((def.id === 'mountain' && this.rng.chance(0.34)) || (def.id === 'forest' && this.rng.chance(0.08))) {
      const length = this.rng.range(260, 900);
      this.tunnelUntil = s + length;
      this.tunnels.push({ sStart: s, sEnd: s + length });
      this.targetCurvature = 0;
      this.segmentEnd = s + length;
      return;
    }

    // River crossings, on a girder or truss bridge.
    const riverChance =
      def.id === 'riverside' ? 0.5 : def.id === 'farmland' ? 0.16 : def.id === 'city' ? 0.14 : 0.08;
    if (this.rng.chance(riverChance)) {
      const width = this.rng.range(40, 190);
      const skew = this.rng.range(-0.5, 0.5);
      // The span has to clear the bed measured along the line, not across the
      // channel: a skewed crossing is longer than the river is wide, and a
      // bridge that stops short leaves the formation standing in the water.
      const bridgeLength = width / Math.cos(skew) + this.rng.range(46, 110);
      this.rivers.push({
        s: s + bridgeLength * 0.5,
        width,
        skew,
        bankHeight: this.rng.range(3, 9),
      });
      this.bridges.push({
        sStart: s,
        sEnd: s + bridgeLength,
        height: this.rng.range(8, 22),
        kind: width > 130 ? 'truss' : width > 70 ? 'girder' : 'viaduct',
      });
      this.bridgeUntil = s + bridgeLength;
      this.targetCurvature = 0;
      this.segmentEnd = s + bridgeLength;
      this.targetGrade = 0;
      this.verticalEnd = s + bridgeLength;
    }
  }
}

const scratchSample: TrackSample = {
  s: 0,
  x: 0,
  y: 0,
  z: 0,
  heading: 0,
  grade: 0,
  curvature: 0,
  cant: 0,
  speedLimit: 0,
  weights: new Float32Array(BIOME_IDS.length),
  seaSide: 0,
  riverSide: 0,
  riverStrength: 0,
  structure: STRUCT_GROUND,
  stationZone: 0,
};

/** Shortest signed angular difference from a to b. */
export function shortestAngle(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Unit forward vector of a sample. */
export function forwardOf(sample: TrackSample, out = new Vector3()): Vector3 {
  const c = Math.cos(sample.grade === 0 ? 0 : Math.atan(sample.grade));
  return out.set(Math.cos(sample.heading) * c, Math.sin(Math.atan(sample.grade)), Math.sin(sample.heading) * c).normalize();
}

/** Unit right vector of a sample (in the horizontal plane, then canted). */
export function rightOf(sample: TrackSample, out = new Vector3()): Vector3 {
  return out.set(-Math.sin(sample.heading), 0, Math.cos(sample.heading));
}

/**
 * Converts (chainage, lateral offset, height) to world space, honouring cant so
 * that objects fixed to the track roll with it.
 */
export function offsetPosition(
  sample: TrackSample,
  lateral: number,
  height: number,
  out = new Vector3(),
): Vector3 {
  const rx = -Math.sin(sample.heading);
  const rz = Math.cos(sample.heading);
  const cosC = Math.cos(sample.cant);
  const sinC = Math.sin(sample.cant);
  // Rotate the lateral/vertical offset about the forward axis by the cant.
  const lat = lateral * cosC - height * sinC;
  const up = lateral * sinC + height * cosC;
  out.set(sample.x + rx * lat, sample.y + up, sample.z + rz * lat);
  return out;
}
