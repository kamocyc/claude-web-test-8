import { Group, InstancedMesh, Mesh, type Material } from 'three';
import { Rng } from '../core/Random';
import type { QualityProfile } from '../core/Settings';
import type { WaterRegistry } from '../materials/WaterMaterial';
import { CHUNK_LENGTH, type ChunkContext, type DynamicCrossing, type DynamicSignal } from './ChunkContext';
import type { TerrainField } from './TerrainField';
import { SAMPLE_STEP, type TrackPath, type TrackSample } from './TrackPath';
import {
  buildBallast,
  buildCatenary,
  buildCrossings,
  buildFormation,
  buildRails,
  buildSigns,
  buildSignals,
  buildSleepers,
} from '../builders/TrackBuilder';
import { buildStations } from '../builders/StationBuilder';
import { buildBridges, buildTunnels } from '../builders/StructureBuilder';
import {
  buildBuildings,
  buildFields,
  buildGroundCover,
  buildLinesideDetail,
  buildRoads,
  buildVegetation,
  buildWaterways,
} from '../builders/SceneryBuilder';

/**
 * A 250 m slice of railway and its surroundings.
 *
 * Chunks are built ahead of the train and thrown away behind it. Everything
 * inside one is static, so a chunk is built once and then only touched by the
 * signalling and level crossing animation.
 */
export class Chunk {
  readonly group = new Group();
  readonly signals: DynamicSignal[] = [];
  readonly crossings: DynamicCrossing[] = [];
  readonly sStart: number;
  readonly sEnd: number;

  constructor(
    readonly index: number,
    track: TrackPath,
    field: TerrainField,
    profile: QualityProfile,
    water: WaterRegistry,
    detailed: boolean,
    seed: number,
  ) {
    this.sStart = index * CHUNK_LENGTH;
    this.sEnd = this.sStart + CHUNK_LENGTH;
    this.group.name = `chunk-${index}`;
    this.group.matrixAutoUpdate = false;

    const samples: TrackSample[] = [];
    for (let s = this.sStart; s <= this.sEnd + 0.001; s += SAMPLE_STEP) {
      samples.push(track.at(track.sampleIndex(s)));
    }

    const ctx: ChunkContext = {
      track,
      field,
      sStart: this.sStart,
      sEnd: this.sEnd,
      rng: new Rng((seed ^ (index * 0x9e3779b1)) >>> 0),
      profile,
      samples,
      group: this.group,
      water,
      signals: this.signals,
      crossings: this.crossings,
      detailed,
    };

    buildFormation(ctx);
    buildBallast(ctx);
    buildRails(ctx);
    if (detailed) buildSleepers(ctx);
    buildCatenary(ctx);
    buildBridges(ctx);
    buildTunnels(ctx);
    buildStations(ctx);
    buildSignals(ctx);
    buildSigns(ctx);
    buildCrossings(ctx);
    buildWaterways(ctx);
    buildFields(ctx);
    buildRoads(ctx);
    buildBuildings(ctx);
    buildVegetation(ctx);
    buildGroundCover(ctx);
    buildLinesideDetail(ctx);

    this.group.updateMatrix();
    this.group.updateMatrixWorld(true);
  }

  dispose(): void {
    this.group.traverse((obj) => {
      const mesh = obj as Mesh | InstancedMesh;
      if (!mesh.isMesh && !(mesh as InstancedMesh).isInstancedMesh) return;
      if (mesh.userData.ownsGeometry && mesh.geometry) mesh.geometry.dispose();
      if (mesh.userData.ownsMaterial) {
        const material = mesh.material as Material | Material[];
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
      if ((mesh as InstancedMesh).isInstancedMesh) {
        (mesh as InstancedMesh).dispose();
      }
    });
    this.group.clear();
    this.signals.length = 0;
    this.crossings.length = 0;
  }
}
