import {
  BufferGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Vector3,
} from 'three';
import { MeshBuilder } from '../builders/MeshBuilder';
import { railWheel, revolved, unitBox, unitCylinder } from '../builders/Prefabs';
import {
  createGlassMaterial,
  getStainlessMaterial,
  getUnderframeMaterial,
} from '../materials/Materials';
import { textures } from '../materials/TextureFactory';

/**
 * Rolling stock, modelled on a modern JR commuter EMU.
 *
 * The prototype is a 20 m, 2,950 mm wide laser-welded stainless car with four
 * sliding doors a side, a single roof-mounted air conditioner, a single-arm
 * pantograph on alternate cars and a moulded cab front carrying the lamps in
 * clusters at its lower corners. Everything here is dimensioned from that:
 * platform height and door threshold agree with `StationBuilder`, the
 * pantograph reaches exactly the contact wire height `TrackBuilder` strings,
 * and the wheels stand on the rail head at y = 0.
 *
 * The shell is swept in two strips - below the windows and above them - which
 * leaves the window band genuinely open. Glazing, door leaves and pillars fill
 * it, so you see into the saloon rather than at a dark panel stuck on the side,
 * and the interior lighting reads through the glass after dark.
 */

export interface CarOptions {
  isCab: boolean;
  /** Cab at the rear of the consist faces the other way. */
  reversed?: boolean;
  bodyColor: number;
  accentColor: number;
  hasPantograph: boolean;
  destination?: string;
  length: number;
}

export interface CarModel {
  group: Group;
  headlights: Mesh[];
  taillights: Mesh[];
  interiorLights: Mesh[];
  pantograph?: Object3D;
}

// --- prototype dimensions, metres above rail head unless stated -------------

/** Half the body width: a 2,950 mm wide car. */
const HALF_WIDTH = 1.475;
/** Saloon floor, level with a 1,100 mm platform plus the step up. */
const FLOOR = 1.15;
/** Underside of the solebar, which is what the equipment hangs from. */
const UNDERFRAME = 0.95;
/** Bottom of the side windows. */
const SILL = 2.03;
/** Top of the side windows. */
const HEAD = 2.93;
/** Top of the roof shell, before the air conditioner. */
const ROOF = 3.64;
/** Clear width of a door opening. */
const DOOR_WIDTH = 1.32;
/** Top of a door opening. */
const DOOR_TOP = 3.00;
/** Wheel diameter; the axle centre therefore sits at half this. */
const WHEEL_DIAMETER = 0.86;
/** Lateral offset of each wheel tread from the centre line, 1,067 mm gauge. */
const WHEEL_OFFSET = 0.545;
/** Bogie wheelbase. */
const WHEELBASE = 2.1;

type Band = 'under' | 'body' | 'accent' | 'thin' | 'roof';
type Section = { x: number; y: number; band: Band };

/**
 * Half of the shell below the windows, from the centre of the underframe out
 * and up to the sill. The tumblehome - the way the side rolls in below the
 * waist - is what stops a train looking like an extruded box.
 */
const LOWER_HALF: Section[] = [
  { x: 0.00, y: UNDERFRAME, band: 'under' },
  { x: 1.10, y: UNDERFRAME, band: 'under' },
  { x: 1.30, y: 1.01, band: 'under' },
  { x: 1.38, y: 1.11, band: 'under' }, // solebar
  { x: 1.405, y: 1.24, band: 'body' },
  { x: 1.448, y: 1.42, band: 'body' }, // tumblehome
  { x: 1.470, y: 1.56, band: 'body' },
  { x: 1.474, y: 1.655, band: 'body' },
  { x: 1.475, y: 1.67, band: 'accent' }, // wide livery band
  { x: 1.475, y: 1.96, band: 'accent' },
  { x: 1.475, y: 1.975, band: 'body' },
  { x: 1.475, y: SILL, band: 'body' },
];

/** Half of the shell above the windows, from the cantrail to the roof centre. */
const UPPER_HALF: Section[] = [
  { x: 1.475, y: HEAD, band: 'body' },
  { x: 1.475, y: 2.985, band: 'body' },
  { x: 1.474, y: 3.00, band: 'thin' }, // thin livery band above the glass
  { x: 1.470, y: 3.08, band: 'thin' },
  { x: 1.466, y: 3.095, band: 'body' },
  { x: 1.452, y: 3.20, band: 'body' },
  { x: 1.40, y: 3.32, band: 'roof' },
  { x: 1.30, y: 3.43, band: 'roof' },
  { x: 1.08, y: 3.54, band: 'roof' },
  { x: 0.66, y: 3.61, band: 'roof' },
  { x: 0.00, y: ROOF, band: 'roof' },
];

/** Mirrors a half section to the other side, reversed so the loop stays open. */
function mirrored(half: Section[]): Section[] {
  return half
    .slice()
    .reverse()
    .map((p) => ({ x: -p.x, y: p.y, band: p.band }));
}

/**
 * Both shell strips, traced anticlockwise in the section plane so that the
 * swept surface faces outwards: the lower one from the left sill down round
 * the underframe and up to the right sill, the upper one from the right
 * cantrail over the roof to the left one.
 */
const LOWER_SECTION: Section[] = [...mirrored(LOWER_HALF), ...LOWER_HALF.slice(1)];
const UPPER_SECTION: Section[] = [...UPPER_HALF, ...mirrored(UPPER_HALF).slice(1)];

/** Cumulative arc length along a section, in metres, for the bodyside UVs. */
function arcLengths(section: Section[]): number[] {
  const u: number[] = [0];
  for (let i = 1; i < section.length; i++) {
    u.push(u[i - 1] + Math.hypot(section[i].x - section[i - 1].x, section[i].y - section[i - 1].y));
  }
  return u;
}

function bandColor(
  band: Band,
  body: Color,
  accent: Color,
  roof: Color,
  under: Color,
): Color {
  switch (band) {
    case 'accent':
    case 'thin':
      return accent;
    case 'roof':
      return roof;
    case 'under':
      return under;
    default:
      return body;
  }
}

/** Door centres along a 20 m car: four a side, at the prototype pitch. */
function doorPositions(halfL: number): number[] {
  const outer = halfL - 2.62;
  const inner = outer - 4.66;
  return [-outer, -inner, inner, outer];
}

/**
 * How much the section narrows at a cab end.
 *
 * A Japanese commuter cab is close to full width with the corners drawn in
 * over the last couple of metres, not a wedge: the taper is small and dies out
 * quickly, and it is only applied to the width, so the floor and roof lines run
 * straight through to the front.
 */
function noseTaper(z: number, front: number, isCab: boolean): number {
  if (!isCab) return 1;
  const t = Math.max(0, (front + 2.3 - z) / 2.3);
  return 1 - t * t * 0.085;
}

export function createCar(options: CarOptions): CarModel {
  const group = new Group();
  const shell = new MeshBuilder();
  const under = new MeshBuilder();
  const glass = new MeshBuilder();
  const interior = new MeshBuilder();

  const L = options.length;
  const halfL = L / 2 - 0.25;
  const front = -halfL;
  const rear = halfL;
  const doors = doorPositions(halfL);

  const bodyColor = new Color(options.bodyColor);
  const accentColor = new Color(options.accentColor);
  // Roofs on Japanese stock are unpainted grey; keeping them off white also
  // stops them blowing out under a high sun.
  const roofColor = new Color(0x8d9298);
  const underColor = new Color(0x3a3d41);
  const blackout = new Color(0.055, 0.06, 0.068);
  const rubber = new Color(0.09, 0.095, 0.1);

  const matrix = new Matrix4();

  // --- shell ---------------------------------------------------------------
  const stations: number[] = [];
  for (let z = front; z < rear - 0.001; z += 0.45) stations.push(z);
  stations.push(rear);

  const sweepStrip = (section: Section[]): void => {
    const u = arcLengths(section);
    const rows: Vector3[][] = [];
    const uvV: number[] = [];
    for (const z of stations) {
      const taper = noseTaper(z, front, options.isCab);
      rows.push(section.map((p) => new Vector3(p.x * taper, p.y, z)));
      uvV.push(z * 0.5);
    }
    const colors = section.map((p) =>
      bandColor(p.band, bodyColor, accentColor, roofColor, underColor),
    );
    shell.addSweep(rows, colors, uvV, u, false);
  };
  sweepStrip(LOWER_SECTION);
  sweepStrip(UPPER_SECTION);

  // Cantrail and sill edges, closing the window band top and bottom so the
  // shell has thickness where it is cut away rather than showing as paper.
  for (const side of [-1, 1]) {
    const x = side * HALF_WIDTH;
    for (const [y, flip] of [[SILL, false], [HEAD, true]] as [number, boolean][]) {
      shell.addQuad(
        new Vector3(x, y, front),
        new Vector3(x, y, rear),
        new Vector3(x * 0.965, y, rear),
        new Vector3(x * 0.965, y, front),
        bodyColor,
        [0, 0, 1, 1],
        side > 0 ? flip : !flip,
      );
    }
  }

  // --- window band ---------------------------------------------------------
  // Between the doors the band is glazed in bays with slim pillars; at a door
  // it is the upper half of the leaves. Both stand a few millimetres proud of
  // the shell, as the real glass and door skin do.
  const bandH = HEAD - SILL;
  const paneInset = 0.055;

  for (const side of [-1, 1]) {
    const x = side * HALF_WIDTH;

    // Saloon bays: the gaps between consecutive doors, plus the two ends.
    const bounds: [number, number][] = [];
    const endClear = options.isCab ? 3.4 : 0.72;
    bounds.push([front + endClear, doors[0] - DOOR_WIDTH / 2 - 0.16]);
    for (let i = 0; i < doors.length - 1; i++) {
      bounds.push([doors[i] + DOOR_WIDTH / 2 + 0.16, doors[i + 1] - DOOR_WIDTH / 2 - 0.16]);
    }
    bounds.push([doors[doors.length - 1] + DOOR_WIDTH / 2 + 0.16, rear - 0.72]);

    for (const [z0, z1] of bounds) {
      if (z1 - z0 < 0.5) continue;
      const panes = Math.max(1, Math.round((z1 - z0) / 1.55));
      const pitch = (z1 - z0) / panes;
      for (let k = 0; k < panes; k++) {
        const zc = z0 + pitch * (k + 0.5);
        const paneLen = pitch - 0.12;
        // Black rubber surround, then the glass set a little inside it.
        matrix.makeScale(0.05, bandH, paneLen);
        matrix.setPosition(x - side * 0.025, SILL, zc);
        interior.add(unitBox(), matrix, rubber);
        matrix.makeScale(0.03, bandH - paneInset * 2, paneLen - paneInset * 2);
        matrix.setPosition(x - side * 0.008, SILL + paneInset, zc);
        glass.add(unitBox(), matrix, new Color(0.07, 0.1, 0.13));
      }
      // Pillars between the bays.
      for (let k = 1; k < panes; k++) {
        matrix.makeScale(0.07, bandH, 0.12);
        matrix.setPosition(x - side * 0.01, SILL, z0 + pitch * k);
        shell.add(unitBox(), matrix, bodyColor);
      }
    }

    // Doors. The lower half of a leaf is a solid skin standing just proud of
    // the shell; in the window band it is a slim frame around the glass, so a
    // closed door still lets the saloon show through as the real one does.
    for (const dz of doors) {
      const leafW = DOOR_WIDTH / 2;
      const frame = 0.11;
      for (const leaf of [-1, 1]) {
        const zc = dz + leaf * leafW * 0.5;
        matrix.makeScale(0.05, SILL - FLOOR + 0.02, leafW - 0.02);
        matrix.setPosition(x - side * 0.012, FLOOR, zc);
        shell.add(unitBox(), matrix, bodyColor);
        // Frame around the door glass: stiles either side and a rail on top.
        for (const stile of [-1, 1]) {
          matrix.makeScale(0.05, HEAD - SILL + 0.06, frame);
          matrix.setPosition(
            x - side * 0.012,
            SILL - 0.02,
            zc + stile * ((leafW - 0.02 - frame) / 2),
          );
          shell.add(unitBox(), matrix, bodyColor);
        }
        matrix.makeScale(0.05, frame, leafW - 0.02);
        matrix.setPosition(x - side * 0.012, HEAD - frame + 0.04, zc);
        shell.add(unitBox(), matrix, bodyColor);
        // Door glass, set in a rubber gasket.
        matrix.makeScale(0.045, HEAD - SILL - 0.1, leafW - 0.04 - frame * 2);
        matrix.setPosition(x - side * 0.006, SILL + 0.02, zc);
        interior.add(unitBox(), matrix, rubber);
        matrix.makeScale(0.03, HEAD - SILL - 0.16, leafW - 0.1 - frame * 2);
        matrix.setPosition(x - side * 0.002, SILL + 0.05, zc);
        glass.add(unitBox(), matrix, new Color(0.07, 0.1, 0.13));
      }
      // Door frame: the pocket line each side and the header above.
      for (const edge of [-1, 1]) {
        matrix.makeScale(0.055, DOOR_TOP - FLOOR + 0.08, 0.07);
        matrix.setPosition(x - side * 0.03, FLOOR - 0.04, dz + edge * (leafW + 0.035));
        interior.add(unitBox(), matrix, rubber);
      }
      matrix.makeScale(0.055, 0.07, DOOR_WIDTH + 0.14);
      matrix.setPosition(x - side * 0.03, DOOR_TOP, dz);
      interior.add(unitBox(), matrix, rubber);
      // Centre seal where the leaves meet.
      matrix.makeScale(0.06, DOOR_TOP - FLOOR, 0.05);
      matrix.setPosition(x - side * 0.005, FLOOR, dz);
      interior.add(unitBox(), matrix, rubber);
      // Threshold plate, and the yellow warning line on the door pocket that
      // every Japanese commuter door carries.
      matrix.makeScale(0.09, 0.05, DOOR_WIDTH + 0.1);
      matrix.setPosition(x - side * 0.03, FLOOR - 0.05, dz);
      under.add(unitBox(), matrix, new Color(0.42, 0.43, 0.45));
      matrix.makeScale(0.055, 0.5, 0.09);
      matrix.setPosition(x - side * 0.026, SILL - 0.62, dz + (leafW + 0.11));
      interior.add(unitBox(), matrix, new Color(0.86, 0.66, 0.1));
    }
  }

  // --- saloon interior -----------------------------------------------------
  // Only ever seen through the glazing, so it is four surfaces and a row of
  // seats - but without it the windows read as holes in a shell.
  const interiorColor = new Color(0.72, 0.71, 0.68);
  matrix.makeScale(2.7, 0.06, L - 2.2);
  matrix.setPosition(0, FLOOR, 0);
  interior.add(unitBox(), matrix, new Color(0.36, 0.35, 0.34));
  matrix.makeScale(2.62, 0.08, L - 2.2);
  matrix.setPosition(0, 3.32, 0);
  interior.add(unitBox(), matrix, interiorColor);
  for (const side of [-1, 1]) {
    // Side lining below the windows, and the seat moquette in front of it.
    matrix.makeScale(0.1, SILL - FLOOR, L - 2.4);
    matrix.setPosition(side * 1.34, FLOOR, 0);
    interior.add(unitBox(), matrix, interiorColor);
    for (const [z0, z1] of [
      [doors[0] + 1.0, doors[1] - 1.0],
      [doors[1] + 1.0, doors[2] - 1.0],
      [doors[2] + 1.0, doors[3] - 1.0],
    ] as [number, number][]) {
      if (z1 - z0 < 0.6) continue;
      matrix.makeScale(0.46, 0.42, z1 - z0);
      matrix.setPosition(side * 1.08, FLOOR + 0.04, (z0 + z1) / 2);
      interior.add(unitBox(), matrix, new Color(0.1, 0.14, 0.22));
      matrix.makeScale(0.1, 0.5, z1 - z0);
      matrix.setPosition(side * 1.26, FLOOR + 0.46, (z0 + z1) / 2);
      interior.add(unitBox(), matrix, new Color(0.11, 0.16, 0.25));
    }
    // Grab pole at each doorway.
    for (const dz of doors) {
      matrix.makeScale(0.06, 2.1, 0.06);
      matrix.setPosition(side * 0.98, FLOOR + 0.06, dz);
      interior.add(unitBox(), matrix, new Color(0.75, 0.76, 0.78));
    }
  }

  // --- underframe ----------------------------------------------------------
  const equipDark = new Color(0.26, 0.27, 0.28);
  const equipGrey = new Color(0.4, 0.41, 0.42);
  // Solebar and headstocks.
  for (const side of [-1, 1]) {
    matrix.makeScale(0.12, 0.34, L - 0.9);
    matrix.setPosition(side * 1.32, UNDERFRAME - 0.06, 0);
    under.add(unitBox(), matrix, equipDark);
  }
  matrix.makeScale(2.7, 0.3, 0.24);
  matrix.setPosition(0, UNDERFRAME - 0.04, front + 0.1);
  under.add(unitBox(), matrix, equipDark);
  matrix.makeScale(2.7, 0.3, 0.24);
  matrix.setPosition(0, UNDERFRAME - 0.04, rear - 0.1);
  under.add(unitBox(), matrix, equipDark);

  // Equipment slung between the bogies. A modern EMU carries the traction
  // converter and its cooling on one side and the auxiliary supply, the
  // compressor and the reservoirs on the other, and the difference between the
  // two sides is very visible from a low camera.
  const boxes: [number, number, number, number, number][] = [
    // x centre, z centre, width, length, depth below the solebar
    [-0.72, -3.4, 1.15, 3.1, 0.56], // traction converter
    [-0.72, 0.6, 1.0, 1.9, 0.44], // filter reactor
    [0.78, -2.2, 1.0, 2.2, 0.5], // auxiliary supply
    [0.78, 1.6, 0.9, 1.5, 0.42], // battery box
    [0.0, 3.6, 1.2, 1.4, 0.36], // control cubicle
  ];
  for (const [bx, bz, bw, bl, bh] of boxes) {
    if (Math.abs(bz) > halfL - 3.6) continue;
    matrix.makeScale(bw, bh, bl);
    matrix.setPosition(bx, UNDERFRAME - bh - 0.04, bz);
    under.add(unitBox(), matrix, equipDark);
    // Louvred cooling face on the outboard side.
    matrix.makeScale(0.05, bh * 0.7, bl * 0.8);
    matrix.setPosition(bx + Math.sign(bx || 1) * (bw / 2), UNDERFRAME - bh * 0.9, bz);
    under.add(unitBox(), matrix, equipGrey);
  }
  // Air reservoirs: long cylinders hung alongside the frames.
  for (const [rx, rz] of [[1.0, -1.0], [1.0, 4.6]] as [number, number][]) {
    if (Math.abs(rz) > halfL - 3.4) continue;
    const res = new Matrix4().makeScale(0.3, 1.7, 0.3);
    res.premultiply(new Matrix4().makeRotationX(Math.PI / 2));
    res.premultiply(new Matrix4().makeTranslation(rx, UNDERFRAME - 0.28, rz));
    under.add(unitCylinder(10), res, equipGrey);
  }

  // --- roof ----------------------------------------------------------------
  // A single air conditioner per car, low and wide, with its condenser grilles
  // at each end; then the cable duct, the vents and the aerials.
  const acLength = 2.2;
  matrix.makeScale(1.86, 0.3, acLength);
  matrix.setPosition(0, ROOF - 0.04, 0);
  shell.add(unitBox(), matrix, new Color(0.72, 0.73, 0.74));
  matrix.makeScale(1.62, 0.09, acLength - 0.34);
  matrix.setPosition(0, ROOF + 0.26, 0);
  shell.add(unitBox(), matrix, new Color(0.66, 0.67, 0.68));
  for (const gz of [-1, 1]) {
    matrix.makeScale(1.5, 0.2, 0.07);
    matrix.setPosition(0, ROOF + 0.02, gz * (acLength / 2 - 0.02));
    under.add(unitBox(), matrix, new Color(0.28, 0.29, 0.3));
  }
  // Cable duct along the centre of the roof.
  matrix.makeScale(0.5, 0.07, L - 3.0);
  matrix.setPosition(0, ROOF - 0.03, 0);
  shell.add(unitBox(), matrix, roofColor);
  // Ventilators either side of the duct.
  for (let vz = -halfL + 3.2; vz < halfL - 3.0; vz += 3.1) {
    if (Math.abs(vz) < acLength / 2 + 0.4) continue;
    for (const vx of [-0.62, 0.62]) {
      matrix.makeScale(0.42, 0.1, 0.42);
      matrix.setPosition(vx, ROOF - 0.05, vz);
      shell.add(unitBox(), matrix, new Color(0.66, 0.67, 0.68));
    }
  }
  // Aerials over the cab end.
  if (options.isCab) {
    matrix.makeScale(0.24, 0.11, 0.7);
    matrix.setPosition(0, ROOF - 0.05, front + 2.2);
    under.add(unitBox(), matrix, equipGrey);
    matrix.makeScale(0.035, 0.62, 0.035);
    matrix.setPosition(0, ROOF + 0.04, front + 2.2);
    under.add(unitBox(), matrix, equipDark);
  }

  // --- car ends and gangways ----------------------------------------------
  // The end of a car is a corrugated bulkhead with a bellows gangway on it;
  // between two cars the two bellows meet, which is what closes the gap in a
  // rake instead of leaving daylight through it.
  const endCap = (z: number, outward: number): void => {
    // The two shell strips together make a closed section once the window band
    // is counted as part of it, so the bulkhead is a fan over that whole ring -
    // including the band, because the end of a car is solid.
    const centre = new Vector3(0, 2.2, z);
    const ring = [...LOWER_SECTION, ...UPPER_SECTION];
    const capColor = new Color(0.24, 0.25, 0.26);
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const a = new Vector3(ring[i].x, ring[i].y, z);
      const b = new Vector3(ring[j].x, ring[j].y, z);
      if (outward < 0) under.addTriangle(centre, b, a, capColor, false);
      else under.addTriangle(centre, a, b, capColor, false);
    }
  };

  const gangway = (z: number, outward: number): void => {
    // Bellows: a stack of rings stepping outwards, which is how a corrugated
    // gangway reads at any distance.
    for (let i = 0; i < 4; i++) {
      const reach = 0.09 + i * 0.09;
      const w = 1.5 - i * 0.02;
      matrix.makeScale(w, 1.65, 0.075);
      matrix.setPosition(0, 1.32, z + outward * reach);
      under.add(unitBox(), matrix, new Color(0.11, 0.115, 0.12));
    }
    // Jumper cables and the air connections below it.
    for (const jx of [-0.62, 0.62]) {
      matrix.makeScale(0.14, 0.36, 0.14);
      matrix.setPosition(jx, UNDERFRAME + 0.1, z + outward * 0.1);
      under.add(unitBox(), matrix, equipGrey);
    }
  };

  // Both ends get a bulkhead; only a non-driving end gets a gangway on it.
  endCap(rear, 1);
  gangway(rear, 1);
  endCap(front, -1);
  if (!options.isCab) gangway(front, -1);

  // --- bogies --------------------------------------------------------------
  const bogieZ = [-(L / 2 - 3.0), L / 2 - 3.0];
  const bogieGeometry = getBogieGeometry();
  for (const bz of bogieZ) {
    const bogie = new Mesh(bogieGeometry, getUnderframeMaterial());
    bogie.position.set(0, 0, bz);
    bogie.castShadow = true;
    bogie.matrixAutoUpdate = false;
    bogie.updateMatrix();
    group.add(bogie);
  }

  // --- pantograph ----------------------------------------------------------
  let pantograph: Object3D | undefined;
  if (options.hasPantograph) {
    pantograph = new Group();
    const pan = new Mesh(getPantographGeometry(), getUnderframeMaterial());
    pan.castShadow = true;
    pan.matrixAutoUpdate = false;
    pantograph.add(pan);
    pantograph.position.set(0, ROOF - 0.06, halfL * 0.58);
    group.add(pantograph);
    // Roof-mounted insulators and the high tension cable running forward from
    // the pantograph, which is the giveaway that this is the powered car.
    for (const iz of [halfL * 0.58 - 1.6, halfL * 0.58 + 1.6]) {
      const ins = new Matrix4().makeScale(0.16, 0.3, 0.16);
      ins.setPosition(0.55, ROOF - 0.04, iz);
      under.add(unitCylinder(8), ins, new Color(0.72, 0.66, 0.5));
    }
    matrix.makeScale(0.06, 0.06, 3.2);
    matrix.setPosition(0.55, ROOF + 0.24, halfL * 0.58);
    under.add(unitBox(), matrix, new Color(0.12, 0.12, 0.13));
  }

  // --- cab front -----------------------------------------------------------
  const headlights: Mesh[] = [];
  const taillights: Mesh[] = [];
  if (options.isCab) {
    buildCabFront({
      shell,
      under,
      glass,
      interior,
      group,
      front,
      bodyColor,
      accentColor,
      blackout,
      headlights,
      taillights,
      destination: options.destination,
    });
  }

  // --- assemble ------------------------------------------------------------
  const shellMesh = shell.toMesh(getStainlessMaterial(), true, 'car-body');
  if (shellMesh) {
    shellMesh.castShadow = true;
    shellMesh.receiveShadow = true;
    group.add(shellMesh);
  }
  const underMesh = under.toMesh(getUnderframeMaterial(), false, 'car-underframe');
  if (underMesh) {
    underMesh.castShadow = true;
    underMesh.receiveShadow = true;
    group.add(underMesh);
  }
  const interiorMesh = interior.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.06 }),
    false,
    'car-interior',
  );
  if (interiorMesh) {
    interiorMesh.userData.ownsMaterial = true;
    group.add(interiorMesh);
  }
  const glassMaterial = createGlassMaterial(0x0b1116, 0.74);
  glassMaterial.vertexColors = true;
  const glassMesh = glass.toMesh(glassMaterial, false, 'car-glass');
  if (glassMesh) {
    glassMesh.userData.ownsMaterial = true;
    group.add(glassMesh);
  }

  // Saloon lighting, seen through the glazing after dark.
  const interiorLights: Mesh[] = [];
  const interiorMaterial = new MeshBasicMaterial({ color: 0x000000 });
  for (const lx of [-0.72, 0.72]) {
    const light = new Mesh(unitBox(), interiorMaterial);
    light.scale.set(0.34, 0.06, L - 3.4);
    light.position.set(lx, 3.24, 0);
    group.add(light);
    interiorLights.push(light);
  }

  if (options.reversed) {
    // Turn the car end for end without touching `group`'s own transform, which
    // the consist overwrites every frame when it places the car on the track.
    const inner = new Group();
    while (group.children.length > 0) inner.add(group.children[0]);
    inner.rotation.y = Math.PI;
    group.add(inner);
  }

  return { group, headlights, taillights, interiorLights, pantograph };
}

// --- cab front --------------------------------------------------------------

interface CabFrontArgs {
  shell: MeshBuilder;
  under: MeshBuilder;
  glass: MeshBuilder;
  interior: MeshBuilder;
  group: Group;
  front: number;
  bodyColor: Color;
  accentColor: Color;
  blackout: Color;
  headlights: Mesh[];
  taillights: Mesh[];
  destination?: string;
}

/**
 * The front of a driving car.
 *
 * A modern JR cab front is a moulded FRP mask: a black-glazed upper half with
 * a deeply raked two-piece windscreen, an emergency gangway door set off the
 * centre line, the destination indicator beside it, lamp clusters low in each
 * corner carrying two headlights and a tail light apiece, and a full-width
 * skirt over the coupler. All of that is what the player looks at from every
 * camera except the cab itself, so it is built rather than suggested.
 */
function buildCabFront(a: CabFrontArgs): void {
  const { shell, under, glass, interior, group, front, bodyColor, blackout } = a;
  const matrix = new Matrix4();
  const darkGrey = new Color(0.17, 0.18, 0.19);
  /** Distance forward of the body end, which is towards -z. */
  const out = (d: number): number => front - d;

  // The windscreen aperture. Everything the mask is built from is placed
  // around it: the driver has to be able to see out, so the front cannot be a
  // slab with glass painted on it.
  const apertureLow = 1.90;
  const apertureHigh = 2.96;
  const headerHigh = 3.3;

  // The mask, in panels that leave the aperture open, and with the corners
  // stepped back so the moulding catches the light instead of reading as one
  // flat face.
  const maskPanel = (x0: number, x1: number, y0: number, y1: number, depth: number): void => {
    matrix.makeScale(x1 - x0, y1 - y0, depth);
    matrix.setPosition((x0 + x1) / 2, y0, out(depth / 2));
    shell.add(unitBox(), matrix, bodyColor);
  };
  maskPanel(-1.06, 1.06, 0.62, apertureLow, 0.34);
  maskPanel(-1.34, -1.06, 0.62, headerHigh, 0.24);
  maskPanel(1.06, 1.34, 0.62, headerHigh, 0.24);
  maskPanel(-1.06, -0.98, apertureLow, apertureHigh, 0.34);
  maskPanel(0.98, 1.06, apertureLow, apertureHigh, 0.34);
  maskPanel(-1.06, 1.06, apertureHigh, headerHigh, 0.34);
  // Roof fairing over the top of the mask, carrying the horn covers.
  matrix.makeScale(2.5, 0.3, 0.42);
  matrix.setPosition(0, headerHigh - 0.02, out(0.17));
  shell.add(unitBox(), matrix, new Color(0.72, 0.73, 0.74));

  // Black glazing surround: a frame round the aperture rather than a panel
  // across it, plus the pillar that splits the screen.
  const surround = (x0: number, x1: number, y0: number, y1: number): void => {
    matrix.makeScale(x1 - x0, y1 - y0, 0.07);
    matrix.setPosition((x0 + x1) / 2, y0, out(0.37));
    interior.add(unitBox(), matrix, blackout);
  };
  surround(-1.22, 1.22, apertureLow - 0.14, apertureLow + 0.04);
  surround(-1.22, 1.22, apertureHigh - 0.04, headerHigh);
  surround(-1.22, -1.1, apertureLow, apertureHigh);
  surround(1.1, 1.22, apertureLow, apertureHigh);
  surround(0.1, 0.3, apertureLow, apertureHigh);

  // Windscreen: two panes filling the aperture, raked back at the top.
  for (const [x0, x1] of [[-1.14, 0.14], [0.26, 1.14]] as [number, number][]) {
    const pane = new Matrix4().makeScale(x1 - x0, apertureHigh - apertureLow, 0.04);
    pane.premultiply(new Matrix4().makeRotationX(-0.1));
    pane.premultiply(
      new Matrix4().makeTranslation((x0 + x1) / 2, (apertureLow + apertureHigh) / 2, out(0.38)),
    );
    glass.add(unitBox(), pane, new Color(0.44, 0.53, 0.62));
  }

  // Emergency gangway door. It is offset to the driver's right, as the
  // prototype's is, and its solid part stops at the bottom of the windscreen:
  // above that the door is glazed and reads as part of the screen. Standing it
  // up through the aperture would put a panel across the driver's eyeline,
  // which is the one thing a cab front must never do.
  matrix.makeScale(0.78, apertureLow - 0.66, 0.08);
  matrix.setPosition(0.26, 0.66, out(0.38));
  shell.add(unitBox(), matrix, bodyColor);
  for (const hx of [-0.06, 0.58]) {
    matrix.makeScale(0.05, 0.9, 0.05);
    matrix.setPosition(hx, 0.85, out(0.43));
    under.add(unitBox(), matrix, new Color(0.66, 0.67, 0.68));
  }

  // Destination indicator, let into the black header above the windscreen.
  if (a.destination) {
    const blind = new Mesh(
      new PlaneGeometry(1.16, 0.26),
      new MeshBasicMaterial({ map: textures.destinationBlind(a.destination) }),
    );
    blind.position.set(0.5, 3.11, out(0.42));
    blind.rotation.y = Math.PI;
    blind.userData.ownsGeometry = true;
    blind.userData.ownsMaterial = true;
    group.add(blind);
  }

  // Lamp clusters low in each corner: two headlights beside a tail light in a
  // black housing, the arrangement on every recent JR commuter cab.
  const headMaterial = new MeshBasicMaterial({ color: 0xfff4dd });
  const tailMaterial = new MeshBasicMaterial({ color: 0x330404 });
  const lensGeometry = revolved(
    [
      [0.0, 0.0],
      [0.44, 0.0],
      [0.5, 0.16],
      [0.46, 0.34],
      [0.0, 0.4],
    ],
    12,
  );
  // Turned to face forward, i.e. down -z.
  lensGeometry.rotateX(-Math.PI / 2);
  for (const side of [-1, 1]) {
    const cx = side * 0.96;
    matrix.makeScale(0.76, 0.46, 0.1);
    matrix.setPosition(cx, 1.12, out(0.38));
    interior.add(unitBox(), matrix, blackout);

    for (const lx of [-0.2, 0.06]) {
      const lamp = new Mesh(lensGeometry, headMaterial);
      lamp.scale.set(0.21, 0.21, 0.1);
      lamp.position.set(cx + lx, 1.34, out(0.4));
      lamp.userData.role = 'headlight';
      lamp.userData.ownsGeometry = true;
      group.add(lamp);
      a.headlights.push(lamp);
    }
    const tail = new Mesh(lensGeometry, tailMaterial.clone());
    tail.scale.set(0.17, 0.17, 0.09);
    tail.position.set(cx + 0.27, 1.34, out(0.4));
    tail.userData.ownsMaterial = true;
    tail.userData.ownsGeometry = true;
    group.add(tail);
    a.taillights.push(tail);

    // Handrail up the corner of the mask.
    const rail = new Matrix4().makeScale(0.05, 1.55, 0.05);
    rail.setPosition(side * 1.3, 1.2, out(0.3));
    under.add(unitCylinder(6), rail, new Color(0.66, 0.67, 0.68));
  }

  // Skirt over the coupler, with the obstacle deflector below it.
  matrix.makeScale(2.44, 0.62, 0.44);
  matrix.setPosition(0, 0.36, out(0.26));
  under.add(unitBox(), matrix, darkGrey);
  matrix.makeScale(2.2, 0.1, 0.3);
  matrix.setPosition(0, 0.3, out(0.34));
  under.add(unitBox(), matrix, new Color(0.11, 0.12, 0.13));
  matrix.makeScale(1.7, 0.16, 0.14);
  matrix.setPosition(0, 0.14, out(0.36));
  under.add(unitBox(), matrix, new Color(0.1, 0.11, 0.12));
  // Coupler head, showing through the gap in the skirt.
  matrix.makeScale(0.36, 0.3, 0.8);
  matrix.setPosition(0, 0.5, out(0.55));
  under.add(unitBox(), matrix, new Color(0.16, 0.17, 0.18));

  // Wipers, parked along the bottom of each pane.
  for (const wx of [-0.5, 0.74]) {
    const arm = new Matrix4().makeScale(0.03, 0.9, 0.03);
    arm.premultiply(new Matrix4().makeRotationZ(1.34));
    arm.premultiply(new Matrix4().makeTranslation(wx, 1.44, out(0.44)));
    under.add(unitBox(), arm, new Color(0.1, 0.1, 0.11));
  }
}

// --- shared sub-assemblies --------------------------------------------------

let bogieCache: BufferGeometry | null = null;
/**
 * A bolsterless bogie, as fitted to every recent Japanese EMU: cast side
 * frames, an air spring on each side carrying the body directly, coil primary
 * suspension over the axleboxes, disc brakes on the trailer wheels and a
 * traction motor hung off the transom.
 *
 * The geometry is identical on every car, so it is built once and shared; the
 * mesh that uses it must therefore not claim to own it.
 */
function getBogieGeometry(): BufferGeometry {
  if (bogieCache) return bogieCache;
  const b = new MeshBuilder();
  const matrix = new Matrix4();
  const frame = new Color(0.3, 0.31, 0.32);
  const dark = new Color(0.21, 0.22, 0.23);
  const steel = new Color(0.5, 0.51, 0.52);
  const wheelColor = new Color(0.44, 0.45, 0.46);
  const axleY = WHEEL_DIAMETER / 2;
  const half = WHEELBASE / 2;

  for (const az of [-half, half]) {
    // Wheelset.
    for (const side of [-1, 1] as const) {
      // Scaled uniformly: the section is authored in fractions of the wheel
      // diameter, so the rim comes out the right thickness on its own.
      const wheel = new Matrix4().makeScale(WHEEL_DIAMETER, WHEEL_DIAMETER, WHEEL_DIAMETER);
      wheel.setPosition(side * WHEEL_OFFSET, axleY, az);
      b.add(railWheel(side > 0 ? -1 : 1), wheel, wheelColor);
      // Axlebox and its primary spring.
      matrix.makeScale(0.26, 0.26, 0.32);
      matrix.setPosition(side * 0.72, axleY - 0.13, az);
      b.add(unitBox(), matrix, dark);
      const spring = new Matrix4().makeScale(0.22, 0.26, 0.22);
      spring.setPosition(side * 0.72, axleY + 0.1, az);
      b.add(unitCylinder(8), spring, steel);
      // Damper between the axlebox and the frame.
      const damper = new Matrix4().makeScale(0.08, 0.34, 0.08);
      damper.setPosition(side * 0.84, axleY - 0.06, az);
      b.add(unitCylinder(6), damper, steel);
    }
    // Axle.
    const axle = new Matrix4().makeScale(0.11, 1.34, 0.11);
    axle.premultiply(new Matrix4().makeRotationZ(Math.PI / 2));
    axle.premultiply(new Matrix4().makeTranslation(-0.67, axleY, az));
    b.add(unitCylinder(8), axle, steel);
    // Brake discs either side of the gearbox.
    for (const dx of [-0.3, 0.3]) {
      const disc = revolved(
        [
          [0.12, -0.5],
          [0.62, -0.5],
          [0.64, -0.2],
          [0.64, 0.2],
          [0.62, 0.5],
          [0.12, 0.5],
        ],
        14,
      );
      disc.rotateZ(Math.PI / 2);
      const m = new Matrix4().makeScale(0.06, 0.62, 0.62);
      m.setPosition(dx, axleY, az);
      b.add(disc, m, new Color(0.46, 0.44, 0.42));
      disc.dispose();
    }
    // Brake caliper over the disc.
    matrix.makeScale(0.16, 0.34, 0.2);
    matrix.setPosition(0.3, axleY + 0.24, az);
    b.add(unitBox(), matrix, dark);
  }

  // Side frames: a beam over each axle, dropped between them.
  for (const side of [-1, 1]) {
    matrix.makeScale(0.16, 0.22, WHEELBASE + 0.7);
    matrix.setPosition(side * 0.9, axleY + 0.12, 0);
    b.add(unitBox(), matrix, frame);
    matrix.makeScale(0.2, 0.3, 0.42);
    matrix.setPosition(side * 0.9, axleY - 0.06, 0);
    b.add(unitBox(), matrix, frame);
    // Air spring carrying the body.
    const bag = revolved(
      [
        [0.0, 0.0],
        [0.46, 0.02],
        [0.5, 0.3],
        [0.44, 0.62],
        [0.46, 0.9],
        [0.4, 1.0],
        [0.0, 1.0],
      ],
      12,
    );
    const m = new Matrix4().makeScale(0.56, 0.3, 0.56);
    m.setPosition(side * 0.86, axleY + 0.23, 0);
    b.add(bag, m, new Color(0.13, 0.13, 0.14));
    bag.dispose();
  }
  // Transom across the middle, and the traction motor hung behind it.
  matrix.makeScale(1.9, 0.24, 0.4);
  matrix.setPosition(0, axleY + 0.05, 0);
  b.add(unitBox(), matrix, frame);
  const motor = new Matrix4().makeScale(0.42, 0.86, 0.42);
  motor.premultiply(new Matrix4().makeRotationZ(Math.PI / 2));
  motor.premultiply(new Matrix4().makeTranslation(-0.43, axleY + 0.02, half - 0.55));
  b.add(unitCylinder(10), motor, dark);
  matrix.makeScale(0.42, 0.42, 0.34);
  matrix.setPosition(0.14, axleY - 0.16, half - 0.1);
  b.add(unitBox(), matrix, dark);
  // Centre pivot and the traction rod to the body.
  matrix.makeScale(0.44, 0.3, 0.44);
  matrix.setPosition(0, axleY + 0.2, 0);
  b.add(unitBox(), matrix, frame);
  // Sanding pipes down to the rail head, ahead of the leading wheels.
  for (const side of [-1, 1]) {
    matrix.makeScale(0.06, 0.44, 0.06);
    matrix.setPosition(side * 0.62, 0.06, -half - 0.28);
    b.add(unitBox(), matrix, steel);
  }

  bogieCache = b.toGeometry(false);
  return bogieCache;
}

let pantographCache: BufferGeometry | null = null;
/**
 * A single-arm pantograph, raised to the contact wire.
 *
 * The lower arm rises from a pivot at one end, the upper arm folds forward off
 * it, and the collector head sits level on top carrying two contact strips
 * between down-turned horns. Built at the height that meets the contact wire
 * `TrackBuilder` strings, so the shoe genuinely touches it.
 */
function getPantographGeometry(): BufferGeometry {
  if (pantographCache) return pantographCache;
  const p = new MeshBuilder();
  const metal = new Color(0.52, 0.53, 0.55);
  const dark = new Color(0.22, 0.23, 0.24);
  const matrix = new Matrix4();

  // Base frame and its insulators.
  for (const bx of [-0.78, 0.78]) {
    for (const bz of [-0.62, 0.62]) {
      const ins = revolved(
        [
          [0.0, 0.0],
          [0.34, 0.0],
          [0.5, 0.08],
          [0.34, 0.16],
          [0.5, 0.24],
          [0.34, 0.32],
          [0.5, 0.4],
          [0.34, 0.48],
          [0.3, 0.52],
          [0.0, 0.52],
        ],
        10,
      );
      const m = new Matrix4().makeScale(0.3, 0.46, 0.3);
      m.setPosition(bx, 0, bz);
      p.add(ins, m, new Color(0.66, 0.6, 0.44));
      ins.dispose();
    }
    matrix.makeScale(0.09, 0.09, 1.5);
    matrix.setPosition(bx, 0.46, 0);
    p.add(unitBox(), matrix, dark);
  }
  matrix.makeScale(1.7, 0.09, 0.12);
  matrix.setPosition(0, 0.46, 0.62);
  p.add(unitBox(), matrix, dark);

  // The arms all lie in a plane across the car, so each one is a box turned
  // about X to point from one pivot to the next.
  const arm = (
    x: number, y0: number, z0: number, y1: number, z1: number, thick: number,
  ): void => {
    const dy = y1 - y0;
    const dz = z1 - z0;
    const m = new Matrix4().makeScale(thick, Math.hypot(dy, dz), thick);
    m.premultiply(new Matrix4().makeRotationX(Math.atan2(dz, dy)));
    m.premultiply(new Matrix4().makeTranslation(x, y0, z0));
    p.add(unitBox(), m, metal);
  };
  arm(0, 0.5, 0.6, 1.05, -0.28, 0.13);
  arm(0, 1.05, -0.28, 1.5, 0.36, 0.09);
  // Pull rod, which is what makes a single-arm pantograph keep the head level.
  arm(0.16, 0.5, 0.42, 1.04, -0.18, 0.05);

  // Collector head: two strips on a frame, with horns turned down at the ends.
  matrix.makeScale(0.26, 0.09, 0.5);
  matrix.setPosition(0, 1.5, 0.36);
  p.add(unitBox(), matrix, dark);
  for (const sz of [0.22, 0.5]) {
    matrix.makeScale(1.9, 0.05, 0.11);
    matrix.setPosition(0, 1.59, sz);
    p.add(unitBox(), matrix, new Color(0.28, 0.26, 0.24));
  }
  for (const side of [-1, 1]) {
    const horn = new Matrix4().makeScale(0.07, 0.3, 0.07);
    horn.premultiply(new Matrix4().makeRotationZ(side * 0.9));
    horn.premultiply(new Matrix4().makeTranslation(side * 0.95, 1.5, 0.36));
    p.add(unitBox(), horn, metal);
  }

  pantographCache = p.toGeometry(false);
  return pantographCache;
}

/** Angle the wiper rests at when it is not sweeping: laid along the bottom. */
export const WIPER_PARK = -1.34;

/**
 * The driving cab, modelled from the driver's seat outwards: desk, handles,
 * window frames and the dark interior that frames the view of the line.
 */
export interface CabModel {
  group: Group;
  masterHandle: Object3D;
  brakeHandle: Object3D;
  wiper: Object3D;
  eyePosition: Vector3;
}

export function createCab(carLength: number): CabModel {
  const group = new Group();
  const builder = new MeshBuilder();
  const glass = new MeshBuilder();
  const matrix = new Matrix4();

  const front = -(carLength / 2 - 0.25) - 0.02;
  const floor = FLOOR;
  const panel = new Color(0.19, 0.20, 0.22);
  const desk = new Color(0.13, 0.14, 0.155);
  const trim = new Color(0.40, 0.42, 0.44);

  // Floor and the bulkhead behind the driver, with the door through to the
  // saloon in it. The cab is a shallow box; the windscreen fills almost the
  // whole forward view, as it does in a real EMU.
  matrix.makeScale(2.7, 0.08, 2.9);
  matrix.setPosition(0, floor - 0.08, front + 1.55);
  builder.add(unitBox(), matrix, panel);
  matrix.makeScale(2.7, 2.5, 0.12);
  matrix.setPosition(0, floor, front + 3.0);
  builder.add(unitBox(), matrix, panel);
  matrix.makeScale(0.78, 1.95, 0.05);
  matrix.setPosition(0.72, floor, front + 2.92);
  builder.add(unitBox(), matrix, new Color(0.26, 0.28, 0.3));

  // Ceiling, kept high enough to stay out of the driver's eyeline.
  matrix.makeScale(2.8, 0.12, 3.0);
  matrix.setPosition(0, 3.42, front + 1.55);
  builder.add(unitBox(), matrix, panel);

  // Console: a low desk that reads as a dark band across the bottom of the
  // view without eating into the windscreen.
  matrix.makeScale(2.56, 0.1, 0.78);
  matrix.setPosition(0, 1.94, front + 0.58);
  builder.add(unitBox(), new Matrix4().makeRotationX(-0.16).premultiply(matrix), desk);
  matrix.makeScale(2.56, 0.84, 0.14);
  matrix.setPosition(0, floor, front + 0.96);
  builder.add(unitBox(), matrix, desk);
  matrix.makeScale(2.56, 0.9, 0.12);
  matrix.setPosition(0, floor, front + 0.22);
  builder.add(unitBox(), matrix, panel);

  // Windscreen pillars, right out at the body sides, plus the centre pillar
  // between the two panes.
  for (const px of [-1.34, 1.34]) {
    matrix.makeScale(0.13, 1.28, 0.16);
    matrix.setPosition(px, 1.98, front + 0.14);
    builder.add(unitBox(), matrix, panel);
  }
  matrix.makeScale(0.14, 1.2, 0.14);
  matrix.setPosition(0.22, 1.98, front + 0.14);
  builder.add(unitBox(), matrix, panel);
  // Header above the glass, and a sun visor over the driver.
  matrix.makeScale(2.85, 0.42, 0.2);
  matrix.setPosition(0, 3.2, front + 0.14);
  builder.add(unitBox(), matrix, panel);
  matrix.makeScale(1.3, 0.05, 0.3);
  matrix.setPosition(-0.55, 3.1, front + 0.36);
  builder.add(unitBox(), matrix, new Color(0.26, 0.25, 0.23));

  // The windscreen itself: very slightly tinted, so reflections read on it.
  matrix.makeScale(2.55, 1.16, 0.03);
  matrix.setPosition(0, 2.04, front + 0.2);
  glass.add(unitBox(), new Matrix4().makeRotationX(0.06).premultiply(matrix), new Color(0.6, 0.68, 0.75));

  // Side walls, glazed above waist height so the cab does not feel boxed in.
  for (const sx of [-1, 1]) {
    matrix.makeScale(0.1, 0.86, 2.7);
    matrix.setPosition(sx * 1.44, floor, front + 1.7);
    builder.add(unitBox(), matrix, panel);
    matrix.makeScale(0.1, 0.5, 2.7);
    matrix.setPosition(sx * 1.44, 2.95, front + 1.7);
    builder.add(unitBox(), matrix, panel);
    // Window pillar between the door window and the rear quarter light.
    matrix.makeScale(0.11, 1.2, 0.16);
    matrix.setPosition(sx * 1.42, 2.0, front + 2.0);
    builder.add(unitBox(), matrix, panel);
  }

  // Driver's seat, just behind the eye point.
  matrix.makeScale(0.56, 0.12, 0.56);
  matrix.setPosition(-0.42, 1.62, front + 1.62);
  builder.add(unitBox(), matrix, new Color(0.11, 0.13, 0.16));
  matrix.makeScale(0.56, 0.62, 0.12);
  matrix.setPosition(-0.42, 1.74, front + 1.92);
  builder.add(unitBox(), matrix, new Color(0.11, 0.13, 0.16));
  matrix.makeScale(0.14, 0.48, 0.14);
  matrix.setPosition(-0.42, floor, front + 1.62);
  builder.add(unitBox(), matrix, trim);

  // Instrument bezels on the desk; the readouts themselves live in the HUD.
  for (const gx of [-0.2, 0.36]) {
    matrix.makeScale(0.36, 0.04, 0.36);
    matrix.setPosition(gx, 1.98, front + 0.52);
    builder.add(unitBox(), new Matrix4().makeRotationX(-0.16).premultiply(matrix), trim);
  }

  const mesh = builder.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0.18 }),
    false,
    'cab-interior',
  );
  if (mesh) {
    mesh.userData.ownsMaterial = true;
    group.add(mesh);
  }

  const glassMesh = glass.toMesh(
    new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
    }),
    false,
    'cab-glass',
  );
  if (glassMesh) {
    glassMesh.userData.ownsMaterial = true;
    group.add(glassMesh);
  }

  // Master controller: a short lever on the left of the desk.
  const masterHandle = new Group();
  const masterBuilder = new MeshBuilder();
  masterBuilder.add(
    unitBox(),
    new Matrix4().makeScale(0.07, 0.3, 0.07),
    new Color(0.24, 0.25, 0.27),
  );
  const knob = new Matrix4().makeScale(0.13, 0.08, 0.2);
  knob.setPosition(0, 0.3, 0);
  masterBuilder.add(unitBox(), knob, new Color(0.55, 0.14, 0.11));
  const masterMesh = masterBuilder.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 }),
    false,
    'master-handle',
  );
  if (masterMesh) {
    masterMesh.userData.ownsMaterial = true;
    masterHandle.add(masterMesh);
  }
  masterHandle.position.set(-0.9, 1.94, front + 0.46);
  group.add(masterHandle);

  // Brake handle on the right.
  const brakeHandle = new Group();
  const brakeBuilder = new MeshBuilder();
  brakeBuilder.add(
    unitBox(),
    new Matrix4().makeScale(0.065, 0.28, 0.065),
    new Color(0.24, 0.25, 0.27),
  );
  const brakeKnob = new Matrix4().makeScale(0.12, 0.08, 0.18);
  brakeKnob.setPosition(0, 0.28, 0);
  brakeBuilder.add(unitBox(), brakeKnob, new Color(0.16, 0.18, 0.22));
  const brakeMesh = brakeBuilder.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4 }),
    false,
    'brake-handle',
  );
  if (brakeMesh) {
    brakeMesh.userData.ownsMaterial = true;
    brakeHandle.add(brakeMesh);
  }
  brakeHandle.position.set(0.62, 1.94, front + 0.46);
  group.add(brakeHandle);

  // Windscreen wiper, parked along the bottom of the glass where it belongs -
  // stood up across the screen it reads as a girder through the view.
  const wiper = new Group();
  const wiperBuilder = new MeshBuilder();
  const blade = new Matrix4().makeScale(0.026, 1.05, 0.026);
  blade.setPosition(0, 0.5, 0);
  wiperBuilder.add(unitBox(), blade, new Color(0.09, 0.09, 0.1));
  const wiperArm = new Matrix4().makeScale(0.04, 0.34, 0.04);
  wiperArm.setPosition(0, 0.17, -0.03);
  wiperBuilder.add(unitBox(), wiperArm, new Color(0.14, 0.14, 0.15));
  const wiperMesh = wiperBuilder.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    false,
    'wiper',
  );
  if (wiperMesh) {
    wiperMesh.userData.ownsMaterial = true;
    wiper.add(wiperMesh);
  }
  wiper.position.set(-0.62, 1.74, front + 0.16);
  wiper.rotation.z = WIPER_PARK;
  group.add(wiper);

  return {
    group,
    masterHandle,
    brakeHandle,
    wiper,
    eyePosition: new Vector3(-0.45, 2.38, front + 1.05),
  };
}
