import { clamp01, lerp, smoothstep } from '../core/MathUtils';
import type { TerrainNoise } from './Biome';
import type { RiverInfo, TrackPath } from './TrackPath';

/**
 * Rivers, in world space.
 *
 * A river is generated as an event on the alignment - the line crosses one at
 * such a chainage, on a bridge of such a length - but a river is not a feature
 * of the railway. Described in track space it inherits everything wrong with
 * track space: it bends with the line, it has no end (the chainage of a point
 * two kilometres out to the side is whatever the nearest sleeper says it is),
 * and past the last generated sample the whole horizon collapses onto one
 * chainage, which is what turned a river into a flat pan covering the distance.
 *
 * So a river is resolved once, at the crossing, into a world-space axis: a
 * point, a downstream direction, a surface level and a fall. Everything after
 * that - the valley cut into the ground, the water surface drawn on it, the
 * gravel bars - is a function of world position alone, which is what makes the
 * terrain and the water agree wherever they are asked.
 */
export interface RiverAxis {
  /** Origin: where the centre line of the river meets the centre line of the railway. */
  ox: number;
  oz: number;
  /** Unit vector downstream. */
  dx: number;
  dz: number;
  /** Unit vector to the left of downstream. */
  nx: number;
  nz: number;
  /** Water surface elevation at the origin. */
  level0: number;
  /** Fall of the water surface per metre downstream. */
  fall: number;
  /** Half width of the gravel bed at the origin. */
  half: number;
  /** Height of the levee crest above the water. */
  bankHeight: number;
  /** Distance along the axis at which the river has faded out entirely. */
  reach: number;
  /** Phase for the meander noise, so two rivers never wander alike. */
  phase: number;
}

/** A world position resolved against a river. */
export interface RiverSample {
  /** Distance downstream of the origin. */
  t: number;
  /** Distance from the (meandering) centre line of the channel. */
  dist: number;
  /** Water surface elevation here. */
  level: number;
  /** Half width of the bed here. */
  half: number;
  /** How much river there still is: 1 at the crossing, 0 at the reach. */
  strength: number;
}

/**
 * Resolves a river into its world axis, once.
 *
 * Rivers are planned before the alignment that carries them has been
 * integrated, so this cannot be done when the river is created; it is done on
 * first use and cached on the river itself. Every consumer therefore sees the
 * same axis, which is the whole point.
 */
export function riverAxis(track: TrackPath, river: RiverInfo): RiverAxis {
  if (river.axis) return river.axis as RiverAxis;
  const sample = track.sampleAt(river.s);
  // The channel crosses the line at the planned skew: square to the alignment
  // turned by the skew angle.
  const angle = sample.heading + Math.PI / 2 + river.skew;
  const dx = Math.cos(angle);
  const dz = Math.sin(angle);
  const axis: RiverAxis = {
    ox: sample.x,
    oz: sample.z,
    dx,
    dz,
    nx: -dz,
    nz: dx,
    level0: sample.y - river.bankHeight - 3.0,
    // A metre of fall per kilometre: enough that the surface is going
    // somewhere, little enough that a two kilometre reach stays in its valley.
    fall: 0.0011,
    half: river.width * 0.5,
    bankHeight: river.bankHeight,
    // Far enough that both ends are lost in the haze rather than ending in
    // mid air somewhere the driver can see.
    reach: 2600,
    phase: (river.s % 997) * 0.031,
  };
  river.axis = axis;
  return axis;
}

/** Lateral wander of the channel at a distance downstream. */
function meander(axis: RiverAxis, t: number, noise: TerrainNoise): number {
  return noise.hills.sample(t * 0.00055 + axis.phase, axis.phase * 3.7) * axis.half * 2.2;
}

/** Water surface elevation a distance downstream. */
export function riverLevelAt(axis: RiverAxis, t: number): number {
  return axis.level0 - t * axis.fall;
}

/** Half width of the bed a distance downstream. */
export function riverHalfAt(axis: RiverAxis, t: number): number {
  return axis.half * (1 - 0.62 * smoothstep(0, axis.reach, Math.abs(t)));
}

/**
 * World position on the river: `t` downstream, `u` across from the centre of
 * the channel. The water surface is drawn from these, so it lands on exactly
 * the bed the terrain carved.
 */
export function riverPoint(
  axis: RiverAxis,
  t: number,
  u: number,
  noise: TerrainNoise,
  out: { x: number; z: number },
): { x: number; z: number } {
  const off = meander(axis, t, noise) + u;
  out.x = axis.ox + axis.dx * t + axis.nx * off;
  out.z = axis.oz + axis.dz * t + axis.nz * off;
  return out;
}

/**
 * Resolves a world position against a river, or null if it is nowhere near it.
 * `reject` is how far outside the valley the caller still cares about.
 */
export function sampleRiver(
  axis: RiverAxis,
  x: number,
  z: number,
  noise: TerrainNoise,
  reject = 140,
): RiverSample | null {
  const px = x - axis.ox;
  const pz = z - axis.oz;
  // Across the channel first, and bounded by how far the meander can ever
  // carry it. This is read once per river for every terrain vertex in the
  // world, so the common answer - "nowhere near" - has to cost four multiplies
  // and no noise.
  const u = px * axis.nx + pz * axis.nz;
  if (Math.abs(u) > axis.half * 2.6 + reject) return null;
  const t = px * axis.dx + pz * axis.dz;
  if (t < -axis.reach || t > axis.reach) return null;
  const dist = Math.abs(u - meander(axis, t, noise));
  // Towards its head the river is younger and narrower; downstream it opens
  // out. Neither end is ever full width, so the taper hides the cut off.
  const half = riverHalfAt(axis, t);
  if (dist > half + reject) return null;
  return {
    t,
    dist,
    level: riverLevelAt(axis, t),
    half,
    strength: 1 - smoothstep(axis.reach * 0.55, axis.reach, Math.abs(t)),
  };
}

/**
 * Ground level inside a river valley.
 *
 * A Japanese river of any size is not a canal: it is a wide gravel bed between
 * raised levees, dry over most of its width, with the low flow threading
 * through it in one or two braided channels. Cutting it as a flat trough is
 * what turns a river crossing into a lake, so the bed is built from bars and
 * channels instead.
 *
 * The result is combined with the natural ground by taking the lower of the
 * two, never by replacing it: a river cuts down into whatever country it finds
 * - a gorge through the mountains, a shallow trench across a plain - and can
 * never raise a wall of its own across a hillside.
 */
export function riverGround(
  natural: number,
  r: RiverSample,
  x: number,
  z: number,
  axis: RiverAxis,
  noise: TerrainNoise,
  influence: number,
): number {
  if (influence <= 0.001) return natural;

  // Shingle standing just clear of the water, with the coarse undulation that
  // shingle always has.
  const bars = noise.detail.fbm(x * 0.011, z * 0.011, 2) * 1.5;
  const barY = r.level + 1.0 + bars;

  // Two low channels that wander across the bed rather than running straight,
  // so the water threads instead of pooling.
  const wander = noise.hills.fbm(x * 0.0032, z * 0.0032, 2) * r.half * 0.5;
  const main = 1 - smoothstep(r.half * 0.06, r.half * 0.22, Math.abs(r.dist - (r.half * 0.3 + wander)));
  const side = 1 - smoothstep(r.half * 0.05, r.half * 0.16, Math.abs(r.dist - (r.half * 0.72 - wander * 0.7)));
  const channel = Math.max(main, side * 0.72);
  const bedY = barY - channel * (2.2 + axis.bankHeight * 0.16);

  // Outside the bed the bank climbs steeply to the levee crest and then the
  // valley side runs away at a much easier grade, so in flat country the cut
  // is a few tens of metres wide and in the hills the natural ground takes
  // over almost at once.
  const above = Math.max(0, r.dist - r.half);
  const crest = axis.bankHeight + 1.5;
  const bank = Math.min(crest, above * 0.85);
  const valley = Math.max(0, above - crest / 0.85) * 0.3;
  const profile = bedY + bank + valley;

  let h = lerp(natural, Math.min(natural, profile), influence);

  // The levee itself: an embankment along each side, but only where there is
  // flat ground to protect. On a hillside there is nothing to hold back.
  const plain = 1 - smoothstep(axis.bankHeight * 1.6, axis.bankHeight * 4, natural - r.level);
  if (plain > 0.01) {
    const band = Math.exp(-Math.pow((r.dist - (r.half + 13)) / 15, 2));
    const leveeY = r.level + axis.bankHeight * 0.85;
    h = Math.max(h, lerp(h, leveeY, band * plain * influence));
  }
  return h;
}

/** Depth of water over the bed at a world position, 0 where the bed is dry. */
export function riverDepth(
  ground: number,
  r: RiverSample,
): number {
  return Math.max(0, r.level - ground);
}

/** How close a world position is to being in a river; 1 in the bed, 0 clear of it. */
export function riverProximity(r: RiverSample, margin: number): number {
  return clamp01(1 - smoothstep(r.half, r.half + margin, r.dist)) * r.strength;
}
