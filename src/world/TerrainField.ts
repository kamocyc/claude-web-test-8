import { BIOME_IDS, BIOME_INDEX, SEA_LEVEL, TerrainNoise, blendedElevation, blendedAttr } from './Biome';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';
import { SAMPLE_STEP, STRUCT_BRIDGE, STRUCT_TUNNEL, TrackPath, type TrackSample } from './TrackPath';

/** Top of the formation (bottom of the ballast) relative to the rail head. */
export const FORMATION_DROP = 0.9;
/** Half width of the level formation either side of the centre line. */
export const FORMATION_HALF = 5.6;
/** Lateral reach of the detailed track-space corridor mesh. */
export const CORRIDOR_HALF = 110;
/**
 * Half width of the slot left open along a tunnel bore.
 *
 * The ground is a height field, so it cannot arch over anything: were it
 * allowed to close across the line inside a tunnel it would appear as a wall
 * hanging in the bore. Instead the formation is carried straight through and
 * `buildTunnels` caps the slot over with a piece of hillside.
 */
export const BORE_HALF = 7.4;
/** Least thickness of ground carried over a bore, above the rail head. */
export const TUNNEL_COVER = 10;
/** Distance over which the hill a tunnel is bored through rises, metres. */
const RIDGE_RAMP = 170;

export interface ProjectionResult {
  /** Chainage of the nearest point on the centre line. */
  s: number;
  /** Signed distance from the centre line, positive to the right. */
  lateral: number;
  /** Index of the nearest stored sample, reusable as the next search hint. */
  hint: number;
}

/**
 * The ground.
 *
 * Anything that needs to know how high the land is - terrain tiles, scattered
 * trees, buildings, water surfaces - asks this class, so every system agrees
 * on the same surface. Heights are a pure function of world position, which is
 * what makes chunked and tiled geometry line up seamlessly.
 */
export class TerrainField {
  private coarse: number[] = [];
  private coarseStride = 32; // samples between coarse index entries (64 m)
  private indexedTo = -1;
  private indexedFrom = -1;

  private readonly scratch: TrackSample = {
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
    structure: 0,
    stationZone: 0,
  };

  constructor(
    readonly track: TrackPath,
    readonly noise: TerrainNoise,
  ) {
    this.rebuildIndex();
  }

  /** Refreshes the coarse projection index after the route grows or is pruned. */
  rebuildIndex(): void {
    const count = this.track.sampleCount;
    const base = this.track.baseS;
    if (this.indexedTo === count && this.indexedFrom === base) return;
    this.coarse.length = 0;
    for (let i = 0; i < count; i += this.coarseStride) this.coarse.push(i);
    if (this.coarse[this.coarse.length - 1] !== count - 1) this.coarse.push(count - 1);
    this.indexedTo = count;
    this.indexedFrom = base;
  }

  /**
   * Projects a world position onto the centre line.
   * Pass the previous result's `hint` when querying a coherent run of points -
   * it turns the search into a short local scan.
   */
  project(x: number, z: number, hint = -1, out?: ProjectionResult): ProjectionResult {
    const track = this.track;
    const count = track.sampleCount;
    let best = -1;
    let bestDist = Infinity;

    if (hint >= 0) {
      const lo = Math.max(0, hint - 48);
      const hi = Math.min(count - 1, hint + 48);
      for (let i = lo; i <= hi; i++) {
        const sm = track.at(i);
        const d = (sm.x - x) * (sm.x - x) + (sm.z - z) * (sm.z - z);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      // If the hint region did not contain a clear minimum, fall through to the
      // coarse search below.
      if (best > lo && best < hi) return this.refine(x, z, best, out);
    }

    for (const i of this.coarse) {
      const sm = track.at(i);
      const d = (sm.x - x) * (sm.x - x) + (sm.z - z) * (sm.z - z);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return this.refine(x, z, Math.max(0, best), out);
  }

  private refine(x: number, z: number, start: number, out?: ProjectionResult): ProjectionResult {
    const track = this.track;
    const count = track.sampleCount;
    const lo = Math.max(0, start - this.coarseStride);
    const hi = Math.min(count - 1, start + this.coarseStride);
    let best = start;
    let bestDist = Infinity;
    for (let i = lo; i <= hi; i++) {
      const sm = track.at(i);
      const d = (sm.x - x) * (sm.x - x) + (sm.z - z) * (sm.z - z);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    const sm = track.at(best);
    const dx = x - sm.x;
    const dz = z - sm.z;
    const fx = Math.cos(sm.heading);
    const fz = Math.sin(sm.heading);
    const along = dx * fx + dz * fz;
    const lateral = dx * -Math.sin(sm.heading) + dz * Math.cos(sm.heading);
    const result = out ?? { s: 0, lateral: 0, hint: 0 };
    result.s = sm.s + clamp(along, -SAMPLE_STEP * 2, SAMPLE_STEP * 2);
    result.lateral = lateral;
    result.hint = best;
    return result;
  }

  /** Interpolated track sample, reusing an internal scratch object. */
  sampleAt(s: number): TrackSample {
    return this.track.sampleAt(s, this.scratch);
  }

  /**
   * Natural ground level, ignoring anything the railway did to it.
   * `sample` must correspond to `s`.
   */
  natural(sample: TrackSample, lateral: number, x: number, z: number): number {
    let h = blendedElevation(
      sample.weights,
      {
        lateral,
        trackY: sample.y,
        worldX: x,
        worldZ: z,
        seaSide: sample.seaSide,
        riverSide: sample.riverSide,
        riverStrength: sample.riverStrength,
      },
      this.noise,
    );

    h = this.liftAboveSea(h, sample);
    h = this.carveRivers(h, sample, lateral, x, z);
    h = this.raiseTunnelRidge(h, sample, lateral, x, z);
    return h;
  }

  /**
   * Inland ground is not below the sea.
   *
   * Relief is expressed relative to the rail head, so a low-lying stretch of
   * farmland could dip its fields a metre or two under sea level - and then
   * the open sea, which is only ever a plane at zero, would be drawn flooding
   * a valley thirty kilometres from the coast. Away from a coastal stretch the
   * ground is raised onto a floor just above the waterline; the join is a
   * smooth maximum, so the plain rises into it rather than meeting it as a
   * flat pan with a visible edge.
   */
  private liftAboveSea(h: number, sample: TrackSample): number {
    const coastal = sample.weights[BIOME_INDEX.coast];
    const floor = SEA_LEVEL + 1.8 * (1 - smoothstep(0.04, 0.45, coastal));
    if (floor <= SEA_LEVEL) return h;
    const d = h - floor;
    return floor + 0.5 * (d + Math.sqrt(d * d + 1.2));
  }

  /**
   * How much a point behaves like a waterside: silt, sand and weed rather than
   * turf. Height alone is not enough - a field at half a metre is still a
   * field - so this asks whether there is actually water to be beside.
   */
  shoreFactor(sample: TrackSample, lateral: number, y: number): number {
    const above = y - SEA_LEVEL;
    // The foreshore proper, on the seaward side of a coastal stretch.
    const seaward = sample.seaSide !== 0 ? lateral * sample.seaSide : -1e3;
    const coastal =
      smoothstep(0.06, 0.4, sample.weights[BIOME_INDEX.coast]) * smoothstep(-40, 40, seaward);
    const band = (1 - smoothstep(0.5, 4.2, above)) * smoothstep(-3.0, 0.5, above);
    const sea = coastal * (band * 1.2 + (above < 0 ? 0.85 : 0));

    // The bank of a lineside canal or drain silts up in the same way.
    const canal = clamp01(sample.riverStrength);
    let bank = 0;
    if (canal > 0.02) {
      const centre = sample.riverSide * (46 + this.noise.hills.sample(sample.s * 0.0015, 3.1) * 26);
      const width = 9 + this.noise.detail.sample(sample.s * 0.004, 7.7) * 5;
      bank = canal * (1 - smoothstep(width * 0.6, width * 2.0, Math.abs(lateral - centre)));
    }
    return clamp01(Math.max(sea, bank * 0.8));
  }

  /**
   * The hillside a tunnel is driven through.
   *
   * A bore only makes sense if there is something above it, so the ground is
   * lifted into a ridge over the tunnel and for a way either side of it. The
   * ramp reaches its full height exactly at the portal, which is what lets the
   * line run into the hill through a cutting that deepens naturally instead of
   * meeting a step in the ground.
   */
  private raiseTunnelRidge(h: number, sample: TrackSample, lateral: number, x: number, z: number): number {
    const s = sample.s;
    let out = h;
    for (const tunnel of this.track.tunnels) {
      if (s < tunnel.sStart - RIDGE_RAMP || s > tunnel.sEnd + RIDGE_RAMP) continue;
      const ramp = Math.min(
        smoothstep(tunnel.sStart - RIDGE_RAMP, tunnel.sStart, s),
        smoothstep(tunnel.sEnd + RIDGE_RAMP, tunnel.sEnd, s),
      );
      const ax = Math.abs(lateral);
      // The crest clears the bore over the line and climbs away from it, so the
      // tunnel reads as a spur of the hillside rather than a lump on the map.
      const relief =
        38 * smoothstep(0, 300, ax) +
        Math.max(0, this.noise.ridges.fbm(x * 0.0026, z * 0.0026, 3)) * 22 * smoothstep(0, 90, ax);
      const crest = sample.y + TUNNEL_COVER + relief;
      out += ramp * Math.max(0, crest - out);
    }
    return out;
  }

  /** How far `s` is inside the tunnel containing it; 0 when it is outside one. */
  private mouthDistance(s: number): number {
    for (const tunnel of this.track.tunnels) {
      if (s >= tunnel.sStart && s <= tunnel.sEnd) {
        return Math.max(0, Math.min(s - tunnel.sStart, tunnel.sEnd - s));
      }
    }
    return 0;
  }

  /**
   * Height of the ground carried over a bore: the hillside as it would be with
   * no slot cut in it. `buildTunnels` caps the slot at exactly this height, so
   * the cap and the terrain meet without a seam.
   */
  tunnelCoverHeight(sample: TrackSample, lateral: number, x: number, z: number): number {
    return Math.max(this.natural(sample, lateral, x, z), sample.y + TUNNEL_COVER);
  }

  /** Cuts river channels and lineside canals into the natural surface. */
  private carveRivers(h: number, sample: TrackSample, lateral: number, x: number, z: number): number {
    const s = sample.s;

    // Rivers the line crosses on a bridge.
    //
    // A Japanese river of any size is not a canal: it is a wide gravel bed
    // between raised levees, dry over most of its width, with the low flow
    // threading through it in one or two braided channels. Cutting it as a
    // flat trough is what turns a river crossing into a lake, so the bed is
    // built from bars and channels instead.
    for (const river of this.track.rivers) {
      const ds = s - river.s;
      if (Math.abs(ds) > river.width * 2.2 + 220) continue;
      // The river runs across the alignment at an angle.
      const dist = Math.abs(ds - lateral * Math.tan(river.skew)) * Math.cos(river.skew);
      const half = river.width * 0.5;
      if (dist > half + 120) continue;

      // The water surface the bridge and the water mesh are both built to.
      const waterY = sample.y - river.bankHeight - 3.0;
      // Gravel bars: shingle standing just clear of the water, with the coarse
      // undulation that shingle always has.
      const bars = this.noise.detail.fbm(x * 0.011, z * 0.011, 2) * 1.6;
      const barY = waterY + 1.1 + bars;

      // Two low channels that wander across the bed rather than running
      // straight, so the water threads instead of pooling.
      const wander = this.noise.hills.fbm(x * 0.0032, z * 0.0032, 2) * half * 0.5;
      const main = 1 - smoothstep(river.width * 0.055, river.width * 0.2, Math.abs(dist - (half * 0.28 + wander)));
      const side = 1 - smoothstep(river.width * 0.04, river.width * 0.15, Math.abs(dist - (half * 0.74 - wander * 0.7)));
      const channel = Math.max(main, side * 0.75);
      const bed = barY - channel * (2.4 + river.bankHeight * 0.14);

      const bank = smoothstep(half * 0.92, half + 60, dist);
      h = lerp(bed, h, bank);

      // The levee: an embankment carrying a maintenance road along each side,
      // held off the alignment so it never fouls the formation.
      const crest = Math.exp(-Math.pow((dist - (half + 34)) / 26, 2));
      h += crest * river.bankHeight * 0.4 * smoothstep(34, 95, Math.abs(lateral));
    }

    // A drainage canal running beside the line through flat country.
    const canal = sample.riverStrength;
    if (canal > 0.02) {
      const centre = sample.riverSide * (46 + this.noise.hills.sample(s * 0.0015, 3.1) * 26);
      const width = 9 + this.noise.detail.sample(s * 0.004, 7.7) * 5;
      const dist = Math.abs(lateral - centre);
      if (dist < width * 3) {
        const depth = 2.6 * canal;
        const t = smoothstep(width * 0.5, width * 1.5, dist);
        h = lerp(h - depth, h, t);
      }
    }
    return h;
  }

  /**
   * Finished ground level: natural terrain reshaped by the railway formation
   * (embankment, cutting, tunnel cover). This is what the terrain mesh uses.
   */
  ground(sample: TrackSample, lateral: number, x: number, z: number, forTiles = false): number {
    const nat = this.natural(sample, lateral, x, z);
    const ax = Math.abs(lateral);
    // Coarse LOD tiles cannot resolve the earthworks, so they are sunk very
    // slightly near the line where the fine corridor mesh covers them. The
    // ramp reaches zero before the corridor edge, so nothing is left exposed.
    const tileBias = forTiles ? -0.45 * (1 - smoothstep(CORRIDOR_HALF * 0.6, CORRIDOR_HALF, ax)) : 0;

    if (sample.structure === STRUCT_BRIDGE) {
      // Nothing is built up under a bridge; keep the valley floor.
      return nat + tileBias;
    }

    if (sample.structure === STRUCT_TUNNEL) {
      // Inside a bore the ground keeps the formation and opens out to the slot
      // the bore needs, then climbs the hillside on the same 1:1.65 batter the
      // approach cutting uses. At the portal the slot is exactly as wide as the
      // cutting outside it, so the two meet without a step.
      const hill = Math.max(nat, sample.y + TUNNEL_COVER);
      const formationY = sample.y - FORMATION_DROP;
      const mouth = smoothstep(0, 26, this.mouthDistance(sample.s));
      // At the mouth the slot is the approach cutting itself, batter and all;
      // away from the portal it closes to the least the bore needs, so the cap
      // over it stays small.
      const batter = clamp(Math.abs(hill - formationY) * 1.65, 4, 70);
      const slopeWidth = lerp(batter, 5, mouth);
      const half = lerp(FORMATION_HALF, BORE_HALF, mouth);
      return lerp(formationY, hill, smoothstep(half, half + slopeWidth, ax)) + tileBias;
    }

    const formationY = sample.y - FORMATION_DROP;
    const diff = nat - formationY;
    // Side slopes are roughly 1:1.6, so the wider the height difference the
    // further out the earthworks reach.
    const slopeWidth = clamp(Math.abs(diff) * 1.65, 4, 70);
    const t = smoothstep(FORMATION_HALF, FORMATION_HALF + slopeWidth, ax);
    let h = lerp(formationY, nat, t);

    // Station forecourts are graded flat.
    if (sample.stationZone > 0.01 && ax < 70) {
      const flat = sample.stationZone * (1 - smoothstep(24, 70, ax));
      h = lerp(h, formationY - 0.9, flat * 0.85);
    }
    return h + tileBias;
  }

  /** Ground level at an arbitrary world position. */
  heightAt(x: number, z: number, hint = -1): { y: number; projection: ProjectionResult } {
    const projection = this.project(x, z, hint);
    const sample = this.sampleAt(projection.s);
    return { y: this.ground(sample, projection.lateral, x, z), projection };
  }

  /** Depth of standing sea water at a world position (0 when dry). */
  seaDepthAt(x: number, z: number, hint = -1): number {
    const { y } = this.heightAt(x, z, hint);
    return Math.max(0, SEA_LEVEL - y);
  }

  /** Average haze of the biomes around a chainage, for the fog. */
  hazeAt(s: number): number {
    const sample = this.sampleAt(s);
    return blendedAttr(sample.weights, 'haze');
  }
}
