import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Matrix3,
  Matrix4,
  Vector3,
  type Material,
  Mesh,
} from 'three';

/**
 * Accumulates transformed primitives into a single buffer.
 *
 * Chunks contain hundreds of small objects; merging everything that shares a
 * material into one geometry keeps the draw call count per chunk in the low
 * tens instead of the hundreds.
 */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  private readonly normalMatrix = new Matrix3();
  private readonly v = new Vector3();

  get isEmpty(): boolean {
    return this.indices.length === 0;
  }

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** Appends an indexed geometry transformed by `matrix`. */
  add(geometry: BufferGeometry, matrix: Matrix4, color: Color, uvScale = 1, uvOffset = 0): void {
    const pos = geometry.getAttribute('position');
    const nor = geometry.getAttribute('normal');
    const uv = geometry.getAttribute('uv');
    const index = geometry.getIndex();
    const base = this.positions.length / 3;
    this.normalMatrix.getNormalMatrix(matrix);

    for (let i = 0; i < pos.count; i++) {
      this.v.fromBufferAttribute(pos as BufferAttribute, i).applyMatrix4(matrix);
      this.positions.push(this.v.x, this.v.y, this.v.z);
      if (nor) {
        this.v.fromBufferAttribute(nor as BufferAttribute, i).applyMatrix3(this.normalMatrix).normalize();
        this.normals.push(this.v.x, this.v.y, this.v.z);
      } else {
        this.normals.push(0, 1, 0);
      }
      if (uv) {
        this.uvs.push(uv.getX(i) * uvScale + uvOffset, uv.getY(i) * uvScale);
      } else {
        this.uvs.push(0, 0);
      }
      this.colors.push(color.r, color.g, color.b);
    }

    if (index) {
      for (let i = 0; i < index.count; i++) this.indices.push(base + index.getX(i));
    } else {
      for (let i = 0; i < pos.count; i++) this.indices.push(base + i);
    }
  }

  /** Appends a quad from four corners wound counter-clockwise. */
  addQuad(
    a: Vector3,
    b: Vector3,
    c: Vector3,
    d: Vector3,
    color: Color,
    uv: [number, number, number, number] = [0, 0, 1, 1],
    flipNormal = false,
  ): void {
    const base = this.positions.length / 3;
    const n = computeNormal(a, b, c, flipNormal);
    const corners = [a, b, c, d];
    const uvs = [
      [uv[0], uv[1]],
      [uv[2], uv[1]],
      [uv[2], uv[3]],
      [uv[0], uv[3]],
    ];
    for (let i = 0; i < 4; i++) {
      this.positions.push(corners[i].x, corners[i].y, corners[i].z);
      this.normals.push(n.x, n.y, n.z);
      this.uvs.push(uvs[i][0], uvs[i][1]);
      this.colors.push(color.r, color.g, color.b);
    }
    if (flipNormal) {
      this.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
    } else {
      this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  /** Appends a triangle. */
  addTriangle(a: Vector3, b: Vector3, c: Vector3, color: Color, flipNormal = false): void {
    const base = this.positions.length / 3;
    const n = computeNormal(a, b, c, flipNormal);
    for (const p of [a, b, c]) {
      this.positions.push(p.x, p.y, p.z);
      this.normals.push(n.x, n.y, n.z);
      this.uvs.push(0, 0);
      this.colors.push(color.r, color.g, color.b);
    }
    if (flipNormal) this.indices.push(base, base + 2, base + 1);
    else this.indices.push(base, base + 1, base + 2);
  }

  /**
   * Appends a swept surface: `rows` of equally sized point rings, stitched into
   * quads. Used for rails, ballast shoulders, roads and river banks.
   */
  addSweep(
    rows: Vector3[][],
    color: Color | Color[],
    uvV: number[],
    uvU: number[],
    closed = false,
  ): void {
    const base = this.positions.length / 3;
    const cols = rows[0].length;
    const perColumn = Array.isArray(color);
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols; c++) {
        const p = rows[r][c];
        const col = perColumn ? (color as Color[])[c] : (color as Color);
        this.positions.push(p.x, p.y, p.z);
        this.normals.push(0, 1, 0); // replaced by computeVertexNormals below
        this.uvs.push(uvU[c], uvV[r]);
        this.colors.push(col.r, col.g, col.b);
      }
    }
    const lastCol = closed ? cols : cols - 1;
    for (let r = 0; r < rows.length - 1; r++) {
      for (let c = 0; c < lastCol; c++) {
        const c1 = (c + 1) % cols;
        const a = base + r * cols + c;
        const b = base + r * cols + c1;
        const d = base + (r + 1) * cols + c;
        const e = base + (r + 1) * cols + c1;
        // Wound so the surface faces the side the column order sweeps towards:
        // for a profile traced anticlockwise in the section plane, that is
        // outwards.
        this.indices.push(a, b, d, b, e, d);
      }
    }
  }

  toGeometry(recomputeNormals = false): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(this.positions), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(this.normals), 3));
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(this.uvs), 2));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(this.colors), 3));
    geometry.setIndex(this.indices);
    if (recomputeNormals) geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /** Builds a mesh, or returns null when nothing was added. */
  toMesh(material: Material, recomputeNormals = false, name = ''): Mesh | null {
    if (this.isEmpty) return null;
    const mesh = new Mesh(this.toGeometry(recomputeNormals), material);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    // Geometry is unique to this mesh, so the owner may dispose it.
    mesh.userData.ownsGeometry = true;
    return mesh;
  }
}

const ab = new Vector3();
const ac = new Vector3();
const nrm = new Vector3();

function computeNormal(a: Vector3, b: Vector3, c: Vector3, flip: boolean): Vector3 {
  ab.subVectors(b, a);
  ac.subVectors(c, a);
  nrm.crossVectors(ab, ac).normalize();
  if (flip) nrm.negate();
  return nrm;
}

/** Fills a per-vertex attribute with a single value (used for water depth). */
export function addConstantAttribute(
  geometry: BufferGeometry,
  name: string,
  value: number,
): void {
  const count = geometry.getAttribute('position').count;
  const array = new Float32Array(count);
  array.fill(value);
  geometry.setAttribute(name, new BufferAttribute(array, 1));
}

/** Collects instance transforms for a prop type, ready to become an InstancedMesh. */
export class InstanceCollector {
  readonly matrices: Matrix4[] = [];
  readonly colors: Color[] = [];

  push(matrix: Matrix4, color: Color): void {
    this.matrices.push(matrix.clone());
    this.colors.push(color.clone());
  }

  get count(): number {
    return this.matrices.length;
  }
}
