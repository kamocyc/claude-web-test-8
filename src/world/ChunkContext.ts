import type { Group, Mesh, Object3D } from 'three';
import type { Rng } from '../core/Random';
import type { QualityProfile } from '../core/Settings';
import type { TrackPath, TrackSample, SignalInfo, CrossingInfo } from './TrackPath';
import type { TerrainField } from './TerrainField';
import type { WaterRegistry } from '../materials/WaterMaterial';
import type { Occupancy } from './Sites';

/** A signal that the block logic can re-aspect at runtime. */
export interface DynamicSignal {
  info: SignalInfo;
  lamps: [Mesh, Mesh, Mesh]; // red, yellow, green
}

/** A level crossing whose barriers and lights animate as a train approaches. */
export interface DynamicCrossing {
  info: CrossingInfo;
  barriers: Object3D[];
  lamps: Mesh[];
  /** 0 = raised, 1 = fully lowered. */
  state: number;
  bellPhase: number;
}

export interface ChunkContext {
  track: TrackPath;
  field: TerrainField;
  sStart: number;
  sEnd: number;
  rng: Rng;
  profile: QualityProfile;
  /** Samples spanning the chunk, inclusive of both ends. */
  samples: TrackSample[];
  group: Group;
  water: WaterRegistry;
  signals: DynamicSignal[];
  crossings: DynamicCrossing[];
  /** Chunks far from the camera skip the finest details. */
  detailed: boolean;
  /** Ground booked by whatever has already been built in this chunk. */
  sites: Occupancy;
}

export const CHUNK_LENGTH = 250;
