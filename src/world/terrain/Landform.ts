import type { Noise2D } from '../../core/Random';
import { clamp, lerp } from '../../core/MathUtils';

/**
 * Landform primitives.
 *
 * Fractal noise on its own makes lumps: every hill the same size, every slope
 * the same slope, no direction to anything. Real ground has been rained on. It
 * has crests where the rock stood up to it, spurs running down off those
 * crests, gullies cut into the spurs, and the material out of all of that piled
 * up in fans at the bottom. These are the pieces that put that structure back.
 *
 * Everything here is a pure function of position - no grid, no simulation - so
 * the height field stays samplable at any point in any order, which is what
 * chunked streaming needs.
 */

/** Coordinate rotation used to stop octaves lining up on the axes. */
const ROT_C = Math.cos(0.7854);
const ROT_S = Math.sin(0.7854);

/**
 * Musgrave's ridged multifractal.
 *
 * Each octave is weighted by how high the octave above it stood, so detail
 * gathers along the crests and the flanks stay smooth - which is exactly the
 * signature of a mountain that water has worked on. Returns roughly 0..1.
 */
export function ridgedMulti(n: Noise2D, x: number, y: number, octaves: number, lacunarity = 2.04): number {
  let px = x;
  let py = y;
  let signal = 1 - Math.abs(n.sample(px, py)) * 1.6;
  signal *= signal;
  let result = signal;
  let weight = 1;
  let amp = 0.52;
  let norm = 1;

  for (let i = 1; i < octaves; i++) {
    px *= lacunarity;
    py *= lacunarity;
    const rx = px * ROT_C - py * ROT_S;
    const ry = px * ROT_S + py * ROT_C;
    px = rx;
    py = ry;
    weight = clamp(signal * 2.2, 0, 1);
    signal = 1 - Math.abs(n.sample(px, py)) * 1.6;
    signal *= signal * weight;
    result += signal * amp;
    norm += amp;
    amp *= 0.52;
  }
  return clamp(result / norm, 0, 1);
}

/**
 * Domain-warped fbm.
 *
 * Warping the lookup by a slower copy of itself bends the hills into ranges
 * instead of leaving them as a field of independent bumps, and costs two
 * samples.
 */
export function warpedFbm(
  n: Noise2D,
  w: Noise2D,
  x: number,
  y: number,
  octaves: number,
  warp = 0.7,
): number {
  const wx = w.sample(x * 0.55, y * 0.55);
  const wy = w.sample(x * 0.55 + 4.3, y * 0.55 - 2.1);
  return n.fbm(x + wx * warp, y + wy * warp, octaves);
}

/**
 * A dendritic drainage network: 1 along the thread of a watercourse, 0 on the
 * ground between. Subtracting it incises gullies; adding a little of it further
 * down spreads the spoil out into a fan.
 */
export function drainage(n: Noise2D, x: number, y: number, octaves = 3): number {
  const v = ridgedMulti(n, x, y, octaves, 2.31);
  // Narrow the lines: only the very top of each ridge becomes a channel.
  const t = clamp((v - 0.42) / 0.58, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Flattens a height field into benches.
 *
 * Steep ground weathers into steps - beds of harder rock standing out, scree
 * gathering on the flats between them - and hillside cultivation cuts the same
 * shape deliberately. `sharpness` above 1 tightens the risers.
 */
export function terrace(h: number, step: number, sharpness = 3): number {
  const f = h / step;
  const base = Math.floor(f);
  let t = f - base;
  // Repeated smoothstep pulls the middle of each tread flat and steepens the
  // riser between them.
  for (let i = 0; i < sharpness; i++) t = t * t * (3 - 2 * t);
  return (base + t) * step;
}

/**
 * A river terrace: the old flood plain left standing as a low bluff above the
 * present one. One long, wandering scarp rather than a fractal edge, which is
 * what makes flat country read as a valley floor instead of a table.
 */
export function terraceScarp(
  n: Noise2D,
  x: number,
  y: number,
  scale: number,
  height: number,
): number {
  const edge = n.fbm(x * scale, y * scale, 3) + n.sample(x * scale * 3.1, y * scale * 3.1) * 0.18;
  const t = clamp(edge * 3.4 + 0.5, 0, 1);
  return height * (t * t * (3 - 2 * t));
}

/**
 * Sediment: material taken off the steep ground has to end up somewhere, so
 * hollows fill and the foot of every slope softens into a fan. Approximated by
 * pulling low ground up towards a local base level.
 */
export function sedimentFill(h: number, base: number, strength: number): number {
  const below = base - h;
  if (below <= 0) return h;
  return h + below * strength;
}

/** Blend helper: how much of a shaped height to use, faded in by distance. */
export function blendAway(value: number, target: number, t: number): number {
  return lerp(value, target, clamp(t, 0, 1));
}
