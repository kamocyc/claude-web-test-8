import { BIOME_IDS, BIOME_INDEX, SEA_LEVEL, TerrainNoise, blendedElevation, blendedAttr } from './Biome';
import { clamp, clamp01, lerp, smoothstep } from '../core/MathUtils';
import { riverAxis, riverGround, sampleRiver } from './River';
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

/**
 * Water level of the lineside drainage canal.
 *
 * A level surface, not a constant depth below the ground: a canal that follows
 * every ripple in the field it drains is a canal running uphill.
 */
export function canalLevel(sample: TrackSample): number {
  return sample.y - 1.4;
}

/** Lateral offset of the lineside canal from the centre line. */
export function canalCentre(sample: TrackSample, noise: TerrainNoise): number {
  return sample.riverSide * (46 + noise.hills.sample(sample.s * 0.0015, 3.1) * 26);
}

/** Width of the lineside canal at a chainage. */
export function canalWidth(sample: TrackSample, noise: TerrainNoise): number {
  return 9 + noise.detail.sample(sample.s * 0.004, 7.7) * 5;
}

export interface ProjectionResult {
  /** Chainage of the nearest point on the centre line. */
  s: number;
  /** Signed distance from the centre line, positive to the right. */
  lateral: number;
  /** Index of the nearest stored sample, reusable as the next search hint. */
  hint: number;
  /**
   * How far the point lies beyond the end of the generated route, metres.
   *
   * Track space only exists where there is track. Past the last sample every
   * point in the world projects onto that one sample, so anything expressed in
   * chainage - the earthworks, a tunnel ridge, a lineside canal - would be
   * smeared across the entire horizon. This says how much to believe the
   * projection, and everything in track space fades out with it.
   */
  beyond: number;
}

/** Distance past the end of the route over which track space stops applying. */
const TRACK_SPACE_FADE = 220;

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
    beyond: 0,
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
  project(x: number, z: number, hint = -1, out?: ProjectionResult, window = 48): ProjectionResult {
    const track = this.track;
    const count = track.sampleCount;
    let best = -1;
    let bestDist = Infinity;

    if (hint >= 0) {
      const lo = Math.max(0, hint - window);
      const hi = Math.min(count - 1, hint + window);
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
      if (best > lo && best < hi) return this.refine(x, z, best, out, window);
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

  private refine(
    x: number,
    z: number,
    start: number,
    out?: ProjectionResult,
    window = this.coarseStride,
  ): ProjectionResult {
    const track = this.track;
    const count = track.sampleCount;
    const span = Math.max(6, Math.min(this.coarseStride, window));
    const lo = Math.max(0, start - span);
    const hi = Math.min(count - 1, start + span);
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
    const result = out ?? { s: 0, lateral: 0, hint: 0, beyond: 0 };
    result.s = sm.s + clamp(along, -SAMPLE_STEP * 2, SAMPLE_STEP * 2);
    result.lateral = lateral;
    result.hint = best;
    // Only the two end samples can be a projection that ran out of route; in
    // the middle the nearest sample is genuinely the nearest point on the line.
    result.beyond =
      best === 0 ? Math.max(0, -along) : best === count - 1 ? Math.max(0, along) : 0;
    return result;
  }

  /**
   * How much of the track-space shaping applies at a projection: 1 beside the
   * line, falling to 0 past the ends of the generated route.
   */
  private validity(sample: TrackSample): number {
    const beyond = sample.beyond ?? 0;
    return beyond > 0 ? 1 - smoothstep(0, TRACK_SPACE_FADE, beyond) : 1;
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
    const canal = clamp01(sample.riverStrength * this.validity(sample));
    let bank = 0;
    if (canal > 0.02) {
      const centre = canalCentre(sample, this.noise);
      const width = canalWidth(sample, this.noise);
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
    const ax = Math.abs(lateral);
    // The ridge is the hillside the bore is driven through, so it belongs to
    // the line: it is worthless past the end of the route, and beyond a few
    // hundred metres either side it would be lifting the whole horizon.
    const reach = this.validity(sample) * (1 - smoothstep(420, 900, ax));
    if (reach <= 0.002) return h;
    let out = h;
    for (const tunnel of this.track.tunnels) {
      if (s < tunnel.sStart - RIDGE_RAMP || s > tunnel.sEnd + RIDGE_RAMP) continue;
      const ramp =
        reach *
        Math.min(
          smoothstep(tunnel.sStart - RIDGE_RAMP, tunnel.sStart, s),
          smoothstep(tunnel.sEnd + RIDGE_RAMP, tunnel.sEnd, s),
        );
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

  /** Cuts river valleys and lineside canals into the natural surface. */
  private carveRivers(h: number, sample: TrackSample, lateral: number, x: number, z: number): number {
    // Rivers the line crosses on a bridge. These are world-space features:
    // where the bed lies has nothing to do with where the railway happens to
    // be, which is exactly why they used to run off into the distance as a
    // flat pan the moment the route ran out.
    for (const river of this.track.rivers) {
      const axis = riverAxis(this.track, river);
      const r = sampleRiver(axis, x, z, this.noise);
      if (!r) continue;
      let influence = r.strength;
      // The line crosses its river on a bridge and nowhere else. If the
      // alignment curls back over the same channel further along, the
      // formation wins and the water goes through a culvert under it.
      if (sample.structure !== STRUCT_BRIDGE) {
        influence *= smoothstep(12, 44, Math.abs(lateral));
      }
      h = riverGround(h, r, x, z, axis, this.noise, influence);
    }

    // A drainage canal running beside the line through flat country. This one
    // really is a feature of the railway - it is the line's own drain - so it
    // stays in track space, and dies with it.
    const canal = sample.riverStrength * this.validity(sample);
    if (canal > 0.02) {
      const centre = canalCentre(sample, this.noise);
      const width = canalWidth(sample, this.noise);
      const dist = Math.abs(lateral - centre);
      if (dist < width * 3) {
        // Cut to a level bed rather than a constant depth below the ground, or
        // the water surface laid on top of it inherits every ripple in the
        // field it crosses.
        const bed = canalLevel(sample) - 1.5;
        const t = smoothstep(width * 0.5, width * 1.6, dist);
        h = lerp(Math.min(h, bed), h, t);
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
    // No route here, no earthworks: past the end of what has been generated the
    // ground is simply the country, or the formation would be extruded across
    // the whole horizon from the last sample of track.
    const built = this.validity(sample);
    if (built <= 0.002) return nat;
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
    return lerp(nat, h, built) + tileBias;
  }

  /** Interpolated track sample for a projection, carrying its validity. */
  sampleFor(projection: ProjectionResult): TrackSample {
    const sample = this.track.sampleAt(projection.s, this.scratch);
    sample.beyond = projection.beyond;
    return sample;
  }

  /** Ground level at an arbitrary world position. */
  heightAt(x: number, z: number, hint = -1): { y: number; projection: ProjectionResult } {
    const projection = this.project(x, z, hint);
    const sample = this.sampleFor(projection);
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
