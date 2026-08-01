/**
 * Deterministic randomness and coherent noise.
 *
 * Everything in the world is derived from a single 32-bit seed so a route can
 * be reproduced exactly: the same seed always yields the same 8000 km of track,
 * the same station names and the same trees in the same fields.
 */

/** Fast, well distributed 32 bit PRNG (mulberry32). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    // Discard a few values so nearby seeds diverge immediately.
    this.next();
    this.next();
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with the given probability. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  /** Picks an index from a weight table. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return i;
    }
    return weights.length - 1;
  }

  /** Approximately normal distribution via the Box-Muller transform. */
  gaussian(mean = 0, stdev = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + stdev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }
}

/** Integer hash used to seed sub-generators from world coordinates. */
export function hashInt(...values: number[]): number {
  let h = 0x811c9dc5;
  for (const v of values) {
    let x = Math.imul(v | 0, 0x27d4eb2d);
    x ^= x >>> 15;
    h = Math.imul(h ^ x, 0x85ebca6b);
    h ^= h >>> 13;
  }
  return h >>> 0;
}

/** Hash to a float in [0, 1). */
export function hashFloat(...values: number[]): number {
  return hashInt(...values) / 4294967296;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function grad2(hash: number, x: number, y: number): number {
  // 8 gradient directions, selected by the low bits of the hash.
  const h = hash & 7;
  const u = h < 4 ? x : y;
  const v = h < 4 ? y : x;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? 2 * v : -2 * v);
}

/**
 * Seedable 2D gradient (Perlin) noise. Output is roughly in [-1, 1].
 * Deterministic across machines: no permutation table, just integer hashing.
 */
export class Noise2D {
  constructor(private readonly seed: number) {}

  sample(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = fade(xf);
    const v = fade(yf);

    const aa = hashInt(xi, yi, this.seed);
    const ba = hashInt(xi + 1, yi, this.seed);
    const ab = hashInt(xi, yi + 1, this.seed);
    const bb = hashInt(xi + 1, yi + 1, this.seed);

    const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
    const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v) * 0.7;
  }

  /** Fractal Brownian motion: layered octaves of the base noise. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.sample(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal - sharp crests, good for mountain spines. */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2.0, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.sample(x * freq, y * freq)) * 1.6;
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return (sum / norm) * 2 - 1;
  }

  /** Billowy noise - rounded lumps, good for hills and foliage volume. */
  billow(x: number, y: number, octaves = 4): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * (Math.abs(this.sample(x * freq, y * freq)) * 2 - 1);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}

/** 1D value noise with smooth interpolation - used for slow parameter drifts. */
export class Noise1D {
  constructor(private readonly seed: number) {}

  sample(x: number): number {
    const xi = Math.floor(x);
    const xf = x - xi;
    const a = hashFloat(xi, this.seed) * 2 - 1;
    const b = hashFloat(xi + 1, this.seed) * 2 - 1;
    return lerp(a, b, fade(xf));
  }

  fbm(x: number, octaves = 3): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.sample(x * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }
}
