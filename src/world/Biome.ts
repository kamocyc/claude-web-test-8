import { Color } from 'three';
import { Noise2D } from '../core/Random';
import { clamp, lerp, smoothstep } from '../core/MathUtils';

/**
 * Biomes drive everything about a stretch of line: how the land is shaped,
 * what grows or is built on it, how tight the curves are and how fast the
 * timetable lets you run.
 */
export type BiomeId = 'coast' | 'mountain' | 'forest' | 'farmland' | 'suburb' | 'city' | 'riverside';

export const BIOME_IDS: readonly BiomeId[] = [
  'coast',
  'mountain',
  'forest',
  'farmland',
  'suburb',
  'city',
  'riverside',
];

export const BIOME_INDEX: Record<BiomeId, number> = {
  coast: 0,
  mountain: 1,
  forest: 2,
  farmland: 3,
  suburb: 4,
  city: 5,
  riverside: 6,
};

export type BuildingKind = 'none' | 'farmhouse' | 'house' | 'shophouse' | 'block' | 'tower' | 'warehouse';

export interface BiomeDef {
  id: BiomeId;
  label: string;
  labelJa: string;
  /** Preferred top-of-rail elevation band above sea level, metres. */
  elevation: [number, number];
  /** Vertical amplitude of the surrounding land, metres. */
  relief: number;
  /** Horizontal scale of the relief, metres per noise unit. */
  reliefScale: number;
  /** Use ridged noise (sharp mountain crests) instead of rolling fbm. */
  ridged: boolean;
  /** 0 = dead straight running, 1 = constant curvature. */
  curviness: number;
  /** Typical minimum curve radius, metres. */
  minRadius: number;
  /** Maximum gradient in per mille. */
  gradeLimit: number;
  /** Line speed for this terrain, km/h. */
  lineSpeed: number;
  treeDensity: number;
  shrubDensity: number;
  buildingDensity: number;
  buildingKind: BuildingKind;
  secondaryBuildingKind: BuildingKind;
  paddy: number;
  roadDensity: number;
  /** Probability that a chunk of this biome carries a station. */
  stationBias: number;
  grassColor: number;
  soilColor: number;
  /** Extra distance haze, for humid coastal air. */
  haze: number;
  /** Ambient sound bed. */
  ambience: 'sea' | 'birds' | 'town' | 'wind' | 'insects';
}

const defs: Record<BiomeId, BiomeDef> = {
  coast: {
    id: 'coast',
    label: 'Coast',
    labelJa: '海岸',
    elevation: [6, 26],
    relief: 46,
    reliefScale: 340,
    ridged: false,
    curviness: 0.55,
    minRadius: 480,
    gradeLimit: 18,
    lineSpeed: 85,
    treeDensity: 0.5,
    shrubDensity: 0.9,
    buildingDensity: 0.22,
    buildingKind: 'house',
    secondaryBuildingKind: 'warehouse',
    paddy: 0.05,
    roadDensity: 0.5,
    stationBias: 1.1,
    grassColor: 0x6f8046,
    soilColor: 0x9a8f76,
    haze: 1.35,
    ambience: 'sea',
  },
  mountain: {
    id: 'mountain',
    label: 'Mountain',
    labelJa: '山岳',
    elevation: [90, 340],
    relief: 260,
    reliefScale: 620,
    ridged: true,
    curviness: 0.85,
    minRadius: 300,
    gradeLimit: 30,
    lineSpeed: 70,
    treeDensity: 1.6,
    shrubDensity: 0.8,
    buildingDensity: 0.03,
    buildingKind: 'farmhouse',
    secondaryBuildingKind: 'none',
    paddy: 0.02,
    roadDensity: 0.14,
    stationBias: 0.45,
    grassColor: 0x4d6134,
    soilColor: 0x6d6152,
    haze: 1.1,
    ambience: 'wind',
  },
  forest: {
    id: 'forest',
    label: 'Forest',
    labelJa: '森林',
    elevation: [40, 140],
    relief: 74,
    reliefScale: 400,
    ridged: false,
    curviness: 0.5,
    minRadius: 600,
    gradeLimit: 22,
    lineSpeed: 95,
    treeDensity: 2.1,
    shrubDensity: 1.3,
    buildingDensity: 0.05,
    buildingKind: 'farmhouse',
    secondaryBuildingKind: 'none',
    paddy: 0.08,
    roadDensity: 0.2,
    stationBias: 0.6,
    grassColor: 0x516b34,
    soilColor: 0x5f5340,
    haze: 1.0,
    ambience: 'birds',
  },
  farmland: {
    id: 'farmland',
    label: 'Farmland',
    labelJa: '田園',
    elevation: [8, 60],
    relief: 12,
    reliefScale: 520,
    ridged: false,
    curviness: 0.18,
    minRadius: 1400,
    gradeLimit: 10,
    lineSpeed: 110,
    treeDensity: 0.35,
    shrubDensity: 0.5,
    buildingDensity: 0.2,
    buildingKind: 'farmhouse',
    secondaryBuildingKind: 'warehouse',
    paddy: 1.0,
    roadDensity: 0.55,
    stationBias: 0.9,
    grassColor: 0x74893f,
    soilColor: 0x7d6b4d,
    haze: 0.95,
    ambience: 'insects',
  },
  suburb: {
    id: 'suburb',
    label: 'Suburb',
    labelJa: '郊外',
    elevation: [10, 70],
    relief: 22,
    reliefScale: 430,
    ridged: false,
    curviness: 0.3,
    minRadius: 900,
    gradeLimit: 14,
    lineSpeed: 100,
    treeDensity: 0.45,
    shrubDensity: 0.6,
    buildingDensity: 1.15,
    buildingKind: 'house',
    secondaryBuildingKind: 'shophouse',
    paddy: 0.18,
    roadDensity: 1.1,
    stationBias: 1.5,
    grassColor: 0x6d8043,
    soilColor: 0x83745c,
    haze: 1.0,
    ambience: 'town',
  },
  city: {
    id: 'city',
    label: 'City',
    labelJa: '市街',
    elevation: [4, 40],
    relief: 8,
    reliefScale: 500,
    ridged: false,
    curviness: 0.35,
    minRadius: 700,
    gradeLimit: 16,
    lineSpeed: 90,
    treeDensity: 0.22,
    shrubDensity: 0.3,
    buildingDensity: 1.9,
    buildingKind: 'block',
    secondaryBuildingKind: 'tower',
    paddy: 0,
    roadDensity: 1.7,
    stationBias: 2.0,
    grassColor: 0x6a7847,
    soilColor: 0x8d8b86,
    haze: 1.25,
    ambience: 'town',
  },
  riverside: {
    id: 'riverside',
    label: 'Riverside',
    labelJa: '河川',
    elevation: [6, 45],
    relief: 26,
    reliefScale: 460,
    ridged: false,
    curviness: 0.42,
    minRadius: 800,
    gradeLimit: 12,
    lineSpeed: 100,
    treeDensity: 0.8,
    shrubDensity: 1.1,
    buildingDensity: 0.35,
    buildingKind: 'house',
    secondaryBuildingKind: 'farmhouse',
    paddy: 0.5,
    roadDensity: 0.6,
    stationBias: 0.8,
    grassColor: 0x6d8546,
    soilColor: 0x87795e,
    haze: 1.1,
    ambience: 'insects',
  },
};

export function biome(id: BiomeId): BiomeDef {
  return defs[id];
}

/**
 * Markov transition weights. Rows are the current biome, columns the next one.
 * Tuned so a route reads like a real regional line: the coast runs for a while,
 * mountains lead into forest, cities are approached through suburbs.
 */
const TRANSITIONS: Record<BiomeId, Partial<Record<BiomeId, number>>> = {
  coast: { coast: 2.2, suburb: 1.4, forest: 1.0, mountain: 0.8, farmland: 0.7, riverside: 0.5, city: 0.4 },
  mountain: { mountain: 2.0, forest: 2.2, riverside: 0.9, farmland: 0.5, coast: 0.4, suburb: 0.3, city: 0.1 },
  forest: { forest: 1.8, mountain: 1.5, farmland: 1.3, riverside: 1.0, suburb: 0.8, coast: 0.6, city: 0.2 },
  farmland: { farmland: 1.9, suburb: 1.3, riverside: 1.2, forest: 1.1, coast: 0.7, mountain: 0.6, city: 0.4 },
  suburb: { suburb: 1.5, city: 1.6, farmland: 1.2, coast: 0.9, forest: 0.7, riverside: 0.7, mountain: 0.3 },
  city: { city: 1.2, suburb: 2.4, riverside: 0.7, coast: 0.5, farmland: 0.4, forest: 0.2, mountain: 0.1 },
  riverside: { riverside: 1.1, farmland: 1.6, forest: 1.3, suburb: 1.1, mountain: 0.9, coast: 0.8, city: 0.4 },
};

export function transitionWeights(from: BiomeId): number[] {
  const row = TRANSITIONS[from];
  return BIOME_IDS.map((id) => row[id] ?? 0.05);
}

/** Noise fields shared by terrain, scatter and water. */
export class TerrainNoise {
  readonly hills: Noise2D;
  readonly detail: Noise2D;
  readonly ridges: Noise2D;
  readonly micro: Noise2D;
  readonly patches: Noise2D;
  readonly scatter: Noise2D;

  constructor(seed: number) {
    this.hills = new Noise2D(seed ^ 0x1a2b);
    this.detail = new Noise2D(seed ^ 0x51d3);
    this.ridges = new Noise2D(seed ^ 0x9e37);
    this.micro = new Noise2D(seed ^ 0xc0ff);
    this.patches = new Noise2D(seed ^ 0x77aa);
    this.scatter = new Noise2D(seed ^ 0x3f19);
  }
}

export interface TerrainQuery {
  /** Signed lateral offset from the track centre line, metres (+ = right). */
  lateral: number;
  /** Top-of-rail elevation at this chainage. */
  trackY: number;
  worldX: number;
  worldZ: number;
  /** Which side the sea lies on for coastal sections: -1 left, +1 right, 0 none. */
  seaSide: number;
  /** Which side a river runs along, and how close it is (0 = none). */
  riverSide: number;
  riverStrength: number;
}

export const SEA_LEVEL = 0;

/**
 * Absolute ground elevation contributed by a single biome.
 *
 * Everything is expressed relative to the track so the line never ends up
 * buried or floating: the profile always meets `trackY` near the centre line
 * and diverges into biome-specific landform further out.
 */
export function biomeElevation(def: BiomeDef, q: TerrainQuery, n: TerrainNoise): number {
  const ax = Math.abs(q.lateral);
  const scale = 1 / def.reliefScale;
  const nx = q.worldX * scale;
  const nz = q.worldZ * scale;

  // Land rises away from the formation; near the track it is graded flat.
  const away = smoothstep(14, 140, ax);

  let h: number;
  if (def.ridged) {
    const ridge = n.ridges.ridged(nx, nz, 5, 2.1, 0.52) * 0.5 + 0.5;
    const roll = n.hills.fbm(nx * 0.6, nz * 0.6, 4) * 0.5 + 0.5;
    h = q.trackY + def.relief * (ridge * 0.85 + roll * 0.35 - 0.22) * away;
    // Valleys: the line follows the lowest ground, so pull the terrain down
    // close to the formation and let it climb steeply beyond.
    h += def.relief * 0.35 * smoothstep(60, 420, ax) * (n.hills.fbm(nx * 0.25, nz * 0.25, 2) * 0.5 + 0.5);
  } else {
    const roll = n.hills.fbm(nx, nz, 4, 2.0, 0.5);
    h = q.trackY + def.relief * roll * away;
  }

  // Medium and fine detail, present everywhere but flattened on the formation.
  h += n.detail.fbm(q.worldX * 0.012, q.worldZ * 0.012, 3) * def.relief * 0.06 * away;
  h += n.micro.fbm(q.worldX * 0.09, q.worldZ * 0.09, 2) * 0.35 * smoothstep(6, 30, ax);

  if (def.id === 'coast' && q.seaSide !== 0) {
    const toSea = q.lateral * q.seaSide; // positive when heading out to sea
    if (toSea > 0) {
      // Foreshore: rock and sand from the formation down to the waterline,
      // then a shelving seabed.
      const shore = smoothstep(10, 46 + n.detail.sample(q.worldX * 0.01, q.worldZ * 0.01) * 18, toSea);
      const beach = lerp(q.trackY, SEA_LEVEL - 0.6, shore);
      const shelf = smoothstep(50, 700, toSea) * 22;
      h = beach - shelf + n.micro.fbm(q.worldX * 0.05, q.worldZ * 0.05, 2) * 1.2 * (1 - shore);
      // Occasional rocky outcrops just above the waterline.
      const rock = n.patches.fbm(q.worldX * 0.02, q.worldZ * 0.02, 3);
      if (rock > 0.34 && toSea < 120) h += (rock - 0.34) * 26 * (1 - smoothstep(40, 120, toSea));
    } else {
      // Inland side climbs quickly - the line is on a shelf cut into the hills.
      h = q.trackY + def.relief * 0.9 * smoothstep(20, 320, ax) * (n.hills.fbm(nx, nz, 4) * 0.5 + 0.75);
    }
  }

  if (def.id === 'city' || def.id === 'suburb' || def.id === 'farmland') {
    // Built-up and cultivated land is graded flat by people.
    const flatten = smoothstep(20, 260, ax);
    h = lerp(q.trackY + (h - q.trackY) * 0.25, h, flatten * 0.6);
  }

  return h;
}

/** Blends the elevation of several biomes according to their weights. */
export function blendedElevation(
  weights: Float32Array,
  q: TerrainQuery,
  n: TerrainNoise,
): number {
  let sum = 0;
  let total = 0;
  for (let i = 0; i < BIOME_IDS.length; i++) {
    const w = weights[i];
    if (w <= 0.001) continue;
    sum += w * biomeElevation(defs[BIOME_IDS[i]], q, n);
    total += w;
  }
  return total > 0 ? sum / total : q.trackY;
}

const tmpColor = new Color();
const outColor = new Color();

/** Ground tint for a blend of biomes, used for terrain vertex colours. */
export function blendedGrassColor(weights: Float32Array, target = outColor): Color {
  target.setRGB(0, 0, 0);
  let total = 0;
  for (let i = 0; i < BIOME_IDS.length; i++) {
    const w = weights[i];
    if (w <= 0.001) continue;
    tmpColor.setHex(defs[BIOME_IDS[i]].grassColor);
    target.r += tmpColor.r * w;
    target.g += tmpColor.g * w;
    target.b += tmpColor.b * w;
    total += w;
  }
  if (total > 0) target.multiplyScalar(1 / total);
  return target;
}

/** Scalar biome attribute blended by weight. */
export function blendedAttr(weights: Float32Array, key: keyof BiomeDef): number {
  let sum = 0;
  let total = 0;
  for (let i = 0; i < BIOME_IDS.length; i++) {
    const w = weights[i];
    if (w <= 0.001) continue;
    sum += w * (defs[BIOME_IDS[i]][key] as number);
    total += w;
  }
  return total > 0 ? sum / total : 0;
}

/** Dominant biome of a weight vector. */
export function dominantBiome(weights: Float32Array): BiomeId {
  let best = 0;
  for (let i = 1; i < BIOME_IDS.length; i++) if (weights[i] > weights[best]) best = i;
  return BIOME_IDS[best];
}

/** Normalised, clamped weight helper used while building the route. */
export function normalizeWeights(weights: Float32Array): void {
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    weights[i] = clamp(weights[i], 0, 1);
    total += weights[i];
  }
  if (total <= 0) {
    weights[BIOME_INDEX.farmland] = 1;
    return;
  }
  for (let i = 0; i < weights.length; i++) weights[i] /= total;
}
