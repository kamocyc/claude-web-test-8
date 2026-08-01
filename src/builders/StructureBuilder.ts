import { BackSide, Color, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three';
import { MeshBuilder } from './MeshBuilder';
import { concreteMaterial, metalMaterial, unitBox, unitCylinder } from './Prefabs';
import { textures } from '../materials/TextureFactory';
import { trackMatrix, trackPoint } from '../world/TrackFrame';
import type { ChunkContext } from '../world/ChunkContext';

/**
 * Bridges and tunnels.
 *
 * Both are generated from the route's structure list, so a chunk only builds
 * the part of a structure that falls inside it and long bores stay seamless.
 */

export function buildBridges(ctx: ChunkContext): void {
  for (const bridge of ctx.track.bridges) {
    if (bridge.sEnd < ctx.sStart || bridge.sStart >= ctx.sEnd) continue;
    const from = Math.max(bridge.sStart, ctx.sStart);
    const to = Math.min(bridge.sEnd, ctx.sEnd);

    const structure = new MeshBuilder();
    const deck = new MeshBuilder();
    const matrix = new Matrix4();
    const scale = new Vector3();
    const steel = new Color(0.36, 0.44, 0.5);
    const concrete = new Color(0.78, 0.77, 0.74);

    const step = 5;
    for (let s = from; s < to; s += step) {
      const sample = ctx.track.sampleAt(s);
      // Deck slab carrying the ballast.
      scale.set(11.4, 0.55, step + 0.1);
      trackMatrix(sample, 0, -1.45, matrix, 0, scale);
      deck.add(unitBox(), matrix, concrete);
      // Main girders under each road.
      for (const side of [-1, 1]) {
        scale.set(0.5, 1.5, step + 0.1);
        trackMatrix(sample, side * 3.4, -2.9, matrix, 0, scale);
        structure.add(unitBox(), matrix, steel);
      }
      // Parapet.
      for (const side of [-1, 1]) {
        scale.set(0.22, 1.15, step + 0.1);
        trackMatrix(sample, side * 5.6, -0.9, matrix, 0, scale);
        structure.add(unitBox(), matrix, steel);
      }
    }

    // Piers down to the ground, spaced along the span.
    const pierSpacing = bridge.kind === 'viaduct' ? 18 : 34;
    for (let s = Math.ceil(from / pierSpacing) * pierSpacing; s < to; s += pierSpacing) {
      const sample = ctx.track.sampleAt(s);
      const p = trackPoint(sample, 0, 0, new Vector3());
      const groundY = ctx.field.natural(sample, 0, p.x, p.z);
      const height = Math.max(1.5, sample.y - 2.9 - groundY);
      scale.set(2.6, height, 2.0);
      trackMatrix(sample, 0, -2.9 - height, matrix, 0, scale);
      structure.add(unitBox(), matrix, concrete);
      scale.set(4.2, 0.8, 3.2);
      trackMatrix(sample, 0, -2.9 - height, matrix, 0, scale);
      structure.add(unitBox(), matrix, concrete);
    }

    // Truss bridges get a through-truss above the deck.
    if (bridge.kind === 'truss') {
      const panel = 7;
      for (let s = from; s < to - panel; s += panel) {
        const sample = ctx.track.sampleAt(s);
        for (const side of [-1, 1]) {
          scale.set(0.28, 6.4, 0.28);
          trackMatrix(sample, side * 5.6, -0.4, matrix, 0, scale);
          structure.add(unitBox(), matrix, steel);
          // Diagonal.
          const diag = new Matrix4();
          trackMatrix(sample, side * 5.6, 2.6, diag, 0);
          const local = new Matrix4()
            .makeRotationX(Math.atan2(panel, 6))
            .premultiply(diag);
          const scaled = new Matrix4().makeScale(0.22, Math.hypot(panel, 6), 0.22);
          structure.add(unitBox(), local.multiply(scaled), steel);
          // Top chord.
          scale.set(0.3, 0.3, panel + 0.1);
          trackMatrix(sample, side * 5.6, 5.9, matrix, 0, scale);
          structure.add(unitBox(), matrix, steel);
        }
        // Cross bracing overhead.
        scale.set(11.2, 0.24, 0.24);
        trackMatrix(sample, 0, 6.0, matrix, 0, scale);
        structure.add(unitBox(), matrix, steel);
      }
    }

    const deckMesh = deck.toMesh(concreteMaterial(), false, 'bridge-deck');
    if (deckMesh) {
      deckMesh.receiveShadow = true;
      deckMesh.castShadow = true;
      ctx.group.add(deckMesh);
    }
    const structureMesh = structure.toMesh(metalMaterial(), false, 'bridge-structure');
    if (structureMesh) {
      structureMesh.castShadow = true;
      structureMesh.receiveShadow = true;
      ctx.group.add(structureMesh);
    }
  }
}

let tunnelInteriorMaterial: MeshStandardMaterial | null = null;
function getTunnelMaterial(): MeshStandardMaterial {
  if (!tunnelInteriorMaterial) {
    tunnelInteriorMaterial = new MeshStandardMaterial({
      map: textures.concrete(),
      color: 0x6a6660,
      roughness: 0.97,
      metalness: 0,
      side: BackSide,
      vertexColors: true,
    });
  }
  return tunnelInteriorMaterial;
}

/** Tunnel bore, portals and the lights strung along the wall. */
export function buildTunnels(ctx: ChunkContext): void {
  for (const tunnel of ctx.track.tunnels) {
    if (tunnel.sEnd < ctx.sStart || tunnel.sStart >= ctx.sEnd) continue;
    const from = Math.max(tunnel.sStart - 6, ctx.sStart);
    const to = Math.min(tunnel.sEnd + 6, ctx.sEnd);

    const bore = new MeshBuilder();
    const portal = new MeshBuilder();
    const wallColor = new Color(0.62, 0.6, 0.57);

    // Arched profile: walls, then a semicircular crown.
    const profile: [number, number][] = [];
    profile.push([-5.2, -1.2]);
    profile.push([-5.2, 2.0]);
    const arcSteps = 9;
    for (let i = 0; i <= arcSteps; i++) {
      const a = Math.PI - (i / arcSteps) * Math.PI;
      profile.push([Math.cos(a) * 5.2, 2.0 + Math.sin(a) * 4.0]);
    }
    profile.push([5.2, 2.0]);
    profile.push([5.2, -1.2]);

    const rows: Vector3[][] = [];
    const uvV: number[] = [];
    const step = 6;
    for (let s = from; s <= to; s += step) {
      const sample = ctx.track.sampleAt(s);
      const row: Vector3[] = [];
      for (const [lat, h] of profile) row.push(trackPoint(sample, lat, h, new Vector3()));
      rows.push(row);
      uvV.push(s * 0.12);
    }
    if (rows.length > 1) {
      const uvU = profile.map((_, i) => (i / profile.length) * 3);
      bore.addSweep(rows, wallColor, uvV, uvU, false);
    }

    const boreMesh = bore.toMesh(getTunnelMaterial(), true, 'tunnel-bore');
    if (boreMesh) {
      boreMesh.receiveShadow = true;
      ctx.group.add(boreMesh);
    }

    // Portals at either end.
    const matrix = new Matrix4();
    const scale = new Vector3();
    for (const [portalS, dir] of [
      [tunnel.sStart, -1],
      [tunnel.sEnd, 1],
    ] as [number, number][]) {
      if (portalS < ctx.sStart || portalS >= ctx.sEnd) continue;
      const sample = ctx.track.sampleAt(portalS);
      const face = new Color(0.72, 0.7, 0.66);
      // A slab with the bore punched through, faked with four blocks.
      scale.set(16, 3.2, 1.2);
      trackMatrix(sample, 0, 6.0, matrix, 0, scale);
      portal.add(unitBox(), matrix, face);
      for (const side of [-1, 1]) {
        scale.set(2.8, 9.2, 1.2);
        trackMatrix(sample, side * 6.6, -1.2, matrix, 0, scale);
        portal.add(unitBox(), matrix, face);
      }
      // Wing walls.
      for (const side of [-1, 1]) {
        scale.set(0.9, 4.5, 5.0);
        trackMatrix(sample, side * 7.6, -1.2, matrix, 0, scale);
        portal.add(unitBox(), matrix, face);
      }
      void dir;
    }

    const portalMesh = portal.toMesh(concreteMaterial(), false, 'tunnel-portal');
    if (portalMesh) {
      portalMesh.castShadow = true;
      portalMesh.receiveShadow = true;
      ctx.group.add(portalMesh);
    }

    // Tunnel lighting.
    const lampMaterial = new MeshBasicMaterial({ color: 0xffe6b0 });
    for (let s = Math.ceil(from / 25) * 25; s < to; s += 25) {
      const sample = ctx.track.sampleAt(s);
      const lamp = new Mesh(unitCylinder(6), lampMaterial);
      const m = new Matrix4();
      trackMatrix(sample, -4.9, 4.4, m, 0, new Vector3(0.3, 0.1, 0.8));
      lamp.applyMatrix4(m);
      lamp.matrixAutoUpdate = false;
      lamp.updateMatrix();
      ctx.group.add(lamp);
    }
  }
}
