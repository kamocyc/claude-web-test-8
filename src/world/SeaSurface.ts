import { BufferAttribute, BufferGeometry, Mesh, type ShaderMaterial } from 'three';
import type { TerrainField } from './TerrainField';

/**
 * The open sea.
 *
 * A radial grid centred on the camera: dense enough close in to carry the wave
 * displacement, stretching to the horizon in a few thousand vertices. Water
 * depth is sampled from the terrain field so the shader can fade the surface
 * out and foam it up along the shoreline.
 */
export class SeaSurface {
  readonly mesh: Mesh;
  private readonly rings = 76;
  private readonly sectors = 72;
  private readonly radii: number[] = [];
  private readonly depths: Float32Array;
  private readonly positions: Float32Array;

  private snapX = Number.NaN;
  private snapZ = Number.NaN;
  private dirtyFrom = 0;
  private dirty = true;

  constructor(
    private readonly field: TerrainField,
    material: ShaderMaterial,
  ) {
    for (let k = 0; k <= this.rings; k++) {
      this.radii.push(2.5 * (Math.pow(1.0955, k) - 1));
    }

    const vertexCount = (this.rings + 1) * this.sectors;
    this.positions = new Float32Array(vertexCount * 3);
    this.depths = new Float32Array(vertexCount);
    const flow = new Float32Array(vertexCount);

    for (let k = 0; k <= this.rings; k++) {
      const r = this.radii[k];
      for (let a = 0; a < this.sectors; a++) {
        const idx = k * this.sectors + a;
        const theta = (a / this.sectors) * Math.PI * 2;
        this.positions[idx * 3] = Math.cos(theta) * r;
        this.positions[idx * 3 + 1] = 0;
        this.positions[idx * 3 + 2] = Math.sin(theta) * r;
        this.depths[idx] = 40;
      }
    }

    const indices: number[] = [];
    for (let k = 0; k < this.rings; k++) {
      for (let a = 0; a < this.sectors; a++) {
        const a1 = (a + 1) % this.sectors;
        const i0 = k * this.sectors + a;
        const i1 = k * this.sectors + a1;
        const i2 = (k + 1) * this.sectors + a;
        const i3 = (k + 1) * this.sectors + a1;
        indices.push(i0, i2, i1, i1, i2, i3);
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    geometry.setAttribute('aDepth', new BufferAttribute(this.depths, 1));
    geometry.setAttribute('aFlow', new BufferAttribute(flow, 1));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    geometry.boundingSphere!.radius = this.radii[this.rings] * 1.2;

    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'sea';
  }

  /**
   * Moves the grid with the camera (snapped, so vertices do not swim) and
   * refreshes a slice of the depth samples each frame.
   */
  update(cameraX: number, cameraZ: number, slice = 2200): void {
    const snap = 12;
    const sx = Math.round(cameraX / snap) * snap;
    const sz = Math.round(cameraZ / snap) * snap;
    if (sx !== this.snapX || sz !== this.snapZ) {
      this.snapX = sx;
      this.snapZ = sz;
      this.mesh.position.set(sx, 0, sz);
      this.dirty = true;
      this.dirtyFrom = 0;
    }
    if (!this.dirty) return;

    const total = this.depths.length;
    const end = Math.min(total, this.dirtyFrom + slice);
    let hint = -1;
    for (let i = this.dirtyFrom; i < end; i++) {
      const x = this.positions[i * 3] + sx;
      const z = this.positions[i * 3 + 2] + sz;
      const result = this.field.heightAt(x, z, hint);
      hint = result.projection.hint;
      this.depths[i] = Math.max(0, -result.y);
    }
    this.dirtyFrom = end;
    const attr = this.mesh.geometry.getAttribute('aDepth') as BufferAttribute;
    attr.needsUpdate = true;
    if (end >= total) this.dirty = false;
  }

  /** Hides the sea entirely when the route is nowhere near the coast. */
  setVisible(visible: boolean): void {
    this.mesh.visible = visible;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
