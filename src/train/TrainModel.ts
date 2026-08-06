import {
  BufferGeometry,
  Color,
  DoubleSide,
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
 * over the last metre, not a wedge. It has to stay small: the cab, its desk and
 * the saloon lining all stand a few centimetres inside the shell, and a taper
 * that ate any further into the width pulled the bodyside in behind them and
 * left the furniture hanging out through the side of the train.
 */
const CAB_TAPER_LENGTH = 1.1;
const CAB_TAPER = 0.03;
/** Scale of the section at the very front of a driving car. */
const NOSE_SCALE = 1 - CAB_TAPER;
/**
 * Widest anything inside the shell may be. The bodyside is at 1.475 and draws
 * in to 1.431 at the cab front, so everything fitted inside stops short of it.
 */
const INNER_HALF = 1.31;

function noseTaper(z: number, front: number, isCab: boolean): number {
  if (!isCab) return 1;
  const t = Math.max(0, (front + CAB_TAPER_LENGTH - z) / CAB_TAPER_LENGTH);
  return 1 - t * t * CAB_TAPER;
}

/** Half width of a section polyline at a height, both being ordered upwards. */
function sectionHalfAt(section: Section[], y: number): number {
  if (y <= section[0].y) return section[0].x;
  for (let i = 1; i < section.length; i++) {
    if (y <= section[i].y) {
      const p = section[i - 1];
      const q = section[i];
      const t = (y - p.y) / Math.max(1e-6, q.y - p.y);
      return p.x + (q.x - p.x) * t;
    }
  }
  return section[section.length - 1].x;
}

/**
 * Half width of the shell at a height, read off the same sections the body is
 * swept from.
 *
 * The cab front is built as a cap on the end of the body, so its outline has to
 * be the body's own silhouette at every height - otherwise the mask stands
 * proud of the sides at one height and inside them at another, which is exactly
 * what a front built out of boxes does.
 */
function bodyHalfAt(y: number): number {
  // Below the solebar the section closes to a point on the centre line - it is
  // the underside of the car, not a side. Read literally it gives the cab front
  // a zero width bottom edge, and every point on that row divides by it.
  if (y < 1.11) return sectionHalfAt(LOWER_HALF, 1.11);
  if (y < SILL) return sectionHalfAt(LOWER_HALF, y);
  if (y > HEAD) return sectionHalfAt(UPPER_HALF, y);
  return HALF_WIDTH;
}

export function createCar(options: CarOptions): CarModel {
  const group = new Group();
  const shell = new MeshBuilder();
  const under = new MeshBuilder();
  const glass = new MeshBuilder();
  // The windscreen is glazed separately from the saloon. Saloon glass is a dark
  // near-opaque pane, which is right seen from the lineside and hopeless seen
  // through: put the cab screen in it and the driver spends the game looking at
  // the line through a tinted filter.
  const screen = new MeshBuilder();
  // The cab front is a moulded FRP mask, not a welded stainless side: given the
  // bodyside material it wears the rolled beading of a carbody down its nose.
  const mask = new MeshBuilder();
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

    // Saloon bays: the gaps between consecutive doors, plus the two ends. A
    // driving car gets one more at the very front - the cab side window, which
    // is what lets the driver look back along the train at a platform and what
    // stops the cab reading as a sealed box from outside.
    // The third field marks the cab window: it is glazed clear rather than in
    // the dark pane the saloon gets, because it is one the player looks out of
    // rather than into.
    const bounds: [number, number, boolean][] = [];
    const endClear = options.isCab ? 3.3 : 0.72;
    if (options.isCab) bounds.push([front + 0.42, front + 2.3, true]);
    bounds.push([front + endClear, doors[0] - DOOR_WIDTH / 2 - 0.16, false]);
    for (let i = 0; i < doors.length - 1; i++) {
      bounds.push([doors[i] + DOOR_WIDTH / 2 + 0.16, doors[i + 1] - DOOR_WIDTH / 2 - 0.16, false]);
    }
    bounds.push([doors[doors.length - 1] + DOOR_WIDTH / 2 + 0.16, rear - 0.72, false]);

    // The shell is swept in two strips, so the window band is a genuine gap in
    // it: anywhere along the band that gets neither a bay nor a door has to be
    // panelled over, or the car has a slot through its side. Beside the cab
    // that slot looked straight out at the sky from the driver's seat. The
    // panel sits at the inner face of the sill edge, which is where a blanked
    // window is on the prototype - flush enough to read as bodyside, and well
    // inside the draw-in at the nose so it cannot come out through the side.
    if (options.isCab) {
      for (const [z0, z1] of [
        [front, front + 0.42],
        [front + 2.3, front + endClear],
      ] as [number, number][]) {
        if (z1 - z0 < 0.05) continue;
        matrix.makeScale(0.05, bandH, z1 - z0);
        matrix.setPosition(side * (HALF_WIDTH * 0.965 - 0.025), SILL, (z0 + z1) / 2);
        shell.add(unitBox(), matrix, bodyColor);
        // Lined on the inside, so the driver sees cab trim beside them rather
        // than the back of the bodyside.
        matrix.makeScale(0.05, bandH, z1 - z0);
        matrix.setPosition(side * (INNER_HALF - 0.03), SILL, (z0 + z1) / 2);
        interior.add(unitBox(), matrix, new Color(0.21, 0.22, 0.24));
      }
    }

    for (const [z0, z1, isCabWindow] of bounds) {
      if (z1 - z0 < 0.5) continue;
      const into = isCabWindow ? screen : glass;
      const tint = isCabWindow ? new Color(0.5, 0.58, 0.66) : new Color(0.07, 0.1, 0.13);
      // The cab side is a driver's door and a quarter light behind it, so it
      // takes a shorter pane pitch than a saloon bay.
      const panes = Math.max(1, Math.round((z1 - z0) / (isCabWindow ? 0.95 : 1.55)));
      const pitch = (z1 - z0) / panes;
      for (let k = 0; k < panes; k++) {
        const zc = z0 + pitch * (k + 0.5);
        const paneLen = pitch - 0.12;
        // Rubber gasket, as a frame around the pane and not a panel behind it.
        // Built as a block it stood between the glass and the saloon and turned
        // every window on the train into a black rectangle - and, in the cab,
        // walled the driver in on the side they look out of at a platform.
        matrix.makeScale(0.05, paneInset, paneLen);
        matrix.setPosition(x - side * 0.025, SILL, zc);
        interior.add(unitBox(), matrix, rubber);
        matrix.setPosition(x - side * 0.025, HEAD - paneInset, zc);
        interior.add(unitBox(), matrix, rubber);
        for (const end of [-1, 1]) {
          matrix.makeScale(0.05, bandH - paneInset * 2, paneInset);
          matrix.setPosition(
            x - side * 0.025,
            SILL + paneInset,
            zc + end * ((paneLen - paneInset) / 2),
          );
          interior.add(unitBox(), matrix, rubber);
        }
        matrix.makeScale(0.03, bandH - paneInset * 2, paneLen - paneInset * 2);
        matrix.setPosition(x - side * 0.02, SILL + paneInset, zc);
        into.add(unitBox(), matrix, tint);
      }
      // Pillars between the bays.
      for (let k = 1; k < panes; k++) {
        matrix.makeScale(0.07, bandH, 0.12);
        matrix.setPosition(x - side * 0.035, SILL, z0 + pitch * k);
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
        // Door glass. The stiles and the head rail are the gasket, so there is
        // nothing behind the pane: a closed door lets the saloon show through
        // as the real one does.
        matrix.makeScale(0.03, HEAD - SILL - 0.16, leafW - 0.1 - frame * 2);
        matrix.setPosition(x - side * 0.02, SILL + 0.05, zc);
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
      // Centre seal where the leaves meet, standing no further out than the
      // leaves it seals between.
      matrix.makeScale(0.06, DOOR_TOP - FLOOR, 0.05);
      matrix.setPosition(x - side * 0.018, FLOOR, dz);
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
    // Likewise the reservoirs, which are hung about their own middle.
    res.premultiply(new Matrix4().makeTranslation(rx, UNDERFRAME - 0.28, rz - 0.85));
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
    bogie.name = 'car-bogie';
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
    pan.name = 'car-pantograph';
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
      shell: mask,
      under,
      screen,
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
  const maskMesh = mask.toMesh(
    new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.42,
      metalness: 0.12,
      envMapIntensity: 1.1,
    }),
    true,
    'car-cab-front',
  );
  if (maskMesh) {
    maskMesh.userData.ownsMaterial = true;
    maskMesh.castShadow = true;
    maskMesh.receiveShadow = true;
    group.add(maskMesh);
  }
  const underMesh = under.toMesh(getUnderframeMaterial(), false, 'car-underframe');
  if (underMesh) {
    underMesh.castShadow = true;
    underMesh.receiveShadow = true;
    group.add(underMesh);
  }
  // Normals are recomputed: swept surfaces are added with a placeholder normal
  // and only get a real one here, so a trim panel left out of the recompute is
  // lit as though it were lying flat and glows against the glass.
  const interiorMesh = interior.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.06 }),
    true,
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
  // The windscreen: barely tinted, but glossy enough to catch the sky, so it
  // reads as glass from the lineside and as clear air from the driver's seat.
  const screenMaterial = createGlassMaterial(0x8ea6b8, 0.16);
  screenMaterial.vertexColors = true;
  screenMaterial.side = DoubleSide;
  const screenMesh = screen.toMesh(screenMaterial, true, 'car-windscreen');
  if (screenMesh) {
    screenMesh.userData.ownsMaterial = true;
    group.add(screenMesh);
  }

  // Saloon lighting, seen through the glazing after dark.
  const interiorLights: Mesh[] = [];
  const interiorMaterial = new MeshBasicMaterial({ color: 0x000000 });
  for (const lx of [-0.72, 0.72]) {
    const light = new Mesh(unitBox(), interiorMaterial);
    light.name = 'car-saloon-light';
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
  screen: MeshBuilder;
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

// --- the shape of the mask ---------------------------------------------------

/** Bottom of the windscreen aperture. */
const SCREEN_SILL = 2.05;
/** Top of the windscreen aperture. */
const SCREEN_HEAD = 3.07;
/** Half width of the aperture: the screen is very nearly the full body width. */
const SCREEN_HALF = 1.2;
/** The pillar between the two panes, offset to the driver's right. */
const SPLIT_LEFT = 0.1;
const SPLIT_RIGHT = 0.34;
/** Top of the black header carrying the indicators. */
const HEADER_TOP = 3.34;

/**
 * How far forward of the body end the mask stands, at each height.
 *
 * This profile is the whole shape of the face seen from the side: it grows out
 * of the underframe, is fullest at the windscreen sill, rakes steeply back over
 * the screen and dies away to nothing where it meets the roof. Read against
 * `bodyHalfAt`, which gives the outline in plan, it makes a moulding rather
 * than a slab.
 */
const REACH_PROFILE: [number, number][] = [
  [0.26, 0.34],
  [0.62, 0.44],
  [0.95, 0.50],
  [1.45, 0.545],
  [1.96, 0.56],
  [SCREEN_SILL, 0.555],
  [SCREEN_HEAD, 0.30],
  [HEADER_TOP, 0.20],
  [3.46, 0.11],
  [3.58, 0.04],
  [ROOF, 0.0],
];

function faceReach(y: number): number {
  if (y <= REACH_PROFILE[0][0]) return REACH_PROFILE[0][1];
  for (let i = 1; i < REACH_PROFILE.length; i++) {
    if (y <= REACH_PROFILE[i][0]) {
      const [y0, r0] = REACH_PROFILE[i - 1];
      const [y1, r1] = REACH_PROFILE[i];
      return r0 + (r1 - r0) * ((y - y0) / (y1 - y0));
    }
  }
  return 0;
}

/** Half width of the mask, which is the body silhouette drawn in at the nose. */
function faceHalf(y: number): number {
  return bodyHalfAt(y) * NOSE_SCALE;
}

/**
 * A point on the surface of the mask.
 *
 * The face is flat across the middle and turns back sharply at the corners -
 * the power keeps the moulding from reading as a bullet nose - and it always
 * meets the bodyside exactly, because at the silhouette the reach is zero.
 */
function facePoint(x: number, y: number, front: number, out = new Vector3()): Vector3 {
  const half = Math.max(1e-3, faceHalf(y));
  const t = Math.min(1, Math.abs(x) / half);
  return out.set(x, y, front - faceReach(y) * (1 - Math.pow(t, 3)));
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
  const { shell, under, screen, interior, group, front, bodyColor, accentColor, blackout } = a;
  const matrix = new Matrix4();
  const darkGrey = new Color(0.17, 0.18, 0.19);
  const trimGrey = new Color(0.2, 0.21, 0.23);
  const roofGrey = new Color(0.72, 0.73, 0.74);
  const glassTint = new Color(0.42, 0.5, 0.58);
  const steel = new Color(0.66, 0.67, 0.68);

  /**
   * One horizontal band of the mask, as a strip of quads following the moulded
   * surface between two heights.
   *
   * The x limits are given at the middle of the band and scaled row by row with
   * the silhouette, so a band asked for the full width ends exactly on the
   * bodyside at every height it spans rather than cutting inside it at one end
   * and hanging out past it at the other.
   *
   * `inner` also lays a trim panel just behind the band facing back into the
   * cab: the driver sits close enough to see the back of the mask, and a
   * single-sided shell is simply not there from that side.
   */
  const band = (
    y0: number,
    y1: number,
    x0: number,
    x1: number,
    color: Color,
    into: MeshBuilder = shell,
    inner = true,
    trimColor: Color = trimGrey,
  ): void => {
    const reference = faceHalf((y0 + y1) / 2);
    const cols = Math.max(3, Math.round(Math.abs(x1 - x0) / 0.16));
    const rows: Vector3[][] = [];
    const trim: Vector3[][] = [];
    for (const y of [y0, y1]) {
      const scale = faceHalf(y) / reference;
      const row: Vector3[] = [];
      const back: Vector3[] = [];
      // Columns run from the higher x to the lower one, which is the winding
      // that faces the swept surface forwards.
      for (let i = 0; i <= cols; i++) {
        const x = (Math.max(x0, x1) - (Math.abs(x1 - x0) * i) / cols) * scale;
        const p = facePoint(x, y, front);
        row.push(p);
        back.push(new Vector3(p.x, p.y, p.z + 0.05));
      }
      rows.push(row);
      trim.push(back);
    }
    const u = rows[0].map((_, i) => i * 0.16);
    into.addSweep(rows, color, [y0 * 0.5, y1 * 0.5], u, false);
    // Reversed row order flips the winding, so the trim faces back at the cab.
    if (inner) interior.addSweep([trim[1], trim[0]], trimColor, [y1 * 0.5, y0 * 0.5], u, false);
  };

  /** A point on the mask, lifted clear of the surface by `standoff` metres. */
  const on = (x: number, y: number, standoff = 0): Vector3 => {
    const p = facePoint(x, y, front);
    p.z -= standoff;
    return p;
  };

  // --- the mask ------------------------------------------------------------
  // Built as bands of the moulded surface that leave the windscreen aperture
  // open. The driver has to be able to see out, so the front cannot be a slab
  // with glass painted on it - and the aperture is nearly the full width of the
  // car, as it is on the prototype, because the one thing a cab front must
  // never do is put structure across the driver's eyeline.
  band(0.62, 0.95, -faceHalf(0.8), faceHalf(0.8), bodyColor);
  band(0.95, 1.30, -faceHalf(1.1), faceHalf(1.1), bodyColor);
  band(1.30, 1.67, -faceHalf(1.5), faceHalf(1.5), bodyColor);
  // The livery band carries on round the front rather than stopping at the
  // corner, which is what ties the face to the rest of the car.
  band(1.67, 1.96, -faceHalf(1.8), faceHalf(1.8), accentColor);
  band(1.96, SCREEN_SILL, -faceHalf(2.0), faceHalf(2.0), blackout, shell, true, blackout);

  // Screen surround: a pillar at each corner, the one that splits the panes,
  // and the black header over the top.
  const pillarHalf = faceHalf((SCREEN_SILL + SCREEN_HEAD) / 2);
  // Dark on the inside as well as out. A cab screen is surrounded by matt black
  // for the same reason a camera lens hood is: anything pale round the glass is
  // reflected in it and hangs in front of the line all day.
  band(SCREEN_SILL, SCREEN_HEAD, SCREEN_HALF, pillarHalf, blackout, shell, true, blackout);
  band(SCREEN_SILL, SCREEN_HEAD, -pillarHalf, -SCREEN_HALF, blackout, shell, true, blackout);
  band(SCREEN_SILL, SCREEN_HEAD, SPLIT_LEFT, SPLIT_RIGHT, blackout, shell, true, blackout);
  band(SCREEN_HEAD, HEADER_TOP, -faceHalf(3.2), faceHalf(3.2), blackout, shell, true, blackout);
  // Over the header the moulding turns back onto the roof.
  band(HEADER_TOP, 3.46, -faceHalf(3.4), faceHalf(3.4), roofGrey);
  band(3.46, 3.58, -faceHalf(3.52), faceHalf(3.52), roofGrey);
  band(3.58, ROOF, -faceHalf(3.61), faceHalf(3.61), roofGrey, shell, false);

  // --- windscreen ----------------------------------------------------------
  // Two panes lying on the same moulded surface as the mask, so the glass
  // follows the curve of the face instead of being a flat sheet let into it.
  const pane = (x0: number, x1: number): void => {
    const cols = Math.max(4, Math.round((x1 - x0) / 0.14));
    const low: Vector3[] = [];
    const high: Vector3[] = [];
    for (let i = 0; i <= cols; i++) {
      const x = x1 - ((x1 - x0) * i) / cols;
      low.push(on(x, SCREEN_SILL + 0.02, 0.012));
      high.push(on(x, SCREEN_HEAD - 0.02, 0.012));
    }
    screen.addSweep([low, high], glassTint, [0, 1], low.map((_, i) => i * 0.2), false);
  };
  pane(-SCREEN_HALF + 0.03, SPLIT_LEFT);
  pane(SPLIT_RIGHT, SCREEN_HALF - 0.03);

  // --- emergency gangway door ----------------------------------------------
  // Offset to the driver's right, as the prototype's is, running from the skirt
  // up to the screen. Its shut lines are what breaks up the lower half of the
  // face; above the sill the split pillar carries the same line on.
  for (const dx of [SPLIT_LEFT - 0.02, SPLIT_RIGHT + 0.02]) {
    matrix.makeScale(0.035, SCREEN_SILL - 0.7, 0.05);
    matrix.setPosition(dx, 0.7, on(dx, 1.3, -0.02).z);
    interior.add(unitBox(), matrix, blackout);
  }
  for (const hx of [SPLIT_LEFT + 0.07, SPLIT_RIGHT - 0.07]) {
    matrix.makeScale(0.03, 0.72, 0.03);
    matrix.setPosition(hx, 1.16, on(hx, 1.5, 0.035).z);
    under.add(unitBox(), matrix, steel);
  }

  // --- indicators ----------------------------------------------------------
  // Destination blind let into the black header, on the same side as the
  // gangway door, with the route number panel beside it.
  if (a.destination) {
    const blind = new Mesh(
      new PlaneGeometry(1.02, 0.23),
      new MeshBasicMaterial({ map: textures.destinationBlind(a.destination) }),
    );
    blind.position.copy(on(0.42, 3.2, 0.02));
    blind.name = 'car-destination';
    blind.rotation.y = Math.PI;
    // Laid back with the header it sits in, so it is read rather than glared at.
    blind.rotation.x = -0.24;
    blind.userData.ownsGeometry = true;
    blind.userData.ownsMaterial = true;
    group.add(blind);
  }

  // --- lamp clusters -------------------------------------------------------
  // Low in each corner: two headlights beside a tail light in a black housing,
  // the arrangement on every recent JR commuter cab.
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
    const cx = side * 0.93;
    // The housing is a band of the face itself, set back into the moulding.
    band(1.14, 1.48, cx - 0.29, cx + 0.29, blackout, interior, false);
    for (const lx of [side * -0.19, side * 0.05]) {
      const lamp = new Mesh(lensGeometry, headMaterial);
      lamp.name = 'car-headlight';
      lamp.scale.set(0.2, 0.2, 0.12);
      lamp.position.copy(on(cx + lx, 1.31, 0.02));
      lamp.userData.role = 'headlight';
      lamp.userData.ownsGeometry = true;
      group.add(lamp);
      a.headlights.push(lamp);
    }
    const tail = new Mesh(lensGeometry, tailMaterial.clone());
    tail.name = 'car-taillight';
    tail.scale.set(0.16, 0.16, 0.1);
    tail.position.copy(on(cx + side * 0.25, 1.31, 0.02));
    tail.userData.ownsMaterial = true;
    tail.userData.ownsGeometry = true;
    group.add(tail);
    a.taillights.push(tail);

    // Handrail up the corner of the mask, standing off the moulding.
    const rail = new Matrix4().makeScale(0.035, 1.3, 0.035);
    rail.setPosition(side * 1.26, 1.24, on(side * 1.26, 1.6, 0.035).z);
    under.add(unitCylinder(6), rail, steel);
  }

  // --- wipers --------------------------------------------------------------
  // Parked along the bottom of each pane, on the outside of the glass and well
  // inside its width. Stood up across the screen they read as a girder through
  // the view, and hung off the corner they used to reach out past the bodyside.
  for (const [wx, lean] of [[-1.05, -1.5], [1.05, 1.5]] as [number, number][]) {
    const at = on(wx, SCREEN_SILL + 0.04, 0.04);
    const arm = new Matrix4().makeScale(0.02, 0.8, 0.02);
    arm.premultiply(new Matrix4().makeRotationZ(lean));
    arm.premultiply(new Matrix4().makeTranslation(at.x, at.y, at.z));
    under.add(unitBox(), arm, new Color(0.1, 0.1, 0.11));
  }

  // --- skirt ---------------------------------------------------------------
  // Full width over the coupler, with the obstacle deflector under it. It is
  // built from the same surface as the mask so it follows the plan of the face
  // rather than sitting under it as a plain box.
  band(0.44, 0.62, -faceHalf(0.8) * 0.95, faceHalf(0.8) * 0.95, darkGrey, shell, false);
  const skirtEdge = facePoint(0, 0.46, front).z;
  matrix.makeScale(2.2, 0.06, 0.2);
  matrix.setPosition(0, 0.44, skirtEdge + 0.12);
  under.add(unitBox(), matrix, new Color(0.11, 0.12, 0.13));
  // Coupler head. It lives behind the skirt where the prototype's does; poking
  // it out through the front was the rod that used to hang in mid air.
  matrix.makeScale(0.34, 0.3, 0.7);
  matrix.setPosition(0, 0.5, front + 0.05);
  under.add(unitBox(), matrix, new Color(0.16, 0.17, 0.18));
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
    axle.premultiply(new Matrix4().makeTranslation(0.67, axleY, az));
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
  motor.premultiply(new Matrix4().makeTranslation(0.43, axleY + 0.02, half - 0.55));
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
export const WIPER_PARK = -1.5;

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
  const dark = new MeshBuilder();
  const matrix = new Matrix4();

  const front = -(carLength / 2 - 0.25);
  const floor = FLOOR;
  /** Back of the cab, where the bulkhead to the saloon stands. */
  const back = front + 2.65;
  /** Top of the console, at the height a driver rests a hand on it. */
  const DESK = 1.92;

  const panel = new Color(0.21, 0.22, 0.24);
  const lining = new Color(0.54, 0.53, 0.5);
  const deskTop = new Color(0.11, 0.115, 0.13);
  const trim = new Color(0.42, 0.44, 0.46);
  const black = new Color(0.06, 0.065, 0.07);

  // --- shell of the cab ----------------------------------------------------
  // Floor, ceiling and the bulkhead behind the driver, all kept inside the
  // bodyside: anything wider than `INNER_HALF` comes out through the side of
  // the train where the shell draws in at the nose.
  matrix.makeScale(INNER_HALF * 2, 0.08, back - front);
  matrix.setPosition(0, floor - 0.08, (front + back) / 2);
  builder.add(unitBox(), matrix, panel);
  matrix.makeScale(INNER_HALF * 2 - 0.06, 0.1, back - front - 0.1);
  matrix.setPosition(0, 3.28, (front + back) / 2);
  builder.add(unitBox(), matrix, lining);

  // Bulkhead to the saloon, with the door through it on the driver's right and
  // a small window beside the door.
  matrix.makeScale(INNER_HALF * 2, 3.3 - floor, 0.1);
  matrix.setPosition(0, floor, back);
  builder.add(unitBox(), matrix, panel);
  matrix.makeScale(0.72, 1.98, 0.06);
  matrix.setPosition(0.62, floor, back - 0.05);
  builder.add(unitBox(), matrix, new Color(0.34, 0.36, 0.38));
  matrix.makeScale(0.05, 1.98, 0.04);
  matrix.setPosition(0.24, floor, back - 0.09);
  dark.add(unitBox(), matrix, black);
  // Notice board and a fire extinguisher against the bulkhead.
  matrix.makeScale(0.44, 0.32, 0.03);
  matrix.setPosition(-0.5, 2.5, back - 0.09);
  builder.add(unitBox(), matrix, new Color(0.78, 0.77, 0.72));
  const bottle = new Matrix4().makeScale(0.17, 0.44, 0.17);
  bottle.setPosition(-1.05, floor, back - 0.24);
  dark.add(unitCylinder(8), bottle, new Color(0.52, 0.1, 0.09));

  // Side linings, stopping short of the side window so the glazing in the
  // bodyside is what the driver looks through, not a panel behind it.
  for (const sx of [-1, 1]) {
    matrix.makeScale(0.06, SILL - floor, back - front - 0.1);
    matrix.setPosition(sx * (INNER_HALF - 0.03), floor, (front + back) / 2);
    builder.add(unitBox(), matrix, panel);
    matrix.makeScale(0.06, 3.28 - HEAD, back - front - 0.1);
    matrix.setPosition(sx * (INNER_HALF - 0.03), HEAD, (front + back) / 2);
    builder.add(unitBox(), matrix, lining);
    // Grab handle beside the driver's door.
    matrix.makeScale(0.05, 0.9, 0.05);
    matrix.setPosition(sx * (INNER_HALF - 0.1), 1.9, back - 0.4);
    builder.add(unitBox(), matrix, trim);
  }

  // Sun blind, rolled up against the header well clear of the screen so it
  // shades the driver without cutting into the view of the line.
  matrix.makeScale(1.15, 0.09, 0.16);
  matrix.setPosition(-0.55, 3.14, front + 0.34);
  dark.add(unitBox(), matrix, new Color(0.24, 0.23, 0.21));
  // Cab light over the desk.
  matrix.makeScale(0.5, 0.05, 0.3);
  matrix.setPosition(-0.2, 3.22, front + 1.5);
  builder.add(unitBox(), matrix, new Color(0.85, 0.84, 0.8));

  // --- console -------------------------------------------------------------
  // A desk across the front of the cab: a raked instrument panel facing the
  // driver, a flat top to work the handles off, and a plain front down to the
  // floor. It is kept low and shallow - a deep desk fills the bottom third of
  // the windscreen and the driver ends up looking over a wall.
  const deskFront = front + 0.42;
  const deskBack = front + 1.16;
  matrix.makeScale(INNER_HALF * 2 - 0.14, 0.07, deskBack - deskFront);
  matrix.setPosition(0, DESK, (deskFront + deskBack) / 2);
  builder.add(unitBox(), matrix, deskTop);
  // The instrument panel stands at the far edge of the desk and leans back at
  // the driver, so the dials are read over the handles and the whole board sits
  // just under the windscreen sill instead of across the view.
  const board = new Matrix4().makeScale(INNER_HALF * 2 - 0.14, 0.32, 0.07);
  board.premultiply(new Matrix4().makeRotationX(0.34));
  board.premultiply(new Matrix4().makeTranslation(0, DESK, deskFront));
  builder.add(unitBox(), board, panel);
  // Front of the desk, and the kick panel facing the driver under it.
  matrix.makeScale(INNER_HALF * 2 - 0.14, DESK - floor, 0.08);
  matrix.setPosition(0, floor, deskFront);
  builder.add(unitBox(), matrix, panel);
  matrix.makeScale(INNER_HALF * 2 - 0.3, DESK - floor - 0.1, 0.06);
  matrix.setPosition(0, floor, deskBack - 0.02);
  dark.add(unitBox(), matrix, black);

  /** Puts an instrument on the raked board at height `h` above the desk. */
  const onBoard = (x: number, h: number, w: number, tall: number, color: Color, into = dark) => {
    const m = new Matrix4().makeScale(w, tall, 0.035);
    m.premultiply(new Matrix4().makeRotationX(0.34));
    m.premultiply(new Matrix4().makeTranslation(x, DESK + h, deskFront + 0.05 + h * 0.35));
    into.add(unitBox(), m, color);
  };
  // Speedometer in front of the driver, the brake and main reservoir gauges
  // beside it, and the monitor over on the other side of the board.
  const bezel = revolved(
    [
      [0.0, 0.0],
      [0.46, 0.0],
      [0.5, 0.05],
      [0.44, 0.09],
      [0.0, 0.09],
    ],
    16,
  );
  for (const [gx, gs] of [[-0.6, 0.22], [-0.26, 0.13], [-0.07, 0.13]] as [number, number][]) {
    const at = new Matrix4().makeRotationX(Math.PI / 2 + 0.34);
    at.premultiply(new Matrix4().makeTranslation(gx, DESK + 0.15, deskFront + 0.12));
    const rim = new Matrix4().makeScale(gs, 0.04, gs).premultiply(at);
    builder.add(bezel, rim, trim);
    // A turned cylinder rather than a surface of revolution closing on its
    // axis: the fan of triangles that one ends in shades as a pinwheel, which
    // is the last thing a dial face should look like.
    const dial = new Matrix4().makeScale(gs * 0.84, 0.04, gs * 0.84).premultiply(at);
    dark.add(unitCylinder(20), dial, new Color(0.11, 0.115, 0.13));
    // A needle, so the dial reads as an instrument rather than as a hole.
    const needle = new Matrix4().makeScale(0.016, gs * 0.36, 0.016);
    needle.premultiply(new Matrix4().makeRotationZ(-2.1));
    needle.premultiply(new Matrix4().makeTranslation(0, 0.045, 0));
    needle.premultiply(at);
    builder.add(unitBox(), needle, new Color(0.9, 0.88, 0.84));
  }
  bezel.dispose();
  // Driver's monitor, and the row of ATS indicator lamps along the board.
  onBoard(0.42, 0.09, 0.34, 0.15, new Color(0.05, 0.07, 0.09));
  for (let i = 0; i < 5; i++) {
    onBoard(-1.06 + i * 0.1, 0.26, 0.06, 0.04, i === 1 ? new Color(0.5, 0.16, 0.1) : trim);
  }
  // Switch panel on the flat of the desk, on the far side from the handles.
  for (let i = 0; i < 4; i++) {
    matrix.makeScale(0.07, 0.03, 0.07);
    matrix.setPosition(0.5 + i * 0.1, DESK + 0.07, deskFront + 0.3);
    dark.add(unitBox(), matrix, trim);
  }
  // Timetable holder standing on the desk, where every Japanese cab has one.
  const holder = new Matrix4().makeScale(0.24, 0.19, 0.02);
  holder.premultiply(new Matrix4().makeRotationX(0.34));
  holder.premultiply(new Matrix4().makeTranslation(-1.04, DESK + 0.06, deskFront + 0.2));
  builder.add(unitBox(), holder, new Color(0.86, 0.85, 0.8));

  // --- driver's seat -------------------------------------------------------
  // Set to the left, as it is in a Japanese cab, and low enough that the eye
  // clears the desk with the whole screen still above it.
  const seatX = -0.58;
  matrix.makeScale(0.5, 0.11, 0.5);
  matrix.setPosition(seatX, 1.6, front + 1.62);
  builder.add(unitBox(), matrix, new Color(0.1, 0.12, 0.15));
  const backRest = new Matrix4().makeScale(0.5, 0.66, 0.11);
  backRest.premultiply(new Matrix4().makeRotationX(-0.12));
  backRest.premultiply(new Matrix4().makeTranslation(seatX, 1.7, front + 1.88));
  builder.add(unitBox(), backRest, new Color(0.1, 0.12, 0.15));
  const pedestal = new Matrix4().makeScale(0.13, 0.45, 0.13);
  pedestal.setPosition(seatX, floor, front + 1.62);
  builder.add(unitCylinder(8), pedestal, trim);
  matrix.makeScale(0.42, 0.05, 0.34);
  matrix.setPosition(seatX, floor, front + 1.62);
  builder.add(unitBox(), matrix, trim);

  const mesh = builder.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0.14 }),
    false,
    'cab-interior',
  );
  if (mesh) {
    mesh.userData.ownsMaterial = true;
    group.add(mesh);
  }
  const darkMesh = dark.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.02 }),
    false,
    'cab-fittings',
  );
  if (darkMesh) {
    darkMesh.userData.ownsMaterial = true;
    group.add(darkMesh);
  }

  // --- handles -------------------------------------------------------------
  // Two handle desk: the master controller under the driver's left hand and the
  // brake handle to the right of it, both on the flat of the desk in front of
  // the seat rather than spread across the whole width of the cab.
  const handle = (
    stem: number,
    knobLength: number,
    knobColor: Color,
    name: string,
  ): Group => {
    const pivot = new Group();
    const b = new MeshBuilder();
    b.add(unitBox(), new Matrix4().makeScale(0.06, stem, 0.06), new Color(0.22, 0.23, 0.25));
    const knob = new Matrix4().makeScale(0.1, 0.075, knobLength);
    knob.setPosition(0, stem, knobLength * 0.24);
    b.add(unitBox(), knob, knobColor);
    const m = b.toMesh(
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.46, metalness: 0.42 }),
      false,
      name,
    );
    if (m) {
      m.userData.ownsMaterial = true;
      pivot.add(m);
    }
    return pivot;
  };
  const masterHandle = handle(0.24, 0.17, new Color(0.5, 0.13, 0.1), 'master-handle');
  masterHandle.position.set(-1.0, DESK + 0.06, deskBack - 0.28);
  group.add(masterHandle);
  const brakeHandle = handle(0.22, 0.15, new Color(0.15, 0.17, 0.2), 'brake-handle');
  brakeHandle.position.set(-0.2, DESK + 0.06, deskBack - 0.28);
  group.add(brakeHandle);
  // Their quadrant plates, so the handles are seen to move against something.
  const quadrant = new MeshBuilder();
  for (const qx of [-1.0, -0.2]) {
    // Quadrant plate beside each handle, and the boss it turns in, so the
    // handles are seen to be mounted on the desk rather than laid on it.
    const q = new Matrix4().makeScale(0.03, 0.08, 0.26);
    q.setPosition(qx + 0.09, DESK + 0.05, deskBack - 0.26);
    quadrant.add(unitBox(), q, new Color(0.2, 0.21, 0.23));
    const boss = new Matrix4().makeScale(0.16, 0.05, 0.16);
    boss.setPosition(qx, DESK + 0.04, deskBack - 0.28);
    quadrant.add(unitCylinder(10), boss, new Color(0.24, 0.25, 0.27));
  }
  const quadrantMesh = quadrant.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }),
    false,
    'cab-quadrants',
  );
  if (quadrantMesh) {
    quadrantMesh.userData.ownsMaterial = true;
    group.add(quadrantMesh);
  }

  // --- wiper ---------------------------------------------------------------
  // The blade the driver watches is the one on the outside of the screen, so it
  // is hung on the mask rather than inside the cab, parked along the bottom of
  // the driver's pane.
  const wiper = new Group();
  const wiperBuilder = new MeshBuilder();
  const blade = new Matrix4().makeScale(0.02, 0.84, 0.02);
  blade.setPosition(0, 0.42, 0);
  wiperBuilder.add(unitBox(), blade, new Color(0.09, 0.09, 0.1));
  const wiperArm = new Matrix4().makeScale(0.032, 0.3, 0.032);
  wiperArm.setPosition(0, 0.12, -0.02);
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
  wiper.position.copy(facePoint(-1.05, SCREEN_SILL + 0.04, front));
  wiper.position.z -= 0.06;
  wiper.rotation.z = WIPER_PARK;
  group.add(wiper);

  return {
    group,
    masterHandle,
    brakeHandle,
    wiper,
    // Seated eye: on the driver's side, high enough to clear the desk, and far
    // enough back that the screen pillars stay out at the edge of vision.
    eyePosition: new Vector3(-0.55, 2.46, front + 1.6),
  };
}
