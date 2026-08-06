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
  /**
   * How far in front of the camera the shadow box is centred, metres. The sun
   * rig is otherwise parked on the camera, which spends half the shadow atlas
   * on ground the driver cannot see.
   */
  shadowFocus: number;
  /** Radius of the PCF filter in shadow texels; larger is softer and dearer. */
  shadowSoftness: number;
  bloom: boolean;
  /** Octaves in the bloom pyramid. More is wider and softer. */
  bloomLevels: number;
  bloomStrength: number;
  /** Screen-space ambient occlusion. */
  ao: boolean;
  /** Resolution of the occlusion buffer as a fraction of the frame. */
  aoScale: number;
  /** Spiral samples per pixel in the occlusion estimator. */
  aoSamples: number;
  /** Aerial perspective and the depth-aware composite. */
  atmosphere: boolean;
  /** Screen-space crepuscular rays. */
  godRays: boolean;
  /** Metered exposure with eye adaptation. */
  autoExposure: boolean;
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
    shadowDistance: 110,
    viewDistance: 2200,
    chunksAhead: 7,
    chunksBehind: 2,
    sceneryDensity: 0.45,
    detailDistance: 220,
    shadowFocus: 50,
    shadowSoftness: 1.4,
    bloom: false,
    bloomLevels: 0,
    bloomStrength: 0,
    ao: false,
    aoScale: 0.5,
    aoSamples: 8,
    atmosphere: false,
    godRays: false,
    autoExposure: true,
    grain: false,
    anisotropy: 2,
    grass: false,
    buildBudgetMs: 5,
  },
  medium: {
    maxPixelRatio: 1.25,
    shadowMapSize: 2048,
    shadowDistance: 170,
    viewDistance: 3200,
    chunksAhead: 9,
    chunksBehind: 3,
    sceneryDensity: 0.75,
    detailDistance: 340,
    shadowFocus: 78,
    shadowSoftness: 1.8,
    bloom: true,
    bloomLevels: 5,
    bloomStrength: 0.085,
    ao: false,
    aoScale: 0.5,
    aoSamples: 8,
    atmosphere: true,
    godRays: false,
    autoExposure: true,
    grain: true,
    anisotropy: 4,
    grass: true,
    buildBudgetMs: 7,
  },
  high: {
    maxPixelRatio: 1.5,
    shadowMapSize: 3072,
    shadowDistance: 210,
    viewDistance: 4200,
    chunksAhead: 12,
    chunksBehind: 3,
    sceneryDensity: 1.0,
    detailDistance: 460,
    shadowFocus: 95,
    shadowSoftness: 2.4,
    bloom: true,
    bloomLevels: 6,
    bloomStrength: 0.095,
    ao: true,
    aoScale: 0.5,
    aoSamples: 12,
    atmosphere: true,
    godRays: true,
    autoExposure: true,
    grain: true,
    anisotropy: 8,
    grass: true,
    buildBudgetMs: 9,
  },
  ultra: {
    maxPixelRatio: 2,
    shadowMapSize: 4096,
    shadowDistance: 270,
    viewDistance: 5200,
    chunksAhead: 15,
    chunksBehind: 4,
    sceneryDensity: 1.35,
    detailDistance: 620,
    shadowFocus: 125,
    shadowSoftness: 3.0,
    bloom: true,
    bloomLevels: 7,
    bloomStrength: 0.1,
    ao: true,
    aoScale: 1.0,
    aoSamples: 16,
    atmosphere: true,
    godRays: true,
    autoExposure: true,
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

/** `?quality=ultra` pins the preset, which is how the shot tool compares them. */
function forcedQuality(): QualityLevel | null {
  if (typeof location === 'undefined') return null;
  const value = new URLSearchParams(location.search).get('quality');
  return value && value in QUALITY_PROFILES ? (value as QualityLevel) : null;
}

export function loadSettings(): GameSettings {
  const base: GameSettings = {
    ...DEFAULT_SETTINGS,
    quality: detectQuality(),
    language: detectLanguage(),
  };
  const forced = forcedQuality();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return forced ? { ...base, quality: forced } : base;
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    const merged = { ...base, ...parsed };
    return forced ? { ...merged, quality: forced } : merged;
  } catch {
    return forced ? { ...base, quality: forced } : base;
  }
}

export function saveSettings(settings: GameSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* storage unavailable - settings simply do not persist */
  }
}
