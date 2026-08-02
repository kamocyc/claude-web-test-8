import {
  CanvasTexture,
  DataTexture,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  UnsignedByteType,
} from 'three';
import { hashFloat } from '../core/Random';
import { clamp01, lerp, smoothstep } from '../core/MathUtils';

/**
 * Every texture in the game is synthesised at load time on a 2D canvas.
 *
 * That keeps the build asset-free and lets materials be parameterised (a
 * building facade knows how many floors it has, a station sign knows its own
 * name) while still giving surfaces the grain and variation that sells a
 * photoreal look.
 */

function canvas(size: number, height = size): { c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return { c, ctx };
}

/** Smooth, tileable value noise evaluated on an integer lattice. */
function tileNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const wrap = (n: number) => ((n % period) + period) % period;
  const a = hashFloat(wrap(xi), wrap(yi), seed);
  const b = hashFloat(wrap(xi + 1), wrap(yi), seed);
  const c = hashFloat(wrap(xi), wrap(yi + 1), seed);
  const d = hashFloat(wrap(xi + 1), wrap(yi + 1), seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

function tileFbm(x: number, y: number, period: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let p = period;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tileNoise(x * f, y * f, p * f, seed + i * 97);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Builds a tangent-space normal map from a greyscale height field. */
function normalFromHeight(height: Float32Array, size: number, strength: number): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx;
      let ny = -dy;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * size + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.colorSpace = NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function finish(c: HTMLCanvasElement, srgb = true, repeat = true): CanvasTexture {
  const tex = new CanvasTexture(c);
  if (repeat) tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.colorSpace = srgb ? SRGBColorSpace : NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export class TextureFactory {
  private readonly cache = new Map<string, Texture>();
  private anisotropy = 8;

  setAnisotropy(value: number): void {
    this.anisotropy = value;
    for (const tex of this.cache.values()) tex.anisotropy = value;
  }

  private memo<T extends Texture>(key: string, make: () => T): T {
    const hit = this.cache.get(key);
    if (hit) return hit as T;
    const tex = make();
    tex.anisotropy = this.anisotropy;
    this.cache.set(key, tex);
    return tex;
  }

  // --- ground ------------------------------------------------------------

  /** Track ballast: crushed grey stone with dust between the stones. */
  ballast(): Texture {
    return this.memo('ballast', () => {
      const size = 512;
      const { c, ctx } = canvas(size);
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const cell = tileFbm(x / 10, y / 10, 52, 11, 2);
          const grain = tileNoise(x / 2.2, y / 2.2, 233, 5);
          const dust = tileFbm(x / 48, y / 48, 11, 71, 3);
          let v = 0.34 + cell * 0.42 + grain * 0.22 - dust * 0.12;
          v = clamp01(v);
          const warm = 0.94 + dust * 0.18;
          img.data[i] = v * 232 * warm;
          img.data[i + 1] = v * 226 * (0.98 + dust * 0.1);
          img.data[i + 2] = v * 218;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      // Individual stones catching the light.
      for (let n = 0; n < 2600; n++) {
        const x = hashFloat(n, 1) * size;
        const y = hashFloat(n, 2) * size;
        const r = 1.2 + hashFloat(n, 3) * 3.4;
        const l = 120 + hashFloat(n, 4) * 110;
        ctx.fillStyle = `rgba(${l},${l * 0.98},${l * 0.93},0.55)`;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * (0.6 + hashFloat(n, 5) * 0.6), hashFloat(n, 6) * 3.14, 0, 6.29);
        ctx.fill();
      }
      return finish(c);
    });
  }

  ballastNormal(): Texture {
    return this.memo('ballastN', () => {
      const size = 256;
      const h = new Float32Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          h[y * size + x] = tileFbm(x / 5, y / 5, 52, 11, 3) + tileNoise(x / 1.6, y / 1.6, 160, 5) * 0.5;
        }
      }
      return normalFromHeight(h, size, 3.2);
    });
  }

  /**
   * Generic ground, tinted per biome by vertex colour.
   *
   * Turf is not a flat wash: it is clumps of blades at one scale, dry and lush
   * patches at another, bare soil showing through where it is worn, and the
   * odd stone. All four are here so that the terrain has something to look at
   * at every distance.
   */
  ground(): Texture {
    return this.memo('ground', () => {
      const size = 512;
      const { c, ctx } = canvas(size);
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const patch = tileFbm(x / 60, y / 60, 9, 3, 4);
          const clump = tileFbm(x / 13, y / 13, 40, 51, 3);
          const blade = tileFbm(x / 3.2, y / 3.2, 160, 17, 2);
          const fine = tileNoise(x / 1.5, y / 1.5, 341, 83);
          const soil = smoothstep(0.60, 0.84, patch);
          // Dry, yellower turf in the thinner patches.
          const dry = smoothstep(0.42, 0.78, clump);
          const g = clamp01(0.44 + blade * 0.44 + clump * 0.22 - patch * 0.16 + fine * 0.08);
          let r = lerp(g * 0.66, g * 1.16, soil) * lerp(1, 1.22, dry);
          let b = lerp(g * 0.40, g * 0.70, soil) * lerp(1, 0.82, dry);
          img.data[i] = clamp01(r) * 255;
          img.data[i + 1] = clamp01(g * lerp(1, 0.95, dry)) * 255;
          img.data[i + 2] = clamp01(b) * 255;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      // Small stones and bare scrapes worked into the turf.
      for (let n = 0; n < 420; n++) {
        const x = hashFloat(n, 11) * size;
        const y = hashFloat(n, 12) * size;
        const r = 0.8 + hashFloat(n, 13) * 2.6;
        const l = 92 + hashFloat(n, 14) * 96;
        ctx.fillStyle = `rgba(${l},${l * 0.96},${l * 0.87},${0.25 + hashFloat(n, 15) * 0.4})`;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * (0.55 + hashFloat(n, 16) * 0.7), hashFloat(n, 17) * 3.14, 0, 6.29);
        ctx.fill();
      }
      return finish(c);
    });
  }

  groundNormal(): Texture {
    return this.memo('groundN', () => {
      const size = 256;
      const h = new Float32Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          h[y * size + x] =
            tileFbm(x / 3, y / 3, 84, 33, 3) * 0.85 +
            tileFbm(x / 13, y / 13, 20, 51, 2) * 0.5 +
            tileNoise(x / 1.4, y / 1.4, 180, 83) * 0.25;
        }
      }
      return normalFromHeight(h, size, 2.1);
    });
  }

  /** Bare rock for cliffs and cuttings: bedded strata, broken by jointing. */
  rock(): Texture {
    return this.memo('rock', () => {
      const size = 512;
      const { c, ctx } = canvas(size);
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          // Bedding planes run across; joints cut down through them.
          const bed = tileFbm(x / 110, y / 9, 5, 21, 3);
          const bedLine = smoothstep(0.42, 0.5, Math.abs(((y / 34 + bed * 1.4) % 1) - 0.5));
          const joint = Math.abs(tileFbm(x / 26, y / 34, 20, 45, 3) - 0.5) * 2;
          const grain = tileNoise(x / 2, y / 2, 256, 67);
          const lichen = smoothstep(0.62, 0.86, tileFbm(x / 44, y / 44, 12, 7, 3));
          let v = clamp01(0.28 + bed * 0.34 + joint * 0.3 + grain * 0.12 - bedLine * 0.16);
          const r = v * 172;
          const g = v * 162 * (1 + lichen * 0.12);
          const b = v * 152 * (1 - lichen * 0.12);
          img.data[i] = r;
          img.data[i + 1] = g;
          img.data[i + 2] = b;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return finish(c);
    });
  }

  sand(): Texture {
    return this.memo('sand', () => {
      const size = 256;
      const { c, ctx } = canvas(size);
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const ripple = tileFbm(x / 30, y / 6, 9, 61, 3);
          const grain = tileNoise(x / 1.4, y / 1.4, 180, 7);
          const v = clamp01(0.62 + ripple * 0.22 + grain * 0.16);
          img.data[i] = v * 226;
          img.data[i + 1] = v * 208;
          img.data[i + 2] = v * 178;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return finish(c);
    });
  }

  asphalt(): Texture {
    return this.memo('asphalt', () => {
      const size = 256;
      const { c, ctx } = canvas(size);
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const grain = tileNoise(x / 1.7, y / 1.7, 150, 23);
          const patch = tileFbm(x / 40, y / 40, 7, 13, 3);
          const v = clamp01(0.24 + grain * 0.18 + patch * 0.14);
          img.data[i] = v * 190;
          img.data[i + 1] = v * 188;
          img.data[i + 2] = v * 186;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return finish(c);
    });
  }

  concrete(): Texture {
    return this.memo('concrete', () => {
      const size = 256;
      const { c, ctx } = canvas(size);
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const stain = tileFbm(x / 55, y / 34, 6, 91, 4);
          const grain = tileNoise(x / 2.4, y / 2.4, 120, 3);
          const v = clamp01(0.66 + grain * 0.1 - stain * 0.22);
          img.data[i] = v * 214;
          img.data[i + 1] = v * 212;
          img.data[i + 2] = v * 205;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return finish(c);
    });
  }

  /**
   * Tunnel lining: shuttered concrete, damp streaking down from the crown and
   * soot worked into the pores by seventy years of trains.
   */
  tunnelLining(): Texture {
    return this.memo('tunnelLining', () => {
      const size = 512;
      const { c, ctx } = canvas(size);
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          // Shutter boards run round the bore: bands across the U direction.
          const board = smoothstep(0.0, 0.06, Math.abs(((x % 96) / 96) - 0.5) * 2 - 0.9);
          const grain = tileNoise(x / 2.6, y / 2.6, 100, 17);
          const damp = tileFbm(x / 26, y / 90, 12, 61, 4);
          const soot = tileFbm(x / 70, y / 44, 8, 29, 3);
          const streak = clamp01(smoothstep(0.52, 0.92, damp) * 0.8);
          let v = 0.62 + grain * 0.1 - soot * 0.26 - board * 0.28;
          v = clamp01(v - streak * 0.22);
          const green = 1 - streak * 0.06;
          img.data[i] = v * 206;
          img.data[i + 1] = v * 204 * green;
          img.data[i + 2] = v * 196 * (1 - streak * 0.02);
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      // Efflorescence: pale calcium bloom where water has run.
      for (let n = 0; n < 90; n++) {
        const x = hashFloat(n, 3, 9) * size;
        const y = hashFloat(n, 4, 9) * size;
        const w = 4 + hashFloat(n, 5, 9) * 16;
        const h = 30 + hashFloat(n, 6, 9) * 150;
        const grad = ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, 'rgba(232,230,220,0.34)');
        grad.addColorStop(1, 'rgba(232,230,220,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);
      }
      return finish(c);
    });
  }

  tunnelLiningNormal(): Texture {
    return this.memo('tunnelLiningN', () => {
      const size = 256;
      const h = new Float32Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const board = Math.abs(((x % 48) / 48) - 0.5) * 2 > 0.9 ? -0.5 : 0;
          h[y * size + x] = tileFbm(x / 3, y / 3, 84, 17, 3) * 0.5 + board;
        }
      }
      return normalFromHeight(h, size, 1.5);
    });
  }

  /** Weathered steel for rail webs, bridges and gantries. */
  steel(): Texture {
    return this.memo('steel', () => {
      const size = 256;
      const { c, ctx } = canvas(size);
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const rust = smoothstep(0.55, 0.9, tileFbm(x / 34, y / 34, 8, 55, 4));
          const grain = tileNoise(x / 1.8, y / 8, 140, 31);
          const base = 0.42 + grain * 0.16;
          img.data[i] = clamp01(lerp(base, base * 1.5, rust)) * 190;
          img.data[i + 1] = clamp01(lerp(base, base * 0.95, rust)) * 188;
          img.data[i + 2] = clamp01(lerp(base * 1.02, base * 0.6, rust)) * 186;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return finish(c);
    });
  }

  /** Japanese roof tiles - the ridged kawara pattern. */
  roofTile(color: number): Texture {
    return this.memo(`roof${color}`, () => {
      const size = 256;
      const { c, ctx } = canvas(size);
      const r = (color >> 16) & 255;
      const g = (color >> 8) & 255;
      const b = color & 255;
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          // Ridges every 16 px across, courses every 32 px down.
          const ridge = Math.sin((x / 16) * Math.PI * 2) * 0.5 + 0.5;
          const course = ((y % 32) / 32);
          const shade = 0.72 + ridge * 0.4 - smoothstep(0.86, 1, course) * 0.35;
          const dirt = tileFbm(x / 40, y / 40, 6, 77, 3) * 0.22;
          const v = clamp01(shade - dirt);
          img.data[i] = r * v;
          img.data[i + 1] = g * v;
          img.data[i + 2] = b * v;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return finish(c);
    });
  }

  /** Painted board siding used on Japanese houses. */
  siding(color: number): Texture {
    return this.memo(`siding${color}`, () => {
      const size = 256;
      const { c, ctx } = canvas(size);
      const r = (color >> 16) & 255;
      const g = (color >> 8) & 255;
      const b = color & 255;
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const board = y % 21 < 1 ? 0.72 : 1;
          const grain = tileFbm(x / 3, y / 40, 80, 44, 2) * 0.1;
          const weather = tileFbm(x / 60, y / 60, 5, 8, 3) * 0.16;
          const v = clamp01(0.9 * board + grain - weather);
          img.data[i] = r * v;
          img.data[i + 1] = g * v;
          img.data[i + 2] = b * v;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return finish(c);
    });
  }

  /**
   * Building facade with lit or dark windows.
   * `variant` selects a colour scheme; `lit` fraction controls night lighting.
   */
  facade(variant: number, lit: number): Texture {
    return this.memo(`facade${variant}_${Math.round(lit * 10)}`, () => {
      const size = 512;
      const { c, ctx } = canvas(size);
      const palettes = [
        ['#cfc8bd', '#a8a096'],
        ['#b9bec4', '#8f959c'],
        ['#d8cfc0', '#b0a49a'],
        ['#c3b7a6', '#9c9184'],
        ['#aab3b8', '#7f888d'],
      ];
      const pal = palettes[variant % palettes.length];
      ctx.fillStyle = pal[0];
      ctx.fillRect(0, 0, size, size);

      // Floor bands.
      const floors = 8;
      const fh = size / floors;
      for (let f = 0; f < floors; f++) {
        ctx.fillStyle = pal[1];
        ctx.globalAlpha = 0.35;
        ctx.fillRect(0, f * fh + fh * 0.86, size, fh * 0.14);
        ctx.globalAlpha = 1;
        const cols = 8;
        const cw = size / cols;
        for (let w = 0; w < cols; w++) {
          const on = hashFloat(f, w, variant) < lit;
          const x = w * cw + cw * 0.18;
          const y = f * fh + fh * 0.18;
          const ww = cw * 0.64;
          const wh = fh * 0.6;
          const glass = on ? '#ffe9c0' : '#2b333c';
          ctx.fillStyle = glass;
          ctx.fillRect(x, y, ww, wh);
          // Reflection streak on the glass.
          const grad = ctx.createLinearGradient(x, y, x + ww, y + wh);
          grad.addColorStop(0, 'rgba(255,255,255,0.28)');
          grad.addColorStop(0.5, 'rgba(255,255,255,0.02)');
          grad.addColorStop(1, 'rgba(255,255,255,0.16)');
          ctx.fillStyle = grad;
          ctx.fillRect(x, y, ww, wh);
          ctx.strokeStyle = 'rgba(40,44,48,0.7)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x, y, ww, wh);
        }
      }
      // Grime accumulating down the facade.
      const img = ctx.getImageData(0, 0, size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const dirt = tileFbm(x / 70, y / 22, 6, variant * 13 + 3, 3) * 0.2;
          img.data[i] *= 1 - dirt;
          img.data[i + 1] *= 1 - dirt;
          img.data[i + 2] *= 1 - dirt * 0.9;
        }
      }
      ctx.putImageData(img, 0, 0);
      return finish(c);
    });
  }

  /** Emissive mask matching `facade` so windows glow at night. */
  facadeEmissive(variant: number, lit: number): Texture {
    return this.memo(`facadeE${variant}_${Math.round(lit * 10)}`, () => {
      const size = 512;
      const { c, ctx } = canvas(size);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size, size);
      const floors = 8;
      const fh = size / floors;
      for (let f = 0; f < floors; f++) {
        const cols = 8;
        const cw = size / cols;
        for (let w = 0; w < cols; w++) {
          if (hashFloat(f, w, variant) >= lit) continue;
          const warm = 200 + hashFloat(f, w, variant + 7) * 55;
          ctx.fillStyle = `rgb(${warm},${warm * 0.86},${warm * 0.64})`;
          ctx.fillRect(w * cw + cw * 0.18, f * fh + fh * 0.18, cw * 0.64, fh * 0.6);
        }
      }
      return finish(c);
    });
  }

  /** Platform surface: pale paving with a yellow tactile strip at the edge. */
  platform(): Texture {
    return this.memo('platform', () => {
      const size = 256;
      const { c, ctx } = canvas(size);
      ctx.fillStyle = '#b9b4ab';
      ctx.fillRect(0, 0, size, size);
      const img = ctx.getImageData(0, 0, size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const grain = tileNoise(x / 2, y / 2, 128, 13) * 0.12;
          const joint = x % 64 < 1.5 || y % 64 < 1.5 ? -0.14 : 0;
          const v = 1 + grain - 0.06 + joint;
          img.data[i] *= v;
          img.data[i + 1] *= v;
          img.data[i + 2] *= v;
        }
      }
      ctx.putImageData(img, 0, 0);
      return finish(c);
    });
  }

  tactile(): Texture {
    return this.memo('tactile', () => {
      const size = 128;
      const { c, ctx } = canvas(size);
      ctx.fillStyle = '#d8b12c';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = 'rgba(120,90,20,0.55)';
      for (let y = 8; y < size; y += 16) {
        for (let x = 8; x < size; x += 16) {
          ctx.beginPath();
          ctx.arc(x, y, 4.5, 0, 6.29);
          ctx.fill();
        }
      }
      return finish(c);
    });
  }

  /** Station name board: kanji above, romaji below, in JR house style. */
  stationSign(ja: string, ro: string, prev?: string, next?: string): Texture {
    return this.memo(`sign_${ja}_${prev ?? ''}_${next ?? ''}`, () => {
      const w = 1024;
      const h = 256;
      const { c, ctx } = canvas(w, h);
      ctx.fillStyle = '#f4f2ec';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#0a4c8b';
      ctx.fillRect(0, 0, w, 16);
      ctx.fillRect(0, h - 16, w, 16);

      ctx.textAlign = 'center';
      ctx.fillStyle = '#16181c';
      ctx.font = 'bold 108px "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif';
      ctx.fillText(ja, w / 2, 132);
      ctx.font = '46px "Helvetica Neue", Arial, sans-serif';
      ctx.fillStyle = '#3a3f47';
      ctx.fillText(ro.toUpperCase(), w / 2, 190);

      ctx.font = '34px "Helvetica Neue", Arial, sans-serif';
      ctx.fillStyle = '#5b626c';
      if (prev) {
        ctx.textAlign = 'left';
        ctx.fillText(`◀ ${prev}`, 32, 226);
      }
      if (next) {
        ctx.textAlign = 'right';
        ctx.fillText(`${next} ▶`, w - 32, 226);
      }
      return finish(c, true, false);
    });
  }

  /** Rolling-stock destination blind. */
  destinationBlind(text: string): Texture {
    return this.memo(`blind_${text}`, () => {
      const { c, ctx } = canvas(256, 64);
      ctx.fillStyle = '#14161a';
      ctx.fillRect(0, 0, 256, 64);
      ctx.fillStyle = '#ff7a1a';
      ctx.textAlign = 'center';
      ctx.font = 'bold 40px "Hiragino Sans", "Noto Sans JP", sans-serif';
      ctx.fillText(text, 128, 48);
      return finish(c, true, false);
    });
  }

  /**
   * Foliage card: a cluster of leaves with alpha, used for canopy planes.
   *
   * Two things sell a tree at this scale - a silhouette that is ragged rather
   * than a disc, and light falling through the outer leaves while the inside
   * of the crown stays dark. Both are painted in here.
   */
  leafCluster(tint: number): Texture {
    return this.memo(`leaf${tint}`, () => {
      const size = 256;
      const { c, ctx } = canvas(size);
      ctx.clearRect(0, 0, size, size);
      const r = (tint >> 16) & 255;
      const g = (tint >> 8) & 255;
      const b = tint & 255;

      // A few twigs showing through the gaps.
      ctx.strokeStyle = 'rgba(58,46,34,0.75)';
      for (let n = 0; n < 14; n++) {
        const a = hashFloat(n, 40, tint) * 6.283;
        const len = size * (0.14 + hashFloat(n, 41, tint) * 0.2);
        ctx.lineWidth = 1 + hashFloat(n, 42, tint) * 1.6;
        ctx.beginPath();
        ctx.moveTo(size / 2, size * 0.5);
        ctx.lineTo(size / 2 + Math.cos(a) * len, size * 0.5 + Math.sin(a) * len);
        ctx.stroke();
      }

      // Clumps of leaves hanging off a few main limbs, so the mass breaks up
      // into lobes with sky showing between them.
      const lobes = 7;
      for (let l = 0; l < lobes; l++) {
        const la = (l / lobes) * 6.283 + hashFloat(l, 20, tint) * 0.7;
        const lr = size * (0.16 + hashFloat(l, 21, tint) * 0.26);
        const lx = size / 2 + Math.cos(la) * lr;
        const ly = size * 0.46 + Math.sin(la) * lr * 0.82;
        const leaves = 34 + Math.floor(hashFloat(l, 22, tint) * 26);
        for (let n = 0; n < leaves; n++) {
          const a = hashFloat(n, l * 7 + 1, tint) * 6.283;
          const rad = Math.pow(hashFloat(n, l * 7 + 2, tint), 0.55) * size * 0.19;
          const x = lx + Math.cos(a) * rad;
          const y = ly + Math.sin(a) * rad * 0.9;
          const s = 4 + hashFloat(n, l * 7 + 3, tint) * 11;
          const fromCentre = Math.hypot(x - size / 2, y - size * 0.46) / size;
          // Lit at the edge of the mass, deep shade towards the middle.
          // Kept below one: the card is tinted per instance, so a texel that
          // reaches white throws the tree's colour away entirely.
          const shade = clamp01(0.32 + fromCentre * 0.95 + hashFloat(n, l * 7 + 4, tint) * 0.24);
          const hue = 0.9 + hashFloat(n, l * 7 + 6, tint) * 0.24;
          ctx.fillStyle = `rgba(${r * shade * hue},${g * shade},${b * shade * (2 - hue)},${
            0.82 + hashFloat(n, l * 7 + 7, tint) * 0.18
          })`;
          ctx.beginPath();
          ctx.ellipse(
            x, y, s, s * (0.42 + hashFloat(n, l * 7 + 5, tint) * 0.5),
            hashFloat(n, l * 7 + 8, tint) * 6.28, 0, 6.29,
          );
          ctx.fill();
        }
      }
      return finish(c, true, false);
    });
  }

  bark(): Texture {
    return this.memo('bark', () => {
      const size = 128;
      const { c, ctx } = canvas(size);
      const img = ctx.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const i = (y * size + x) * 4;
          const fissure = Math.abs(tileFbm(x / 8, y / 40, 16, 5, 3) - 0.5) * 2;
          const v = clamp01(0.3 + fissure * 0.6);
          img.data[i] = v * 118;
          img.data[i + 1] = v * 96;
          img.data[i + 2] = v * 74;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return finish(c);
    });
  }

  /** Grass blade card for lineside tufts. */
  grassBlades(color: number): Texture {
    return this.memo(`grass${color}`, () => {
      const size = 128;
      const { c, ctx } = canvas(size);
      ctx.clearRect(0, 0, size, size);
      const r = (color >> 16) & 255;
      const g = (color >> 8) & 255;
      const b = color & 255;
      for (let n = 0; n < 64; n++) {
        const x = hashFloat(n, 1, color) * size;
        const hgt = size * (0.4 + hashFloat(n, 2, color) * 0.55);
        const lean = (hashFloat(n, 3, color) - 0.5) * 34;
        // Blades are shaded below white so the tuft keeps the colour it is
        // given, and so the base of the clump reads darker than the tips.
        const shade = 0.46 + hashFloat(n, 4, color) * 0.42;
        ctx.strokeStyle = `rgba(${r * shade},${g * shade},${b * shade},0.95)`;
        ctx.lineWidth = 1.4 + hashFloat(n, 5, color) * 2.2;
        ctx.beginPath();
        ctx.moveTo(x, size);
        ctx.quadraticCurveTo(x + lean * 0.4, size - hgt * 0.6, x + lean, size - hgt);
        ctx.stroke();
      }
      return finish(c, true, false);
    });
  }

  /** Animated-looking water surface normals (sampled twice at different scales). */
  waterNormal(): Texture {
    return this.memo('waterN', () => {
      const size = 512;
      const h = new Float32Array(size * size);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const a = tileFbm(x / 22, y / 30, 24, 3, 4);
          const b = tileFbm(x / 7, y / 9, 74, 19, 3);
          h[y * size + x] = a * 0.75 + b * 0.35;
        }
      }
      return normalFromHeight(h, size, 1.5);
    });
  }

  /** Rice paddy: young green shoots in flooded rows. */
  paddy(season: number): Texture {
    return this.memo(`paddy${season}`, () => {
      const size = 256;
      const { c, ctx } = canvas(size);
      const base = season < 0.5 ? '#3e5f4a' : '#7d8f3a';
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, size, size);
      for (let ry = 0; ry < size; ry += 9) {
        for (let rx = 0; rx < size; rx += 9) {
          const j = hashFloat(rx, ry, season * 100) * 3;
          const shade = 0.7 + hashFloat(rx, ry, 4) * 0.6;
          ctx.fillStyle =
            season < 0.5
              ? `rgba(${86 * shade},${140 * shade},${74 * shade},0.9)`
              : `rgba(${168 * shade},${170 * shade},${72 * shade},0.9)`;
          ctx.beginPath();
          ctx.ellipse(rx + j, ry + j, 3.4, 2.4, 0, 0, 6.29);
          ctx.fill();
        }
      }
      return finish(c);
    });
  }

  /** Simple radial glow sprite for lamps and headlights. */
  glow(): Texture {
    return this.memo('glow', () => {
      const size = 128;
      const { c, ctx } = canvas(size);
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.25, 'rgba(255,246,224,0.55)');
      grad.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      return finish(c, true, false);
    });
  }

  /** Soft round shadow blob used under scattered props. */
  blobShadow(): Texture {
    return this.memo('blob', () => {
      const size = 64;
      const { c, ctx } = canvas(size);
      const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(0,0,0,0.5)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);
      return finish(c, false, false);
    });
  }

  dispose(): void {
    for (const tex of this.cache.values()) tex.dispose();
    this.cache.clear();
  }
}

export const textures = new TextureFactory();
