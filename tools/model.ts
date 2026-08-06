/**
 * Turntable stage for the hand-built models.
 *
 * Loads one subject at a time - a car, a station, a level crossing, a street of
 * buildings - lights it neutrally and exposes `window.stage` so
 * `tools/modelshot.mjs` can point the camera at it and grab a frame. Nothing
 * here is part of the game; it exists so that geometry can be judged without
 * waiting for a route to stream in.
 */

import {
  ACESFilmicToneMapping,
  BackSide,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PMREMGenerator,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Box3,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { Rng } from '../src/core/Random';
import { QUALITY_PROFILES } from '../src/core/Settings';
import { createCar } from '../src/train/TrainModel';
import { TrackPath, SAMPLE_STEP, type TrackSample } from '../src/world/TrackPath';
import { TerrainField } from '../src/world/TerrainField';
import { TerrainNoise } from '../src/world/Biome';
import { WaterRegistry } from '../src/materials/WaterMaterial';
import { Occupancy } from '../src/world/Sites';
import type { ChunkContext } from '../src/world/ChunkContext';
import { buildStations } from '../src/builders/StationBuilder';
import { buildCrossings } from '../src/builders/TrackBuilder';
import { buildBuildings } from '../src/builders/SceneryBuilder';
import { blendedAttr } from '../src/world/Biome';

const params = new URLSearchParams(location.search);
const subject = params.get('subject') ?? 'car';

const renderer = new WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0x8fa8bd);
const camera = new PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.3, 4000);

const sun = new DirectionalLight(0xfff2dd, 3.1);
sun.position.set(60, 90, 40);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -40;
sun.shadow.camera.right = 40;
sun.shadow.camera.top = 40;
sun.shadow.camera.bottom = -40;
sun.shadow.camera.far = 300;
scene.add(sun);
// A weak fill from the opposite quarter, so that a shape can still be read on
// the side the sun is not on. A turntable that only lights one end is no use
// for judging the other.
const fill = new DirectionalLight(0xcfe0f2, 0.9);
fill.position.set(-70, 50, -60);
scene.add(fill);
scene.add(new HemisphereLight(0xbcd4ee, 0x4a4438, 1.3));

// Image based lighting, so metals and glass have something to reflect: a sky
// gradient over a dull ground, which is all a probe needs to be for judging a
// shape.
const envScene = new Scene();
const envDome = new Mesh(
  new SphereGeometry(500, 24, 16),
  new MeshBasicMaterial({ color: 0x9fbcd8, side: BackSide }),
);
envScene.add(envDome);
const envFloor = new Mesh(
  new PlaneGeometry(1400, 1400),
  new MeshBasicMaterial({ color: 0x4d4f42 }),
);
envFloor.rotation.x = -Math.PI / 2;
envFloor.position.y = -1;
envScene.add(envFloor);
const envSun = new Mesh(
  new SphereGeometry(40, 12, 8),
  new MeshBasicMaterial({ color: 0xfff0d0 }),
);
envSun.position.set(180, 260, 130);
envScene.add(envSun);
const pmrem = new PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(envScene, 0.04).texture;

const ground = new Mesh(
  new PlaneGeometry(600, 600),
  new MeshStandardMaterial({ color: 0x6c7358, roughness: 0.95 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const stage = new Group();
scene.add(stage);

/**
 * A real route, so that the builders that place things in track space get the
 * geometry they expect rather than a stub that lies to them.
 *
 * The route is generated once and every chunk context is cut from it: building
 * a fresh `TrackPath` per candidate chunk is both slow and wrong, because the
 * alignment is integrated forward from its own state and a route regenerated
 * from chainage zero each time never gets anywhere.
 */
const seed = Number(params.get('seed') ?? 4242);
const noise = new TerrainNoise(seed);
const track = new TrackPath(seed, 10.5);
const field = new TerrainField(track, noise);

function chunkContext(sStart: number, group: Group): ChunkContext {
  track.extendTo(sStart + 800);
  const samples: TrackSample[] = [];
  for (let s = sStart; s <= sStart + 250.001; s += SAMPLE_STEP) {
    samples.push(track.at(track.sampleIndex(s)));
  }
  return {
    track,
    field,
    sStart,
    sEnd: sStart + 250,
    rng: new Rng((seed ^ (sStart * 0x9e3779b1)) >>> 0),
    profile: QUALITY_PROFILES.high,
    samples,
    group,
    water: new WaterRegistry(),
    signals: [],
    crossings: [],
    detailed: true,
    sites: new Occupancy(),
  };
}

/** Moves a track-space build back to the origin so the camera can frame it. */
function recentre(group: Group, at: { x: number; y: number; z: number; heading: number }): void {
  group.position.set(-at.x, -at.y, -at.z);
  const wrapper = new Group();
  wrapper.add(group);
  wrapper.rotation.y = at.heading;
  stage.add(wrapper);
}

/**
 * Centre of what was actually built.
 *
 * Scenery is scattered over hundreds of metres either side of the line, so
 * aiming the camera at the chainage the chunk was cut from usually frames an
 * empty field. Framing the geometry itself is the only reliable way to get a
 * close view of it.
 */
const focus = new Vector3();
function focusOnBuilt(): void {
  const box = new Box3().setFromObject(stage);
  if (!box.isEmpty()) box.getCenter(focus);
}

let radius = 22;

if (subject === 'car' || subject === 'cab-car') {
  const car = createCar({
    isCab: subject === 'cab-car',
    bodyColor: 0xd6dbe0,
    accentColor: 0x1f6fb5,
    hasPantograph: subject !== 'cab-car',
    destination: '高原',
    length: 20,
  });
  car.group.position.y = 0.02;
  stage.add(car.group);
  radius = 26;
} else if (subject === 'station' || subject === 'crossing' || subject === 'buildings') {
  const built = new Group();
  // Walk forward until the route offers the feature we want to look at. For a
  // street of buildings that means the densest chunk within a few kilometres,
  // not the first one that puts up a single shed.
  let anchor = track.sampleAt(0);
  const find = () => {
    for (let start = 250; start < 60000; start += 250) {
      const ctx = chunkContext(start, built);
      if (subject === 'station') {
        const hit = track.stations.find((st) => st.s >= start && st.s < start + 250);
        if (hit) {
          anchor = track.sampleAt(hit.s);
          buildStations(ctx);
          return;
        }
      } else if (subject === 'crossing') {
        const hit = track.crossings.find((c) => c.s >= start && c.s < start + 250);
        if (hit) {
          anchor = track.sampleAt(hit.s);
          buildBuildings(ctx);
          buildCrossings(ctx);
          return;
        }
      } else {
        // A street is only worth photographing where the route is actually
        // built up, so wait for a chunk in town rather than taking the first
        // one that puts up a shed in a field.
        const mid = track.sampleAt(start + 125);
        if (blendedAttr(mid.weights, 'buildingDensity') < 0.75) continue;
        anchor = mid;
        for (let k = -1; k <= 1; k++) buildBuildings(chunkContext(start + k * 250, built));
        return;
      }
    }
  };
  find();
  recentre(built, anchor);
  if (subject === 'buildings') {
    stage.updateMatrixWorld(true);
    focusOnBuilt();
  }
  radius = subject === 'buildings' ? 150 : 46;
}

interface Stage {
  render(azimuth: number, elevation: number, distance: number, target: number[]): void;
}

const target = new Vector3();
(window as unknown as { stage: Stage }).stage = {
  render(azimuth: number, elevation: number, distance: number, at: number[]) {
    target.set(focus.x + at[0], at[1], focus.z + at[2]);
    const d = distance || radius;
    camera.position.set(
      target.x + Math.cos(elevation) * Math.sin(azimuth) * d,
      target.y + Math.sin(elevation) * d,
      target.z + Math.cos(elevation) * Math.cos(azimuth) * d,
    );
    camera.lookAt(target);
    renderer.render(scene, camera);
  },
};

(window as unknown as { __radius: number }).__radius = radius;
(window as unknown as { stageReady: boolean }).stageReady = true;
(window as unknown as { stage: Stage }).stage.render(2.3, 0.22, radius, [0, 2, 0]);
