import {
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
import { unitBox, unitCylinder } from '../builders/Prefabs';
import { createBodyMaterial, createGlassMaterial } from '../materials/Materials';
import { textures } from '../materials/TextureFactory';

/**
 * Rolling stock.
 *
 * A four car commuter EMU in the modern JR idiom: stainless body with a
 * coloured band, wide sliding doors, a raked cab front and a single arm
 * pantograph. Bodies are swept from a cross-section so the roof curve and the
 * tumblehome read correctly from inside the cab as well as from outside.
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

type ProfilePoint = { x: number; y: number; band: 'body' | 'accent' | 'roof' };

/** Half cross-section of the body shell, from the floor line to the roof. */
const BODY_PROFILE: ProfilePoint[] = [
  { x: 0.0, y: 0.98, band: 'body' },
  { x: 1.18, y: 0.99, band: 'body' },
  { x: 1.40, y: 1.22, band: 'body' },
  { x: 1.47, y: 1.75, band: 'body' },
  { x: 1.48, y: 2.24, band: 'accent' },
  { x: 1.47, y: 3.22, band: 'accent' },
  { x: 1.43, y: 3.50, band: 'body' },
  { x: 1.28, y: 3.82, band: 'roof' },
  { x: 0.92, y: 4.02, band: 'roof' },
  { x: 0.0, y: 4.08, band: 'roof' },
];

function fullProfile(): ProfilePoint[] {
  const right = BODY_PROFILE.slice();
  const left = BODY_PROFILE.slice(0, -1)
    .reverse()
    .map((p) => ({ x: -p.x, y: p.y, band: p.band }));
  return [...right, ...left];
}

export function createCar(options: CarOptions): CarModel {
  const group = new Group();
  const body = new MeshBuilder();
  const dark = new MeshBuilder();
  const glass = new MeshBuilder();
  const windscreen = new MeshBuilder();

  const L = options.length;
  const halfL = L / 2 - 0.25;
  const profile = fullProfile();
  const bodyColor = new Color(options.bodyColor);
  const accentColor = new Color(options.accentColor);
  const shadow = new Color(0.28, 0.29, 0.31);

  // --- shell ---------------------------------------------------------------
  // Stations along the car; the cab end tapers in over the last 2.6 m.
  const stations: number[] = [];
  for (let z = -halfL; z <= halfL + 0.001; z += 0.65) stations.push(z);

  const rows: Vector3[][] = [];
  const uvV: number[] = [];
  for (const z of stations) {
    const nose = options.isCab ? Math.max(0, (-halfL + 2.6 - z) / 2.6) : 0;
    const taperX = 1 - nose * nose * 0.30;
    const taperTop = 1 - nose * nose * 0.14;
    const row: Vector3[] = [];
    for (const p of profile) {
      row.push(new Vector3(p.x * taperX, 0.98 + (p.y - 0.98) * taperTop, z));
    }
    rows.push(row);
    uvV.push(z * 0.2);
  }
  // Roofs on Japanese stock are unpainted grey, which also stops them from
  // blowing out under a high sun.
  const roofColor = new Color(0x8d949b);
  const columnColors = profile.map((p) =>
    p.band === 'accent' ? accentColor : p.band === 'roof' ? roofColor : bodyColor,
  );
  const uvU = profile.map((_, i) => i / profile.length);
  body.addSweep(rows, columnColors, uvV, uvU, true);

  // End caps.
  const capCentreFront = new Vector3(0, 2.5, -halfL);
  const capCentreRear = new Vector3(0, 2.5, halfL);
  for (let i = 0; i < profile.length; i++) {
    const j = (i + 1) % profile.length;
    const a = rows[0][i];
    const b = rows[0][j];
    body.addTriangle(capCentreFront, b, a, options.isCab ? accentColor : shadow, false);
    const c = rows[rows.length - 1][i];
    const d = rows[rows.length - 1][j];
    body.addTriangle(capCentreRear, c, d, shadow, false);
  }

  // --- windows and doors ---------------------------------------------------
  const windowY = 2.72;
  const windowH = 0.92;
  const doorPositions = [-halfL * 0.62, 0, halfL * 0.62];
  const matrix = new Matrix4();

  for (const side of [-1, 1]) {
    const x = side * 1.47;
    // Continuous dark window band with lighter pillars, then the doors.
    for (const dz of doorPositions) {
      // Door leaves.
      for (const leaf of [-1, 1]) {
        matrix.makeScale(0.04, 2.05, 0.62);
        matrix.setPosition(x, 1.05, dz + leaf * 0.33);
        dark.add(unitBox(), matrix, new Color(0.55, 0.58, 0.6));
        matrix.makeScale(0.05, 0.85, 0.5);
        matrix.setPosition(x + side * 0.01, 2.05, dz + leaf * 0.33);
        glass.add(unitBox(), matrix, new Color(0.1, 0.14, 0.18));
      }
      // Door surround.
      matrix.makeScale(0.03, 2.9, 1.42);
      matrix.setPosition(x - side * 0.02, 1.0, dz);
      dark.add(unitBox(), matrix, new Color(0.35, 0.37, 0.4));
    }

    // Saloon windows between the doors.
    const gaps: [number, number][] = [
      [-halfL + (options.isCab ? 2.8 : 0.7), doorPositions[0] - 0.85],
      [doorPositions[0] + 0.85, doorPositions[1] - 0.85],
      [doorPositions[1] + 0.85, doorPositions[2] - 0.85],
      [doorPositions[2] + 0.85, halfL - 0.7],
    ];
    for (const [z0, z1] of gaps) {
      if (z1 - z0 < 0.6) continue;
      const panes = Math.max(1, Math.round((z1 - z0) / 1.5));
      const paneLength = (z1 - z0) / panes;
      for (let k = 0; k < panes; k++) {
        const zc = z0 + paneLength * (k + 0.5);
        matrix.makeScale(0.06, windowH, paneLength - 0.16);
        matrix.setPosition(x, windowY - windowH / 2, zc);
        glass.add(unitBox(), matrix, new Color(0.08, 0.12, 0.16));
      }
    }
  }

  // --- underframe and bogies ----------------------------------------------
  matrix.makeScale(2.5, 0.45, L - 1.6);
  matrix.setPosition(0, 0.55, 0);
  dark.add(unitBox(), matrix, new Color(0.18, 0.19, 0.2));

  const bogieZ = [-(L / 2 - 3.0), L / 2 - 3.0];
  for (const bz of bogieZ) {
    matrix.makeScale(2.2, 0.5, 2.9);
    matrix.setPosition(0, 0.42, bz);
    dark.add(unitBox(), matrix, new Color(0.14, 0.15, 0.16));
    for (const wz of [-1.05, 1.05]) {
      for (const wx of [-0.535, 0.535]) {
        matrix.makeScale(0.86, 0.14, 0.86);
        matrix.setPosition(wx, 0.43, bz + wz);
        // Wheels are discs standing on the rail; rotate the cylinder onto its side.
        const wheel = new Matrix4().makeRotationZ(Math.PI / 2).premultiply(matrix);
        dark.add(unitCylinder(14), wheel, new Color(0.3, 0.3, 0.32));
      }
      // Axle.
      matrix.makeScale(0.16, 1.1, 0.16);
      matrix.setPosition(-0.55, 0.43, bz + wz);
      const axle = new Matrix4().makeRotationZ(Math.PI / 2).premultiply(matrix);
      dark.add(unitCylinder(6), axle, new Color(0.22, 0.22, 0.24));
    }
  }

  // Couplers.
  for (const cz of [-1, 1]) {
    matrix.makeScale(0.34, 0.34, 0.9);
    matrix.setPosition(0, 0.7, cz * (L / 2 - 0.1));
    dark.add(unitBox(), matrix, new Color(0.2, 0.2, 0.22));
  }

  // --- roof equipment ------------------------------------------------------
  for (const az of [-halfL * 0.5, halfL * 0.5]) {
    matrix.makeScale(1.9, 0.42, 2.2);
    matrix.setPosition(0, 4.02, az);
    dark.add(unitBox(), matrix, new Color(0.62, 0.63, 0.64));
  }

  let pantograph: Object3D | undefined;
  if (options.hasPantograph) {
    pantograph = new Group();
    const pan = new MeshBuilder();
    const metal = new Color(0.55, 0.56, 0.58);
    // Insulators.
    for (const ix of [-0.75, 0.75]) {
      matrix.makeScale(0.22, 0.35, 0.22);
      matrix.setPosition(ix, 0, 0);
      pan.add(unitCylinder(8), matrix, new Color(0.75, 0.7, 0.6));
    }
    // Lower arm.
    const lower = new Matrix4().makeScale(0.1, 1.5, 0.1);
    lower.setPosition(0, 0.35, -0.3);
    pan.add(unitBox(), new Matrix4().makeRotationX(-0.55).multiply(lower), metal);
    // Upper arm.
    const upper = new Matrix4().makeScale(0.08, 1.35, 0.08);
    upper.setPosition(0, 1.05, 0.55);
    pan.add(unitBox(), new Matrix4().makeRotationX(0.65).multiply(upper), metal);
    // Collector head.
    matrix.makeScale(1.75, 0.09, 0.28);
    matrix.setPosition(0, 1.92, 0);
    pan.add(unitBox(), matrix, new Color(0.35, 0.35, 0.36));
    const panMesh = pan.toMesh(
      new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.7 }),
      false,
      'pantograph',
    );
    if (panMesh) {
      panMesh.castShadow = true;
      pantograph.add(panMesh);
    }
    pantograph.position.set(0, 4.1, halfL * 0.62);
    group.add(pantograph);
  }

  // --- cab front -----------------------------------------------------------
  const headlights: Mesh[] = [];
  const taillights: Mesh[] = [];
  if (options.isCab) {
    const front = -halfL - 0.05;
    // Windscreen. Kept genuinely clear: the driver is sitting right behind it.
    matrix.makeScale(2.3, 1.15, 0.05);
    matrix.setPosition(0, 2.3, front + 0.16);
    windscreen.add(
      unitBox(),
      new Matrix4().makeRotationX(0.1).premultiply(matrix),
      new Color(0.62, 0.70, 0.78),
    );
    // Skirt.
    matrix.makeScale(2.1, 0.75, 0.5);
    matrix.setPosition(0, 0.45, front + 0.3);
    dark.add(unitBox(), matrix, new Color(0.16, 0.17, 0.18));

    const headMaterial = new MeshBasicMaterial({ color: 0xfff4dd });
    const tailMaterial = new MeshBasicMaterial({ color: 0x330404 });
    for (const lx of [-0.85, 0.85]) {
      const lamp = new Mesh(unitBox(), headMaterial);
      lamp.scale.set(0.34, 0.16, 0.1);
      lamp.position.set(lx, 1.42, front + 0.22);
      lamp.userData.role = 'headlight';
      group.add(lamp);
      headlights.push(lamp);

      const tail = new Mesh(unitBox(), tailMaterial.clone());
      tail.scale.set(0.16, 0.14, 0.1);
      tail.position.set(lx * 0.72, 1.42, front + 0.22);
      group.add(tail);
      taillights.push(tail);
    }

    // Destination blind above the windscreen.
    if (options.destination) {
      const blind = new Mesh(
        new PlaneGeometry(1.0, 0.26),
        new MeshBasicMaterial({ map: textures.destinationBlind(options.destination) }),
      );
      blind.position.set(0.35, 3.16, front + 0.2);
      blind.rotation.y = Math.PI;
      group.add(blind);
    }
  }

  // --- assemble ------------------------------------------------------------
  const bodyMesh = body.toMesh(createBodyMaterial(0xffffff, 0.26), true, 'car-body');
  if (bodyMesh) {
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;
    (bodyMesh.material as MeshStandardMaterial).vertexColors = true;
    group.add(bodyMesh);
  }
  const darkMesh = dark.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.68, metalness: 0.35 }),
    false,
    'car-underframe',
  );
  if (darkMesh) {
    darkMesh.castShadow = true;
    group.add(darkMesh);
  }
  const glassMaterial = createGlassMaterial(0x0b1116, 0.82);
  glassMaterial.vertexColors = true;
  const glassMesh = glass.toMesh(glassMaterial, false, 'car-glass');
  if (glassMesh) group.add(glassMesh);

  const windscreenMesh = windscreen.toMesh(
    createGlassMaterial(0xdfe9f2, 0.1),
    false,
    'car-windscreen',
  );
  if (windscreenMesh) {
    (windscreenMesh.material as MeshStandardMaterial).vertexColors = true;
    windscreenMesh.renderOrder = 2;
    group.add(windscreenMesh);
  }

  // Interior lighting, visible through the windows at night.
  const interiorLights: Mesh[] = [];
  const interiorMaterial = new MeshBasicMaterial({ color: 0x000000 });
  for (const lz of [-halfL * 0.6, 0, halfL * 0.6]) {
    const light = new Mesh(unitBox(), interiorMaterial);
    light.scale.set(2.6, 0.1, halfL * 0.55);
    light.position.set(0, 3.55, lz);
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

  const front = -(carLength / 2 - 0.25) - 0.05;
  const floor = 1.12;
  const panel = new Color(0.19, 0.20, 0.22);
  const desk = new Color(0.13, 0.14, 0.155);
  const trim = new Color(0.40, 0.42, 0.44);

  // Floor and rear bulkhead. The cab is a shallow box; the windscreen fills
  // almost the whole forward view, as it does in a real EMU.
  matrix.makeScale(2.7, 0.08, 2.9);
  matrix.setPosition(0, floor - 0.08, front + 1.55);
  builder.add(unitBox(), matrix, panel);
  matrix.makeScale(2.7, 2.5, 0.12);
  matrix.setPosition(0, floor, front + 3.0);
  builder.add(unitBox(), matrix, panel);

  // Ceiling, kept high enough to stay out of the driver's eyeline.
  matrix.makeScale(2.8, 0.12, 3.0);
  matrix.setPosition(0, 3.5, front + 1.55);
  builder.add(unitBox(), matrix, panel);

  // Console: a low desk that reads as a dark band across the bottom of the
  // view without eating into the windscreen.
  matrix.makeScale(2.56, 0.1, 0.78);
  matrix.setPosition(0, 1.92, front + 0.58);
  builder.add(unitBox(), new Matrix4().makeRotationX(-0.16).premultiply(matrix), desk);
  matrix.makeScale(2.56, 0.84, 0.14);
  matrix.setPosition(0, 1.12, front + 0.96);
  builder.add(unitBox(), matrix, desk);
  matrix.makeScale(2.56, 0.9, 0.12);
  matrix.setPosition(0, 1.12, front + 0.22);
  builder.add(unitBox(), matrix, panel);

  // Windscreen pillars, right out at the body sides.
  for (const px of [-1.34, 1.34]) {
    matrix.makeScale(0.13, 1.28, 0.16);
    matrix.setPosition(px, 1.96, front + 0.14);
    builder.add(unitBox(), matrix, panel);
  }
  // Header above the glass, and a sun visor over the driver.
  matrix.makeScale(2.85, 0.42, 0.2);
  matrix.setPosition(0, 3.2, front + 0.14);
  builder.add(unitBox(), matrix, panel);
  matrix.makeScale(1.3, 0.05, 0.3);
  matrix.setPosition(-0.55, 3.1, front + 0.36);
  builder.add(unitBox(), matrix, new Color(0.26, 0.25, 0.23));

  // The windscreen itself: very slightly tinted, so reflections read on it.
  matrix.makeScale(2.55, 1.16, 0.03);
  matrix.setPosition(0, 2.02, front + 0.2);
  glass.add(unitBox(), new Matrix4().makeRotationX(0.06).premultiply(matrix), new Color(0.6, 0.68, 0.75));

  // Side walls, glazed above waist height so the cab does not feel boxed in.
  for (const sx of [-1, 1]) {
    matrix.makeScale(0.1, 0.86, 2.7);
    matrix.setPosition(sx * 1.44, floor, front + 1.7);
    builder.add(unitBox(), matrix, panel);
    matrix.makeScale(0.1, 0.5, 2.7);
    matrix.setPosition(sx * 1.44, 3.0, front + 1.7);
    builder.add(unitBox(), matrix, panel);
    // Window pillar between the door window and the rear quarter light.
    matrix.makeScale(0.11, 1.2, 0.16);
    matrix.setPosition(sx * 1.42, 1.98, front + 2.0);
    builder.add(unitBox(), matrix, panel);
  }

  // Driver's seat, just behind the eye point.
  matrix.makeScale(0.56, 0.12, 0.56);
  matrix.setPosition(-0.42, 1.6, front + 1.62);
  builder.add(unitBox(), matrix, new Color(0.11, 0.13, 0.16));
  matrix.makeScale(0.56, 0.62, 0.12);
  matrix.setPosition(-0.42, 1.72, front + 1.92);
  builder.add(unitBox(), matrix, new Color(0.11, 0.13, 0.16));
  matrix.makeScale(0.14, 0.48, 0.14);
  matrix.setPosition(-0.42, 1.12, front + 1.62);
  builder.add(unitBox(), matrix, trim);

  // Instrument bezels on the desk; the readouts themselves live in the HUD.
  for (const gx of [-0.2, 0.36]) {
    matrix.makeScale(0.36, 0.04, 0.36);
    matrix.setPosition(gx, 1.96, front + 0.52);
    builder.add(unitBox(), new Matrix4().makeRotationX(-0.16).premultiply(matrix), trim);
  }

  const mesh = builder.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0.18 }),
    false,
    'cab-interior',
  );
  if (mesh) group.add(mesh);

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
  if (glassMesh) group.add(glassMesh);

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
  if (masterMesh) masterHandle.add(masterMesh);
  masterHandle.position.set(-0.9, 1.92, front + 0.46);
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
  if (brakeMesh) brakeHandle.add(brakeMesh);
  brakeHandle.position.set(0.62, 1.92, front + 0.46);
  group.add(brakeHandle);

  // Windscreen wiper, parked at the bottom of the glass.
  const wiper = new Group();
  const wiperBuilder = new MeshBuilder();
  const blade = new Matrix4().makeScale(0.035, 1.1, 0.035);
  blade.setPosition(0, 0.5, 0);
  wiperBuilder.add(unitBox(), blade, new Color(0.09, 0.09, 0.1));
  const wiperMesh = wiperBuilder.toMesh(
    new MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }),
    false,
    'wiper',
  );
  if (wiperMesh) wiper.add(wiperMesh);
  wiper.position.set(-0.5, 1.98, front + 0.16);
  wiper.rotation.z = -0.62;
  group.add(wiper);

  return {
    group,
    masterHandle,
    brakeHandle,
    wiper,
    eyePosition: new Vector3(-0.45, 2.36, front + 1.05),
  };
}
