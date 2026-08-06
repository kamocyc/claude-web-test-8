import { Group, Vector3 } from 'three';
import { Chunk } from './Chunk';
import { CHUNK_LENGTH } from './ChunkContext';
import { TerrainField } from './TerrainField';
import { TerrainNoise, BIOME_INDEX } from './Biome';
import { TerrainTiles } from './TerrainTiles';
import { SeaSurface } from './SeaSurface';
import { TrackPath } from './TrackPath';
import { WaterRegistry, createWaterMaterial } from '../materials/WaterMaterial';
import { corridorMaterial } from '../builders/TrackBuilder';
import { SIGNAL_LAMP_MATERIALS } from '../builders/TrackBuilder';
import { textures } from '../materials/TextureFactory';
import { setFacadeNight } from '../builders/Prefabs';
import type { QualityProfile } from '../core/Settings';
import { clamp01, smoothstep } from '../core/MathUtils';

/**
 * Streams the world around the train.
 *
 * Track geometry is generated ahead of the player, chunks are built with a
 * per-frame time budget so a new town never stalls the frame, and everything
 * behind is released. Terrain tiles and the sea follow the camera
 * independently, because they are needed in every direction rather than only
 * along the line.
 */
export class World {
  readonly group = new Group();
  readonly track: TrackPath;
  readonly field: TerrainField;
  readonly tiles: TerrainTiles;
  readonly sea: SeaSurface;
  readonly water = new WaterRegistry();
  readonly noise: TerrainNoise;

  private readonly chunks = new Map<number, Chunk>();
  private readonly chunkGroup = new Group();
  private profile: QualityProfile;

  /** Chainage of the player, used to decide what to build. */
  private playerS = 0;

  constructor(seed: number, startTimeOfDay: number, profile: QualityProfile) {
    this.profile = profile;
    this.noise = new TerrainNoise(seed);
    this.track = new TrackPath(seed, startTimeOfDay);
    this.field = new TerrainField(this.track, this.noise);

    this.group.name = 'world';
    this.chunkGroup.name = 'chunks';
    this.group.add(this.chunkGroup);

    this.tiles = new TerrainTiles(this.field, corridorMaterial());
    this.tiles.setViewDistance(profile.viewDistance);
    this.group.add(this.tiles.group);

    const seaMaterial = createWaterMaterial({
      normalMap: textures.waterNormal(),
      shallow: 0x2c7d84,
      deep: 0x05243c,
      waveScale: 1,
      chop: 1,
      foam: 1,
      ripple: 1,
    });
    this.water.register(seaMaterial);
    this.sea = new SeaSurface(this.field, seaMaterial);
    this.group.add(this.sea.mesh);

    // Generate enough route for the opening view before the first frame.
    this.track.extendTo(this.routeAhead(0));
    this.field.rebuildIndex();
  }

  setProfile(profile: QualityProfile): void {
    this.profile = profile;
    this.tiles.setViewDistance(profile.viewDistance);
    textures.setAnisotropy(profile.anisotropy);
  }

  /** Ensures route, chunks, tiles and sea are ready around the player. */
  update(playerS: number, cameraPos: Vector3, buildBudgetMs: number): void {
    this.playerS = playerS;
    const ahead = this.profile.chunksAhead;
    const behind = this.profile.chunksBehind;

    this.track.extendTo(this.routeAhead(playerS));
    this.track.prune(playerS - Math.max((behind + 2) * CHUNK_LENGTH, 1800));
    this.field.rebuildIndex();

    // There is no route before chainage zero. A chunk asked to cover it gets
    // the first sample back for every chainage it queries, and builds itself a
    // corridor whose rows are all the same row: zero-area triangles, normals
    // that normalise to nothing, and a smear of grey ground behind the train
    // for the first few hundred metres of every run.
    const first = Math.max(0, Math.floor((playerS - behind * CHUNK_LENGTH) / CHUNK_LENGTH));
    const last = Math.floor((playerS + ahead * CHUNK_LENGTH) / CHUNK_LENGTH);

    for (const [index, chunk] of this.chunks) {
      if (index < first || index > last) {
        this.chunkGroup.remove(chunk.group);
        chunk.dispose();
        this.chunks.delete(index);
      }
    }

    // Build at most one chunk per frame, nearest first, within the budget.
    const deadline = performance.now() + buildBudgetMs;
    for (let index = first; index <= last; index++) {
      if (this.chunks.has(index)) continue;
      if (performance.now() > deadline && this.chunks.size > 0) break;
      const detailed = Math.abs(index * CHUNK_LENGTH + CHUNK_LENGTH / 2 - playerS) < this.profile.detailDistance;
      const chunk = new Chunk(
        index,
        this.track,
        this.field,
        this.profile,
        this.water,
        detailed,
        this.track.seed,
      );
      this.chunks.set(index, chunk);
      this.chunkGroup.add(chunk.group);
      break;
    }

    this.tiles.refresh(cameraPos.x, cameraPos.z);
    // Ground first: a chunk arriving late costs a few trees, a tile arriving
    // late is a hole in the world.
    this.tiles.processQueue(buildBudgetMs);

    this.sea.setVisible(this.coastNearby());
    if (this.sea.mesh.visible) this.sea.update(cameraPos.x, cameraPos.z);
  }

  /**
   * Chainage the route has to reach.
   *
   * Far enough for the chunks is not far enough for the ground: terrain is
   * drawn to the fog limit and every height it asks for is answered in track
   * space, so route that stops short of the horizon leaves the whole distance
   * projected onto the last sleeper - one chainage, one biome, one elevation,
   * smeared across everything the driver can see. The alignment is cheap to
   * integrate; the horizon is not something to economise on.
   */
  private routeAhead(playerS: number): number {
    const chunks = (this.profile.chunksAhead + 2) * CHUNK_LENGTH;
    return playerS + Math.max(chunks, this.profile.viewDistance + 600);
  }

  /** True when any part of the route in view runs along the sea. */
  private coastNearby(): boolean {
    for (let s = this.playerS - 600; s < this.playerS + 2600; s += 200) {
      const sample = this.track.at(this.track.sampleIndex(s));
      if (sample.weights[BIOME_INDEX.coast] > 0.05) return true;
    }
    return false;
  }

  /**
   * Signal aspects: a train clears the block behind it, so signals just passed
   * show red and step up through yellow to green as the train draws away.
   */
  updateSignals(playerS: number, aiPositions: number[]): void {
    for (const chunk of this.chunks.values()) {
      for (const signal of chunk.signals) {
        const behind = playerS - signal.info.s;
        let aspect = 2;
        if (behind > 0 && behind < 420) aspect = 0;
        else if (behind >= 420 && behind < 1150) aspect = 1;

        // Trains on the opposite road also occupy blocks.
        for (const other of aiPositions) {
          const d = other - signal.info.s;
          if (d > -60 && d < 380) aspect = Math.min(aspect, 0);
          else if (d >= 380 && d < 900) aspect = Math.min(aspect, 1);
        }

        signal.info.aspect = aspect;
        signal.lamps[0].material = aspect === 0 ? SIGNAL_LAMP_MATERIALS.red : SIGNAL_LAMP_MATERIALS.off;
        signal.lamps[1].material =
          aspect === 1 ? SIGNAL_LAMP_MATERIALS.yellow : SIGNAL_LAMP_MATERIALS.off;
        signal.lamps[2].material =
          aspect === 2 ? SIGNAL_LAMP_MATERIALS.green : SIGNAL_LAMP_MATERIALS.off;
      }
    }
  }

  /** Lowers and raises level crossing barriers, and flashes their lights. */
  updateCrossings(playerS: number, speed: number, dt: number, elapsed: number): boolean {
    let anyActive = false;
    for (const chunk of this.chunks.values()) {
      for (const crossing of chunk.crossings) {
        const distance = crossing.info.s - playerS;
        // Start closing about 25 seconds before arrival, reopen once clear.
        const closeAt = Math.max(280, Math.abs(speed) * 25);
        const active = distance < closeAt && distance > -55;
        const target = active ? 1 : 0;
        const rate = dt / 5.5;
        crossing.state += Math.sign(target - crossing.state) * Math.min(rate, Math.abs(target - crossing.state));

        // The arm lies along the line, across the carriageway, so it lifts by
        // turning about the track's lateral axis - not about the vertical one,
        // which would swing it sideways over the running line instead.
        for (const barrier of crossing.barriers) {
          const side = (barrier.userData.side as number) ?? 1;
          barrier.rotation.x = -side * Math.PI * 0.5 * (1 - crossing.state);
        }

        const flash = active && Math.sin(elapsed * 7.5) > 0;
        for (let i = 0; i < crossing.lamps.length; i++) {
          const on = active && (i % 2 === 0 ? flash : !flash);
          crossing.lamps[i].material = on ? SIGNAL_LAMP_MATERIALS.red : SIGNAL_LAMP_MATERIALS.off;
        }
        if (active && distance > -20) anyActive = true;
      }
    }
    return anyActive;
  }

  /** Switches on platform lamps, tunnel lights and window glow after dark. */
  updateNightLighting(nightFactor: number): void {
    setFacadeNight(clamp01(smoothstep(0.15, 0.75, nightFactor)) * 1.15);
  }

  /** Fog thickness modifier from the biomes the train is currently in. */
  hazeAt(s: number): number {
    return this.field.hazeAt(s);
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  dispose(): void {
    for (const chunk of this.chunks.values()) chunk.dispose();
    this.chunks.clear();
    this.tiles.dispose();
    this.sea.dispose();
  }
}
