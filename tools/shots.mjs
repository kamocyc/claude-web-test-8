/**
 * Scenario capture rig.
 *
 * Drives the game through a matrix of viewpoints, biomes, times of day and
 * weather, and writes one PNG per scenario. Unlike `screenshot.mjs` this goes
 * through the effect composer whenever the composer is actually producing a
 * picture, so what lands on disk is what a player sees - bloom, grade and all.
 *
 *   node tools/shots.mjs <outDir> [scenarioList] [url]
 *
 * `scenarioList` is a comma-separated set of scenario ids (see SCENARIOS);
 * `all` runs every one. Each scenario is a small script the page evaluates, so
 * adding a viewpoint is a one-line change here rather than a change to the game.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? 'shots';
const wanted = (process.argv[3] ?? 'all').split(',').map((s) => s.trim());
const baseUrl = process.argv[4] ?? 'http://127.0.0.1:4173/';
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * A scenario pins everything that makes a frame reproducible: the seed and
 * clock come from the query string, the rest is applied once the world is up.
 */
const SCENARIOS = [
  { id: 'cab-day', seed: 4242, time: 10.5, cam: 'cab', biome: null, weather: { cloudCover: 0.35, rain: 0 } },
  { id: 'cab-golden', seed: 4242, time: 17.4, cam: 'cab', biome: null, weather: { cloudCover: 0.45, rain: 0 } },
  { id: 'cab-night', seed: 4242, time: 21.0, cam: 'cab', biome: null, weather: { cloudCover: 0.3, rain: 0 } },
  { id: 'cab-rain', seed: 4242, time: 13.0, cam: 'cab', biome: null, weather: { cloudCover: 0.95, rain: 1 } },
  { id: 'chase-day', seed: 4242, time: 10.5, cam: 'chase', biome: null, weather: { cloudCover: 0.35, rain: 0 } },
  { id: 'chase-golden', seed: 771, time: 17.4, cam: 'chase', biome: null, weather: { cloudCover: 0.4, rain: 0 } },
  { id: 'lineside-day', seed: 4242, time: 10.5, cam: 'lineside', biome: null, weather: { cloudCover: 0.35, rain: 0 } },
  { id: 'nose-day', seed: 4242, time: 10.5, cam: 'nose', biome: null, weather: { cloudCover: 0.35, rain: 0 } },
  { id: 'window-day', seed: 4242, time: 10.5, cam: 'window', biome: null, weather: { cloudCover: 0.35, rain: 0 } },
  { id: 'roof-day', seed: 4242, time: 10.5, cam: 'roof', biome: null, weather: { cloudCover: 0.35, rain: 0 } },
  { id: 'coast', seed: 4242, time: 15.0, cam: 'chase', biome: 'coast', weather: { cloudCover: 0.3, rain: 0 } },
  { id: 'mountain', seed: 4242, time: 11.0, cam: 'chase', biome: 'mountain', weather: { cloudCover: 0.4, rain: 0 } },
  { id: 'city', seed: 4242, time: 18.6, cam: 'chase', biome: 'city', weather: { cloudCover: 0.4, rain: 0 } },
  { id: 'farmland', seed: 4242, time: 9.0, cam: 'chase', biome: 'farmland', weather: { cloudCover: 0.25, rain: 0 } },
  { id: 'forest', seed: 4242, time: 12.0, cam: 'chase', biome: 'forest', weather: { cloudCover: 0.4, rain: 0 } },
  { id: 'station', seed: 4242, time: 10.5, cam: 'lineside', biome: null, station: true, weather: { cloudCover: 0.3, rain: 0 } },
];

const scenarios = wanted.includes('all')
  ? SCENARIOS
  : SCENARIOS.filter((s) => wanted.includes(s.id));
if (!scenarios.length) {
  console.error('no matching scenarios; known ids:', SCENARIOS.map((s) => s.id).join(','));
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const errors = [];
const stats = {};

for (const sc of scenarios) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => errors.push(`[${sc.id}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${sc.id}] console: ${m.text()}`);
  });

  const url = `${baseUrl}?capture=1&seed=${sc.seed}&time=${sc.time}`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(9000);
  await page.evaluate(() => document.querySelector('.overlay .button')?.click());
  await page.waitForTimeout(6000);

  // Run the train up to line speed under the ATO so the shot is of a service in
  // motion rather than a stationary train in a half-built world.
  await page.evaluate(() => {
    window.game.auto.enabled = true;
  });

  if (sc.biome) {
    // `B` runs the service on to the next change of landscape; hop along the
    // line until the wanted country turns up, then let the world rebuild.
    for (let i = 0; i < 20; i++) {
      const here = await page.evaluate(
        () => window.game.world.track.biomeAt(window.game.train.position),
      );
      if (here === sc.biome) break;
      await page.evaluate(() => window.game.skipToNextBiome());
      await page.waitForTimeout(1200);
    }
    await page.evaluate(() => {
      window.game.auto.enabled = true;
    });
    await page.waitForTimeout(11000);
  }
  if (sc.station) {
    // Park the shot just short of the next platform so the station itself is
    // in frame rather than open line.
    await page.evaluate(() => {
      const g = window.game;
      const next = g.world.track.stations.find((st) => st.s > g.train.position + 200);
      if (next) {
        g.train.position = next.s - 130;
        g.train.speed = 0;
        g.journey.resetTo(g.train.position);
      }
    });
    await page.waitForTimeout(9000);
  }

  await page.evaluate(
    ([cam, weather]) => {
      window.game.camera.setMode(cam);
      window.game.sky.setWeather(weather);
    },
    [sc.cam, sc.weather],
  );
  await page.waitForTimeout(9000);

  const shot = await page.evaluate(() => {
    const game = window.game;
    // Read the frame cost before stopping: the extra composer render below
    // resets the renderer's counters to the cost of a single full-screen quad.
    const cost = { tris: game.engine.triangles, calls: game.engine.drawCalls };
    game.engine.stop();
    const renderer = game.engine.renderer;
    const canvas = document.getElementById('viewport');
    // Prefer the composer: it carries tone mapping, bloom and the grade. On a
    // driver where the composer only ever returns black the watchdog has
    // already bypassed it, and a direct render is the honest fallback.
    let used = 'composer';
    if (game.engine.postProcessing === 'off') {
      used = 'direct';
      renderer.setRenderTarget(null);
      renderer.render(game.engine.scene, game.engine.camera);
    } else {
      game.engine.composer.render(1 / 60);
      const gl = renderer.getContext();
      const probe = new Uint8Array(4 * 4 * 4);
      gl.readPixels(
        Math.floor(canvas.width / 2) - 2,
        Math.floor(canvas.height / 2) - 2,
        4, 4, gl.RGBA, gl.UNSIGNED_BYTE, probe,
      );
      let sum = 0;
      for (const v of probe) sum += v;
      if (sum === 0) {
        used = 'direct-fallback';
        renderer.setRenderTarget(null);
        renderer.render(game.engine.scene, game.engine.camera);
      }
    }
    const png = canvas.toDataURL('image/png');
    game.engine.start();
    return {
      png,
      used,
      fps: +game.engine.fps.toFixed(1),
      tris: cost.tris,
      calls: cost.calls,
      biome: game.world.track.biomeAt(game.train.position),
      speed: +game.train.speedKmh.toFixed(1),
    };
  });

  writeFileSync(join(outDir, `${sc.id}.png`), Buffer.from(shot.png.split(',')[1], 'base64'));
  stats[sc.id] = { path: sc.id, used: shot.used, fps: shot.fps, tris: shot.tris, calls: shot.calls, biome: shot.biome, speed: shot.speed };
  console.log(`wrote ${sc.id}.png  via=${shot.used} fps=${shot.fps} tris=${shot.tris} calls=${shot.calls} biome=${shot.biome} v=${shot.speed}`);
  await page.close();
}

writeFileSync(join(outDir, 'stats.json'), JSON.stringify(stats, null, 2));
if (errors.length) {
  console.error('--- page errors ---');
  for (const e of [...new Set(errors)].slice(0, 40)) console.error(e);
}
await browser.close();
console.log(errors.length ? `DONE with ${errors.length} page errors` : 'DONE clean');
