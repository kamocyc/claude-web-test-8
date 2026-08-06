import { Noise2D } from '../../core/Random';

/**
 * The same gradient noise, without the allocation.
 *
 * `Noise2D` hashes its lattice corners through a variadic helper, so every
 * corner of every octave allocates a small array. The terrain asks for tens of
 * millions of these while it streams, and that allocation - not the arithmetic
 * - is what dominates the cost of building a tile.
 *
 * This subclass overrides only the base sample with a hand-inlined three
 * argument hash. It is the same function: same seed, same lattice, same output
 * to the last bit, so the world it generates is identical.
 */
export class FastNoise2D extends Noise2D {
  private readonly s: number;

  constructor(seed: number) {
    super(seed);
    this.s = seed;
  }

  override sample(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const seed = this.s;

    const aa = hash3(xi, yi, seed);
    const ba = hash3(xi + 1, yi, seed);
    const ab = hash3(xi, yi + 1, seed);
    const bb = hash3(xi + 1, yi + 1, seed);

    const g0 = grad(aa, xf, yf);
    const g1 = grad(ba, xf - 1, yf);
    const g2 = grad(ab, xf, yf - 1);
    const g3 = grad(bb, xf - 1, yf - 1);

    const x1 = g0 + (g1 - g0) * u;
    const x2 = g2 + (g3 - g2) * u;
    return (x1 + (x2 - x1) * v) * 0.7;
  }
}

/** `hashInt(a, b, c)` with the argument array unrolled away. */
function hash3(a: number, b: number, c: number): number {
  let h = 0x811c9dc5;
  let x = Math.imul(a | 0, 0x27d4eb2d);
  x ^= x >>> 15;
  h = Math.imul(h ^ x, 0x85ebca6b);
  h ^= h >>> 13;
  x = Math.imul(b | 0, 0x27d4eb2d);
  x ^= x >>> 15;
  h = Math.imul(h ^ x, 0x85ebca6b);
  h ^= h >>> 13;
  x = Math.imul(c | 0, 0x27d4eb2d);
  x ^= x >>> 15;
  h = Math.imul(h ^ x, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Eight gradient directions selected by the low bits of the hash. */
function grad(hash: number, x: number, y: number): number {
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? 2 * v : -2 * v);
}
