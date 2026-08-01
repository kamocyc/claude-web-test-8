import { detectLanguage, type Language } from '../ui/i18n';

/** Graphics quality presets and user-tweakable options. */

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityProfile {
  /** Upper bound on devicePixelRatio used for the drawing buffer. */
  maxPixelRatio: number;
  /** Shadow atlas resolution for the sun. */
  shadowMapSize: number;
  /** Half-extent of the sun's orthographic shadow frustum, metres. */
  shadowDistance: number;
  /** Camera far plane / fog extent, metres. */
  viewDistance: number;
  /** Number of terrain chunks kept loaded ahead of the train. */
  chunksAhead: number;
  /** Number of chunks kept behind for the rear view. */
  chunksBehind: number;
  /** Scatter density multiplier for vegetation and buildings. */
  sceneryDensity: number;
  /** Distance at which detailed sleepers stop being generated. */
  detailDistance: number;
  bloom: boolean;
  ssao: boolean;
  grain: boolean;
  /** Anisotropic filtering level requested for ground textures. */
  anisotropy: number;
  /** Grass tufts along the lineside. */
  grass: boolean;
  /** Per-frame chunk build budget in milliseconds. */
  buildBudgetMs: number;
}

export const QUALITY_PROFILES: Record<QualityLevel, QualityProfile> = {
  low: {
    maxPixelRatio: 1,
    shadowMapSize: 1024,
    shadowDistance: 120,
    viewDistance: 2200,
    chunksAhead: 7,
    chunksBehind: 2,
    sceneryDensity: 0.45,
    detailDistance: 220,
    bloom: false,
    ssao: false,
    grain: false,
    anisotropy: 2,
    grass: false,
    buildBudgetMs: 5,
  },
  medium: {
    maxPixelRatio: 1.25,
    shadowMapSize: 2048,
    shadowDistance: 180,
    viewDistance: 3200,
    chunksAhead: 9,
    chunksBehind: 3,
    sceneryDensity: 0.75,
    detailDistance: 340,
    bloom: true,
    ssao: false,
    grain: true,
    anisotropy: 4,
    grass: true,
    buildBudgetMs: 7,
  },
  high: {
    maxPixelRatio: 1.5,
    shadowMapSize: 3072,
    shadowDistance: 240,
    viewDistance: 4200,
    chunksAhead: 12,
    chunksBehind: 3,
    sceneryDensity: 1.0,
    detailDistance: 460,
    bloom: true,
    ssao: false,
    grain: true,
    anisotropy: 8,
    grass: true,
    buildBudgetMs: 9,
  },
  ultra: {
    maxPixelRatio: 2,
    shadowMapSize: 4096,
    shadowDistance: 320,
    viewDistance: 5200,
    chunksAhead: 15,
    chunksBehind: 4,
    sceneryDensity: 1.35,
    detailDistance: 620,
    bloom: true,
    ssao: true,
    grain: true,
    anisotropy: 16,
    grass: true,
    buildBudgetMs: 11,
  },
};

export interface GameSettings {
  quality: QualityLevel;
  /** Interface language. */
  language: Language;
  masterVolume: number;
  /** Field of view of the cab camera, degrees. */
  fov: number;
  /** Cab vibration and camera shake intensity. */
  shake: number;
  /** Show the driver's aid overlay (stopping marker, brake curve). */
  assist: boolean;
  /** Realistic notch handling requires releasing power before braking. */
  strictInterlock: boolean;
}

const STORAGE_KEY = 'infinite-rail.settings.v1';

export const DEFAULT_SETTINGS: GameSettings = {
  quality: 'high',
  language: 'en',
  masterVolume: 0.8,
  fov: 62,
  shake: 1,
  assist: true,
  strictInterlock: true,
};

/** Picks a starting quality level from coarse device hints. */
export function detectQuality(): QualityLevel {
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  if (mobile || cores <= 4 || mem <= 4) return 'medium';
  if (cores >= 12 && mem >= 16) return 'ultra';
  return 'high';
}

export function loadSettings(): GameSettings {
  const base: GameSettings = {
    ...DEFAULT_SETTINGS,
    quality: detectQuality(),
    language: detectLanguage(),
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    return { ...base, ...parsed };
  } catch {
    return base;
  }
}

export function saveSettings(settings: GameSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable - settings simply do not persist */
  }
}
