import { Color, DoubleSide, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Vector3 } from 'three';
import { MeshBuilder } from './MeshBuilder';
import {
  concreteMaterial,
  metalMaterial,
  plainMaterial,
  roofMaterial,
  sidingMaterial,
  unitBox,
  unitCylinder,
} from './Prefabs';
import { textures } from '../materials/TextureFactory';
import { trackMatrix } from '../world/TrackFrame';
import { TRACK_SPACING } from '../world/TrackPath';
import type { ChunkContext } from '../world/ChunkContext';
import type { StationInfo } from '../world/TrackPath';

/**
 * Stations: side platforms, canopies, name boards, lighting, a small station
 * building and the stopping-position marker the driver aims for.
 */

const PLATFORM_HEIGHT = 1.05;
const PLATFORM_WIDTH = 4.6;
const EDGE_CLEARANCE = 1.65;

export function buildStations(ctx: ChunkContext): void {
  for (const station of ctx.track.stations) {
    if (station.s < ctx.sStart || station.s >= ctx.sEnd) continue;
    buildStation(ctx, station);
  }
}

function buildStation(ctx: ChunkContext, station: StationInfo): void {
  const structure = new MeshBuilder();
  const concrete = new MeshBuilder();
  const metal = new MeshBuilder();
  const matrix = new Matrix4();
  const scale = new Vector3();

  const half = station.platformLength * 0.5;
  const sides = station.platformSide === 0 ? [-1, 1] : [station.platformSide];

  const slabColor = new Color(0.9, 0.89, 0.86);
  const tactileColor = new Color(1.0, 0.78, 0.16);
  const steel = new Color(0.72, 0.74, 0.76);
  const roofColor = new Color(0.42, 0.46, 0.5);

  for (const side of sides) {
    const trackCentre = side * (TRACK_SPACING / 2);
    const edge = trackCentre + side * EDGE_CLEARANCE;
    const outer = edge + side * PLATFORM_WIDTH;
    const centreLat = (edge + outer) * 0.5;

    // Platform slab, built from short segments so it follows the alignment.
    const segments = Math.max(6, Math.round(station.platformLength / 6));
    for (let i = 0; i < segments; i++) {
      const s = station.s - half + (i + 0.5) * (station.platformLength / segments);
      const sample = ctx.track.sampleAt(s);
      scale.set(PLATFORM_WIDTH, PLATFORM_HEIGHT, station.platformLength / segments + 0.05);
      trackMatrix(sample, centreLat, -0.9, matrix, 0, scale);
      concrete.add(unitBox(), matrix, slabColor);

      // Yellow tactile strip along the platform edge.
      scale.set(0.62, 0.03, station.platformLength / segments + 0.05);
      trackMatrix(sample, edge + side * 0.42, PLATFORM_HEIGHT - 0.9, matrix, 0, scale);
      concrete.add(unitBox(), matrix, tactileColor);
    }

    // Canopy over the middle two thirds of the platform.
    if (station.hasCanopy) {
      const canopyLength = station.platformLength * 0.68;
      const columnCount = Math.max(3, Math.round(canopyLength / 9));
      for (let i = 0; i <= columnCount; i++) {
        const s = station.s - canopyLength / 2 + (i * canopyLength) / columnCount;
        const sample = ctx.track.sampleAt(s);
        scale.set(0.18, 3.3, 0.18);
        trackMatrix(sample, centreLat + side * 1.1, PLATFORM_HEIGHT - 0.9, matrix, 0, scale);
        metal.add(unitBox(), matrix, steel);
        // Roof beam.
        if (i < columnCount) {
          scale.set(PLATFORM_WIDTH + 0.6, 0.16, canopyLength / columnCount + 0.05);
          trackMatrix(
            sample,
            centreLat,
            PLATFORM_HEIGHT + 2.4 - 0.9,
            matrix,
            0,
            scale,
          );
          metal.add(unitBox(), matrix, steel);
          scale.set(PLATFORM_WIDTH + 1.4, 0.12, canopyLength / columnCount + 0.05);
          trackMatrix(sample, centreLat, PLATFORM_HEIGHT + 2.62 - 0.9, matrix, 0, scale);
          structure.add(unitBox(), matrix, roofColor);
        }
      }
    }

    // Fence along the back of the platform.
    const fenceSegments = Math.round(station.platformLength / 3);
    for (let i = 0; i < fenceSegments; i++) {
      const s = station.s - half + (i + 0.5) * (station.platformLength / fenceSegments);
      const sample = ctx.track.sampleAt(s);
      scale.set(0.06, 1.1, 0.06);
      trackMatrix(sample, outer - side * 0.15, PLATFORM_HEIGHT - 0.9, matrix, 0, scale);
      metal.add(unitBox(), matrix, steel);
      scale.set(0.05, 0.05, station.platformLength / fenceSegments);
      trackMatrix(sample, outer - side * 0.15, PLATFORM_HEIGHT + 0.95 - 0.9, matrix, 0, scale);
      metal.add(unitBox(), matrix, steel);
    }

    // Benches, with a back, and lamp posts.
    for (let i = 0; i < 3; i++) {
      const s = station.s - half * 0.6 + (i * half * 0.6);
      const sample = ctx.track.sampleAt(s);
      const timber = new Color(0.55, 0.42, 0.3);
      scale.set(0.5, 0.45, 1.8);
      trackMatrix(sample, outer - side * 1.0, PLATFORM_HEIGHT - 0.9, matrix, 0, scale);
      structure.add(unitBox(), matrix, timber);
      scale.set(0.1, 0.55, 1.8);
      trackMatrix(sample, outer - side * 0.78, PLATFORM_HEIGHT - 0.45, matrix, 0, scale);
      structure.add(unitBox(), matrix, timber);
      scale.set(0.12, 3.6, 0.12);
      trackMatrix(sample, outer - side * 0.6, PLATFORM_HEIGHT - 0.9, matrix, 0, scale);
      metal.add(unitBox(), matrix, steel);
    }

    // A drinks machine and a notice board: the two things that are on every
    // platform in the country.
    const kioskSample = ctx.track.sampleAt(station.s + half * 0.3);
    scale.set(0.72, 1.85, 1.2);
    trackMatrix(kioskSample, outer - side * 0.85, PLATFORM_HEIGHT - 0.9, matrix, 0, scale);
    structure.add(unitBox(), matrix, new Color(0.72, 0.14, 0.13));
    scale.set(0.12, 1.15, 1.05);
    trackMatrix(kioskSample, outer - side * 1.28, PLATFORM_HEIGHT - 0.32, matrix, 0, scale);
    structure.add(unitBox(), matrix, new Color(0.86, 0.87, 0.9));
    const boardSample = ctx.track.sampleAt(station.s - half * 0.3);
    scale.set(0.1, 1.15, 2.0);
    trackMatrix(boardSample, outer - side * 0.4, PLATFORM_HEIGHT - 0.05, matrix, 0, scale);
    structure.add(unitBox(), matrix, new Color(0.9, 0.9, 0.87));
    for (const legOffset of [-0.8, 0.8]) {
      scale.set(0.07, 1.0, 0.07);
      trackMatrix(
        ctx.track.sampleAt(station.s - half * 0.3 + legOffset),
        outer - side * 0.4,
        PLATFORM_HEIGHT - 0.9,
        matrix, 0, scale,
      );
      metal.add(unitBox(), matrix, steel);
    }

    // Rural platforms get a waiting shelter instead of a full canopy.
    if (!station.hasCanopy) {
      const shelterSample = ctx.track.sampleAt(station.s);
      scale.set(2.4, 2.3, 4.0);
      trackMatrix(shelterSample, outer - side * 1.4, PLATFORM_HEIGHT - 0.9, matrix, 0, scale);
      structure.add(unitBox(), matrix, new Color(0.86, 0.85, 0.8));
      scale.set(3.0, 0.2, 4.6);
      trackMatrix(shelterSample, outer - side * 1.4, PLATFORM_HEIGHT + 1.4, matrix, 0, scale);
      structure.add(unitBox(), matrix, roofColor);
    }
  }

  // Station name boards, one on each platform, facing the train.
  const signMaterial = new MeshStandardMaterial({
    map: textures.stationSign(station.name.ja, station.name.ro),
    roughness: 0.7,
    metalness: 0,
    side: DoubleSide,
  });
  const signGeo = new PlaneGeometry(2.6, 0.65);
  for (const side of sides) {
    for (const offset of [-half * 0.45, half * 0.45]) {
      const sample = ctx.track.sampleAt(station.s + offset);
      const sign = new Mesh(signGeo, signMaterial);
      const lat = side * (TRACK_SPACING / 2 + EDGE_CLEARANCE + 1.0);
      const m = new Matrix4();
      trackMatrix(sample, lat, PLATFORM_HEIGHT + 1.75 - 0.9, m, Math.PI / 2);
      sign.applyMatrix4(m);
      sign.matrixAutoUpdate = false;
      sign.updateMatrix();
      sign.userData.ownsGeometry = true;
      sign.userData.ownsMaterial = true;
      ctx.group.add(sign);
    }
  }

  // Station building on the outer side of the first platform.
  const buildingSide = sides[0];
  const buildingSample = ctx.track.sampleAt(station.s - half * 0.2);
  const buildingLat = buildingSide * (TRACK_SPACING / 2 + EDGE_CLEARANCE + PLATFORM_WIDTH + 6);
  const wall = new MeshBuilder();
  const roof = new MeshBuilder();
  const w = 11;
  const d = 8;
  const h = station.biome === 'city' ? 7.5 : 4.2;
  scale.set(w, h, d);
  trackMatrix(buildingSample, buildingLat, -1.0, matrix, 0, scale);
  wall.add(unitBox(), matrix, new Color(0.92, 0.9, 0.85));
  scale.set(w + 1.2, 1.6, d + 1.2);
  trackMatrix(buildingSample, buildingLat, h - 1.0, matrix, 0, scale);
  roof.add(unitBox(), matrix, new Color(0.35, 0.36, 0.4));

  // Covered walkway linking the building to the platform.
  scale.set(6.2, 0.18, 3.0);
  trackMatrix(buildingSample, buildingLat - buildingSide * 5.6, 2.6 - 1.0, matrix, 0, scale);
  roof.add(unitBox(), matrix, new Color(0.4, 0.42, 0.46));

  // Stopping position marker: the driver lines the cab up with this.
  const markerSample = ctx.track.sampleAt(station.s + half - 6);
  scale.set(0.1, 2.2, 0.1);
  trackMatrix(markerSample, -(TRACK_SPACING / 2) - 2.6, -0.6, matrix, 0, scale);
  metal.add(unitBox(), matrix, new Color(0.9, 0.9, 0.88));
  scale.set(0.5, 0.5, 0.06);
  trackMatrix(markerSample, -(TRACK_SPACING / 2) - 2.6, 1.6, matrix, 0, scale);
  metal.add(unitBox(), matrix, new Color(0.95, 0.85, 0.2));

  const meshes: (Mesh | null)[] = [
    concrete.toMesh(concreteMaterial(), false, 'platform'),
    metal.toMesh(metalMaterial(), false, 'station-metal'),
    structure.toMesh(plainMaterial(), false, 'station-structure'),
    wall.toMesh(sidingMaterial(), false, 'station-building'),
    roof.toMesh(roofMaterial(), false, 'station-roof'),
  ];
  for (const mesh of meshes) {
    if (!mesh) continue;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    ctx.group.add(mesh);
  }

  // Platform lighting: warm pools of light that only matter after dark.
  const lampMaterial = new MeshBasicMaterial({ color: 0xfff0d0 });
  for (const side of sides) {
    for (let i = -1; i <= 1; i++) {
      const sample = ctx.track.sampleAt(station.s + i * half * 0.55);
      const lamp = new Mesh(unitCylinder(6), lampMaterial);
      const m = new Matrix4();
      const lat =
        side * (TRACK_SPACING / 2 + EDGE_CLEARANCE + PLATFORM_WIDTH - 0.6);
      trackMatrix(sample, lat, PLATFORM_HEIGHT + 2.6 - 0.9, m, 0, new Vector3(0.4, 0.12, 0.4));
      lamp.applyMatrix4(m);
      lamp.matrixAutoUpdate = false;
      lamp.updateMatrix();
      lamp.userData.nightOnly = true;
      ctx.group.add(lamp);
    }
  }
}
