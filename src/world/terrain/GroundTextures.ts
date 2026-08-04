import {
  DataArrayTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { hashFloat } from '../../core/Random';
import { clamp01, lerp, smoothstep } from '../../core/MathUtils';

/**
 * The ground layers, synthesised.
 *
 * Real landscape is not one surface: it is turf where the soil is deep, pale
 * dry grass where it is thin, bare earth where something has scuffed it, loose
 * gravel washed down a slope, and the rock the whole thing sits on wherever the
 * ground is too steep for anything to hold. This file generates all five as a
 * texture array so the terrain shader can pick and blend between them per
 * pixel with only a couple of samples.
 *
 * Each layer is stored twice:
 *  - `albedo`   RGB colour (sRGB) with the layer's *surface height* in alpha,
 *               which is what lets layers interlock along their own relief
 *               instead of cross-fading like a slide dissolve.
 *  - `surface`  RG tangent-space normal, B roughness, A ambient occlusion.
 */

export const LAYER_GRASS = 0;
export const LAYER_DRY = 1;
export const LAYER_SOIL = 2;
export const LAYER_GRAVEL = 3;
export const LAYER_SAND = 4;
export const LAYER_ROCK = 5;
export const LAYER_COUNT = 6;

const SIZE = 256;

/** Tileable value noise on an integer lattice with the given period. */
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

function tileFbm(x: number, y: number, period: number, seed: number, octaves = 3): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tileNoise(x * f, y * f, period * f, seed + i * 97);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Tileable Worley/cellular noise; returns distance to the nearest feature. */
function tileCells(x: number, y: number, period: number, seed: number): { d: number; id: number } {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 8;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const wx = ((cx % period) + period) % period;
      const wy = ((cy % period) + period) % period;
      const px = cx + hashFloat(wx, wy, seed);
      const py = cy + hashFloat(wx, wy, seed + 19);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) {
        best = d;
        id = hashFloat(wx, wy, seed + 41);
      }
    }
  }
  return { d: Math.sqrt(best), id };
}

interface Sample {
  /** Linear albedo, 0..1. */
  r: number;
  g: number;
  b: number;
  /** Surface relief, 0..1, used for height blending and the normal map. */
  h: number;
  rough: number;
  /** Self-occlusion in the crevices of this material. */
  ao: number;
}

type LayerFn = (x: number, y: number) => Sample;

/** Lush meadow turf: clumps of blades, moss in the hollows, the odd bare scrape. */
const grassLayer: LayerFn = (x, y) => {
  const clump = tileFbm(x / 13, y / 13, 20, 51, 3);
  const blade = tileFbm(x / 2.6, y / 2.6, 99, 17, 2);
  const streak = tileFbm(x / 1.3, y / 5.5, 197, 61, 2);
  const patch = tileFbm(x / 52, y / 52, 5, 3, 3);
  const fine = tileNoise(x / 1.2, y / 1.2, 214, 83);

  const lush = smoothstep(0.34, 0.72, patch);
  const v = clamp01(0.30 + blade * 0.40 + clump * 0.24 + streak * 0.16 + fine * 0.06);
  // Two greens: a blue-green in the thick growth, a yellow-green on the tips.
  const r = lerp(0.015, 0.066, v) * lerp(1.18, 0.82, lush);
  const g = lerp(0.024, 0.112, v) * lerp(1.0, 1.08, lush);
  const b = lerp(0.008, 0.030, v) * lerp(1.18, 0.76, lush);
  const h = clamp01(blade * 0.55 + clump * 0.4 + streak * 0.25);
  return { r, g, b, h, rough: 0.88 + (1 - v) * 0.1, ao: clamp01(0.55 + h * 0.5) };
};

/** Dry summer grass: pale, thin, stalky, with soil showing between the tufts. */
const dryLayer: LayerFn = (x, y) => {
  const tuft = tileCells(x / 9, y / 9, 29, 7);
  const blade = tileFbm(x / 2.2, y / 2.2, 117, 29, 2);
  const patch = tileFbm(x / 40, y / 40, 6, 13, 3);
  const fine = tileNoise(x / 1.1, y / 1.1, 233, 91);

  const tufted = clamp01(1 - tuft.d * 1.15);
  const v = clamp01(0.34 + blade * 0.34 + tufted * 0.34 + fine * 0.07 + patch * 0.12);
  // Straw over a warm earth showing through the gaps.
  const soil = 1 - tufted;
  // Khaki, not straw: grass that has gone over in the heat is still olive.
  const r = lerp(0.030, 0.112, v) * lerp(0.90, 1.0, tufted);
  const g = lerp(0.029, 0.110, v) * lerp(0.80, 1.0, tufted);
  const b = lerp(0.011, 0.042, v) * lerp(0.66, 1.0, tufted);
  const h = clamp01(tufted * 0.7 + blade * 0.35);
  return { r, g, b, h, rough: 0.9, ao: clamp01(0.5 + h * 0.55 - soil * 0.12) };
};

/** Bare earth: crumbly clods, dried cracks, small stones pressed into it. */
const soilLayer: LayerFn = (x, y) => {
  const clods = tileCells(x / 5.5, y / 5.5, 47, 23);
  const coarse = tileFbm(x / 22, y / 22, 12, 5, 3);
  const grit = tileNoise(x / 1.3, y / 1.3, 197, 37);
  const crack = smoothstep(0.06, 0.0, Math.abs(tileFbm(x / 17, y / 17, 15, 71, 2) - 0.5));
  const stone = smoothstep(0.72, 0.86, tileCells(x / 3.4, y / 3.4, 75, 53).id);

  const clod = clamp01(clods.d * 1.2);
  const v = clamp01(0.36 + clod * 0.3 + coarse * 0.28 + grit * 0.14 - crack * 0.22);
  let r = lerp(0.028, 0.145, v) * 1.06;
  let g = lerp(0.018, 0.092, v);
  let b = lerp(0.011, 0.052, v) * 0.94;
  if (stone > 0) {
    const s = stone * 0.8;
    r = lerp(r, 0.135 * (0.7 + grit * 0.5), s);
    g = lerp(g, 0.128 * (0.7 + grit * 0.5), s);
    b = lerp(b, 0.115 * (0.7 + grit * 0.5), s);
  }
  const h = clamp01(clod * 0.6 + coarse * 0.4 - crack * 0.5 + stone * 0.3);
  return { r, g, b, h, rough: 0.94 - stone * 0.16, ao: clamp01(0.42 + h * 0.66) };
};

/** Gravel and scree: broken stone of mixed sizes with dust between it. */
const gravelLayer: LayerFn = (x, y) => {
  const big = tileCells(x / 6.5, y / 6.5, 39, 11);
  const small = tileCells(x / 2.6, y / 2.6, 98, 67);
  const dust = tileFbm(x / 26, y / 26, 10, 89, 3);
  const grit = tileNoise(x / 1.15, y / 1.15, 223, 13);

  const face = clamp01(1 - big.d * 0.9) * 0.6 + clamp01(1 - small.d * 1.1) * 0.4;
  // Every stone is a slightly different rock.
  const tone = 0.55 + big.id * 0.5 + small.id * 0.18;
  const v = clamp01((0.30 + face * 0.5 + grit * 0.16) * tone - dust * 0.08);
  const warm = 0.94 + big.id * 0.16;
  const r = lerp(0.016, 0.132, v) * warm;
  const g = lerp(0.016, 0.124, v);
  const b = lerp(0.015, 0.115, v) * (1.04 - big.id * 0.1);
  const h = clamp01(face * 0.9 + grit * 0.2);
  return { r, g, b, h, rough: 0.86 + dust * 0.12, ao: clamp01(0.3 + h * 0.8) };
};

/** Shore sand and river silt: fine, rippled, damp-darkened in the troughs. */
const sandLayer: LayerFn = (x, y) => {
  const ripple = tileFbm(x / 34, y / 7, 8, 61, 3);
  const drift = tileFbm(x / 15, y / 15, 17, 101, 2);
  const grain = tileNoise(x / 1.05, y / 1.05, 244, 7);
  const shell = smoothstep(0.88, 0.97, tileCells(x / 5, y / 5, 51, 131).id);

  const v = clamp01(0.52 + ripple * 0.26 + drift * 0.14 + grain * 0.12 + shell * 0.3);
  const r = lerp(0.052, 0.196, v);
  const g = lerp(0.044, 0.168, v);
  const b = lerp(0.031, 0.120, v);
  const h = clamp01(ripple * 0.7 + grain * 0.25);
  return { r, g, b, h, rough: 0.9 - shell * 0.2, ao: clamp01(0.62 + h * 0.4) };
};

/** Bedrock: strata cut by joints, weathered along the bedding, lichen on the faces. */
const rockLayer: LayerFn = (x, y) => {
  // Bedding runs across the sheet; joints cut down through it.
  const bedWobble = tileFbm(x / 60, y / 20, 5, 21, 3);
  const bedCoord = y / 30 + bedWobble * 1.6;
  const bedLine = smoothstep(0.5, 0.34, Math.abs((bedCoord % 1) - 0.5));
  const block = tileCells(x / 8, y / 14, 31, 45);
  const joint = smoothstep(0.16, 0.0, block.d);
  const grain = tileFbm(x / 3.2, y / 3.2, 79, 67, 3);
  const fine = tileNoise(x / 1.1, y / 1.1, 234, 3);
  const lichen = smoothstep(0.58, 0.84, tileFbm(x / 30, y / 30, 9, 7, 3));

  const tone = 0.78 + block.id * 0.44;
  const v = clamp01((0.30 + grain * 0.34 + fine * 0.13 + bedLine * 0.1) * tone - joint * 0.26);
  let r = lerp(0.013, 0.118, v) * 1.02;
  let g = lerp(0.013, 0.111, v);
  let b = lerp(0.013, 0.107, v) * 1.02;
  if (lichen > 0) {
    r = lerp(r, r * 0.86 + 0.014, lichen * 0.55);
    g = lerp(g, g * 1.02 + 0.022, lichen * 0.55);
    b = lerp(b, b * 0.7 + 0.008, lichen * 0.55);
  }
  const h = clamp01(0.35 + grain * 0.3 + bedLine * 0.35 - joint * 0.7 + block.id * 0.15);
  return { r, g, b, h, rough: 0.72 + grain * 0.2, ao: clamp01(0.3 + h * 0.85) };
};

const LAYERS: LayerFn[] = [grassLayer, dryLayer, soilLayer, gravelLayer, sandLayer, rockLayer];
/** How hard each layer's relief pushes the shading normal. */
const NORMAL_STRENGTH = [1.5, 1.7, 2.4, 3.4, 1.5, 3.2];

let albedoArray: DataArrayTexture | null = null;
let surfaceArray: DataArrayTexture | null = null;
let variationMap: DataTexture | null = null;

function build(): void {
  const px = SIZE * SIZE;
  const albedo = new Uint8Array(px * 4 * LAYER_COUNT);
  const surface = new Uint8Array(px * 4 * LAYER_COUNT);
  const height = new Float32Array(px);

  for (let layer = 0; layer < LAYER_COUNT; layer++) {
    const fn = LAYERS[layer];
    const base = layer * px * 4;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const s = fn(x, y);
        const i = base + (y * SIZE + x) * 4;
        // sRGB encode: the array is uploaded as an sRGB texture, so store the
        // gamma-encoded value and let the hardware linearise on the way back.
        albedo[i] = Math.round(clamp01(Math.pow(clamp01(s.r), 1 / 2.2)) * 255);
        albedo[i + 1] = Math.round(clamp01(Math.pow(clamp01(s.g), 1 / 2.2)) * 255);
        albedo[i + 2] = Math.round(clamp01(Math.pow(clamp01(s.b), 1 / 2.2)) * 255);
        albedo[i + 3] = Math.round(clamp01(s.h) * 255);
        surface[i + 2] = Math.round(clamp01(s.rough) * 255);
        surface[i + 3] = Math.round(clamp01(s.ao) * 255);
        height[y * SIZE + x] = s.h;
      }
    }
    // Tangent-space normal from this layer's own relief.
    const k = NORMAL_STRENGTH[layer];
    const at = (x: number, y: number) => height[((y + SIZE) % SIZE) * SIZE + ((x + SIZE) % SIZE)];
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const dx = (at(x + 1, y) - at(x - 1, y)) * k;
        const dy = (at(x, y + 1) - at(x, y - 1)) * k;
        const inv = 1 / Math.hypot(dx, dy, 1);
        const i = base + (y * SIZE + x) * 4;
        surface[i] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
        surface[i + 1] = Math.round((-dy * inv * 0.5 + 0.5) * 255);
      }
    }
  }

  albedoArray = new DataArrayTexture(albedo, SIZE, SIZE, LAYER_COUNT);
  albedoArray.format = RGBAFormat;
  albedoArray.type = UnsignedByteType;
  albedoArray.colorSpace = SRGBColorSpace;
  albedoArray.wrapS = albedoArray.wrapT = RepeatWrapping;
  albedoArray.magFilter = LinearFilter;
  albedoArray.minFilter = LinearMipmapLinearFilter;
  albedoArray.generateMipmaps = true;
  albedoArray.needsUpdate = true;

  surfaceArray = new DataArrayTexture(surface, SIZE, SIZE, LAYER_COUNT);
  surfaceArray.format = RGBAFormat;
  surfaceArray.type = UnsignedByteType;
  surfaceArray.colorSpace = NoColorSpace;
  surfaceArray.wrapS = surfaceArray.wrapT = RepeatWrapping;
  surfaceArray.magFilter = LinearFilter;
  surfaceArray.minFilter = LinearMipmapLinearFilter;
  surfaceArray.generateMipmaps = true;
  surfaceArray.needsUpdate = true;

  // Four uncorrelated low-frequency fields. Stretched over hundreds of metres
  // in the shader, these are what stop the ground reading as one texture
  // repeated: dry and lush ground, worn patches and stony ground all drift
  // across the landscape at a scale no tile can betray.
  const vsize = 128;
  const variation = new Uint8Array(vsize * vsize * 4);
  // Averaged octaves pile up around the middle, so each channel is stretched
  // back out - otherwise every field is the same field with a rounding error.
  const stretch = (v: number) => clamp01((v - 0.5) * 2.6 + 0.5);
  for (let y = 0; y < vsize; y++) {
    for (let x = 0; x < vsize; x++) {
      const i = (y * vsize + x) * 4;
      variation[i] = Math.round(stretch(tileFbm(x / 26, y / 26, 5, 401, 4)) * 255);
      variation[i + 1] = Math.round(stretch(tileFbm(x / 17, y / 17, 8, 733, 4)) * 255);
      variation[i + 2] = Math.round(stretch(tileFbm(x / 11, y / 11, 12, 197, 3)) * 255);
      variation[i + 3] = Math.round(stretch(tileFbm(x / 7, y / 7, 19, 911, 3)) * 255);
    }
  }
  variationMap = new DataTexture(variation, vsize, vsize, RGBAFormat, UnsignedByteType);
  variationMap.colorSpace = NoColorSpace;
  variationMap.wrapS = variationMap.wrapT = RepeatWrapping;
  variationMap.magFilter = LinearFilter;
  variationMap.minFilter = LinearMipmapLinearFilter;
  variationMap.generateMipmaps = true;
  variationMap.needsUpdate = true;
}

export function groundLayerTextures(): {
  albedo: DataArrayTexture;
  surface: DataArrayTexture;
  variation: DataTexture;
} {
  if (!albedoArray) build();
  return { albedo: albedoArray!, surface: surfaceArray!, variation: variationMap! };
}
