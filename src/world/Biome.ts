import { Color, LinearSRGBColorSpace } from 'three';
import { Noise2D } from '../core/Random';
import { clamp, lerp, smoothstep } from '../core/MathUtils';
import { drainage, ridgedMulti, terrace, terraceScarp, warpedFbm } from './terrain/Landform';

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
  /**
   * Ground tint for this biome, multiplied over the layered ground material.
   * Mid grey leaves it alone; lighter, warmer or cooler shifts the whole
   * landscape that way.
   */
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
    grassColor: 0x8a8378,
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
    grassColor: 0x76807a,
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
    grassColor: 0x79856d,
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
    grassColor: 0x8d8a6e,
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
    grassColor: 0x84827c,
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
    grassColor: 0x807f7d,
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
    grassColor: 0x82896f,
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
  // Anything with a wavelength shorter than the corridor mesh can resolve is
  // held back until beyond its reach, or the coarse strip beside the line
  // would sit below the tiles it is meant to cover and let them show through.
  const fine = smoothstep(100, 220, ax);

  let h: number;
  switch (def.id) {
    case 'mountain': {
      // Warp the lookup before taking ridges from it: unwarped ridged noise
      // gives a field of separate peaks, warped it gives ranges with spurs
      // running off them, which is what a Japanese mountain line runs through.
      const wx = n.hills.sample(nx * 0.5, nz * 0.5) * 0.62;
      const wy = n.hills.sample(nx * 0.5 + 3.7, nz * 0.5 - 1.9) * 0.62;
      const ridge = ridgedMulti(n.ridges, nx + wx, nz + wy, 5);
      const roll = n.hills.fbm(nx * 0.44, nz * 0.44, 3) * 0.5 + 0.5;
      h = q.trackY + def.relief * (ridge * 1.22 + roll * 0.3 - 0.36) * away;
      // The line takes the valley floor, so the ground stays low beside it and
      // climbs hard once it is clear of the alignment.
      h += def.relief * 0.4 * smoothstep(60, 460, ax) * roll;
      // Gullies cut down the flanks and the spoil fans out at the foot.
      const gully = drainage(n.patches, nx * 2.7, nz * 2.7, 3);
      h -= def.relief * 0.14 * gully * fine;
      // Benches: harder beds standing out of the hillside, with scree between.
      const bench = 0.42 * smoothstep(0.34, 0.78, ridge) * smoothstep(150, 360, ax);
      h = lerp(h, terrace(h, 27, 3), bench);
      break;
    }

    case 'forest': {
      // Rounded hills, but cut by a dendritic valley network so the woodland
      // sits in folds rather than on a duvet.
      const base = warpedFbm(n.hills, n.detail, nx, nz, 4, 0.85);
      h = q.trackY + def.relief * base * away;
      h += def.relief * 0.34 * ridgedMulti(n.ridges, nx * 0.85, nz * 0.85, 3) * away;
      const valley = drainage(n.patches, nx * 1.75, nz * 1.75, 3);
      h -= def.relief * 0.44 * valley * smoothstep(40, 230, ax);
      break;
    }

    case 'coast': {
      // Headlands and the marine terrace behind them: a bench of old sea floor
      // standing above the present shore, which is most of the Japanese coast.
      const head = ridgedMulti(n.ridges, nx * 0.95, nz * 0.95, 4);
      const roll = n.hills.fbm(nx, nz, 3) * 0.5 + 0.5;
      h = q.trackY + def.relief * (head * 0.85 + roll * 0.5 - 0.3) * away;
      h = lerp(h, terrace(h, 21, 2), 0.3 * smoothstep(90, 300, ax));
      break;
    }

    case 'farmland': {
      // Alluvium: nearly level, but stepped by an old river terrace and
      // creased where the ground drains.
      const roll = n.hills.fbm(nx, nz, 3);
      h = q.trackY + def.relief * roll * away;
      h += terraceScarp(n.patches, q.worldX, q.worldZ, 0.00082, 7.5) * smoothstep(30, 260, ax);
      h -= drainage(n.detail, q.worldX * 0.0022, q.worldZ * 0.0022, 2) * 2.4 * fine;
      // Rice ground is not a slope, it is a staircase: every pan is level and
      // held by a bund, and the risers follow the contour. Half a metre a step
      // is what a Japanese valley floor actually looks like.
      h = lerp(h, terrace(h, 0.55, 3), 0.85 * fine);
      break;
    }

    case 'riverside': {
      // A flood plain between two terraces, the line on the lower one.
      const roll = warpedFbm(n.hills, n.detail, nx, nz, 3, 0.6);
      h = q.trackY + def.relief * roll * away;
      h += terraceScarp(n.patches, q.worldX, q.worldZ, 0.0011, 9.0) * smoothstep(40, 320, ax);
      h -= drainage(n.detail, q.worldX * 0.0026, q.worldZ * 0.0026, 2) * 3.2 * fine;
      h = lerp(h, terrace(h, 0.6, 3), 0.5 * fine);
      break;
    }

    default: {
      // Suburb and city: whatever the land did originally, it has been graded.
      const roll = n.hills.fbm(nx, nz, 4, 2.0, 0.5);
      h = q.trackY + def.relief * roll * away;
      break;
    }
  }

  // Medium and fine detail, present everywhere but flattened on the formation.
  h += n.detail.fbm(q.worldX * 0.012, q.worldZ * 0.012, 3) * def.relief * 0.06 * away;
  h += n.micro.fbm(q.worldX * 0.09, q.worldZ * 0.09, 2) * 0.35 * smoothstep(6, 30, ax);

  if (def.id === 'coast' && q.seaSide !== 0) {
    const toSea = q.lateral * q.seaSide; // positive when heading out to sea
    if (toSea > 0) {
      // Foreshore: rock and sand from the formation down to the waterline,
      // then a shelving seabed that shallows again over an offshore bar, so
      // the swell has something to break on.
      const shore = smoothstep(10, 46 + n.detail.sample(q.worldX * 0.01, q.worldZ * 0.01) * 18, toSea);
      const beach = lerp(q.trackY, SEA_LEVEL - 0.6, shore);
      const shelf = smoothstep(50, 700, toSea) * 22;
      const bar = Math.exp(-Math.pow((toSea - 190) / 110, 2)) * 3.4;
      h = beach - shelf + bar + n.micro.fbm(q.worldX * 0.05, q.worldZ * 0.05, 2) * 1.2 * (1 - shore);
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

/**
 * Neutral point of the ground tint. The tint multiplies an already-coloured
 * layered ground material, so a biome that looks like everywhere else is mid
 * grey and anything either side of it warms, cools or darkens the whole
 * landscape.
 */
const TINT_GAIN = 2;

/** Ground tint for a blend of biomes, used for terrain vertex colours. */
export function blendedGrassColor(weights: Float32Array, target = outColor): Color {
  target.setRGB(0, 0, 0);
  let total = 0;
  for (let i = 0; i < BIOME_IDS.length; i++) {
    const w = weights[i];
    if (w <= 0.001) continue;
    tmpColor.setHex(defs[BIOME_IDS[i]].grassColor, LinearSRGBColorSpace);
    target.r += tmpColor.r * w;
    target.g += tmpColor.g * w;
    target.b += tmpColor.b * w;
    total += w;
  }
  if (total > 0) target.multiplyScalar(TINT_GAIN / total);
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
