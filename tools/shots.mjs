/**
 * Scenario screenshot tool.
 *
 *   npx vite --port 5201 --host 127.0.0.1 &
 *   SHOT_W=960 SHOT_H=540 node tools/shots.mjs ./shots cab-day,chase-golden http://127.0.0.1:5201/
 *
 * Unlike tools/screenshot.mjs this renders through the EffectComposer, so the
 * whole post chain is visible in the capture. Each scenario pins a camera, a
 * time of day, a weather preset and optionally a biome.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? './shots';
const ids = (process.argv[3] ?? 'cab-day').split(',').filter(Boolean);
const baseUrl = process.argv[4] ?? 'http://127.0.0.1:5201/';
const W = Number(process.env.SHOT_W ?? 960);
const H = Number(process.env.SHOT_H ?? 540);
const SEED = process.env.SHOT_SEED ?? '4242';
const QUALITY = process.env.SHOT_QUALITY ?? 'high';
const executablePath =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

// weather index: 0 clear, 1 fair, 2 overcast, 3 rain
const SCENARIOS = {
  'cab-day': { mode: 'cab', time: 10.5, weather: 1 },
  'cab-golden': { mode: 'cab', time: 17.6, weather: 0 },
  'cab-night': { mode: 'cab', time: 21.5, weather: 0 },
  'cab-rain': { mode: 'cab', time: 13.0, weather: 3 },
  'cab-overcast': { mode: 'cab', time: 12.0, weather: 2 },
  'chase-day': { mode: 'chase', time: 10.5, weather: 1 },
  'chase-golden': { mode: 'chase', time: 17.6, weather: 0 },
  'chase-night': { mode: 'chase', time: 21.5, weather: 0 },
  'lineside-day': { mode: 'lineside', time: 10.0, weather: 1 },
  'lineside-golden': { mode: 'lineside', time: 17.7, weather: 0 },
  'nose-day': { mode: 'nose', time: 9.5, weather: 1 },
  'roof-day': { mode: 'roof', time: 10.5, weather: 1 },
  city: { mode: 'chase', time: 16.0, weather: 1, biome: 'city' },
  forest: { mode: 'cab', time: 9.0, weather: 1, biome: 'forest' },
  coast: { mode: 'lineside', time: 17.2, weather: 0, biome: 'coast' },
  mountain: { mode: 'chase', time: 8.5, weather: 1, biome: 'mountain' },
  station: { mode: 'lineside', time: 11.0, weather: 1, station: true },
};

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
});

for (const id of ids) {
  const scn = SCENARIOS[id];
  if (!scn) {
    console.error('unknown scenario', id);
    continue;
  }
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.error('[page]', m.text());
  });

  const url =
    `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}capture=1&seed=${SEED}` +
    `&time=${scn.time}&quality=${QUALITY}`;
  // The software rasteriser takes a long time to compile the post chain, which
  // can hold the load event back well past a default timeout.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForTimeout(12000);
  await page.evaluate(() => document.querySelector('.overlay .button')?.click());

  await page.evaluate((s) => {
    const g = window.game;
    if (s.weather !== undefined) {
      g.weatherIndex = s.weather;
      g.applyWeather();
    }
    if (s.biome) {
      for (let i = 0; i < 24; i++) {
        if (g.world.track.biomeAt(g.train.position) === s.biome) break;
        g.skipToNextBiome();
      }
    }
    if (s.station) {
      const st = g.world.track.stations.find((x) => x.s > g.train.position + 200);
      if (st) {
        g.train.position = st.s - 90;
        g.train.speed = 0;
        g.journey.resetTo(g.train.position);
      }
    }
    g.camera.setMode(s.mode);
  }, scn);

  // Let the world stream in around the new position and the camera settle.
  await page.waitForTimeout(22000);

  const result = await page.evaluate(() => {
    const game = window.game;
    game.engine.stop();
    // The renderer resets its counters at the start of every render call, and
    // the last thing the composer draws is a fullscreen quad, so the scene has
    // to be measured on its own.
    const renderer = game.engine.renderer;
    renderer.info.autoReset = false;
    renderer.info.reset();
    renderer.setRenderTarget(null);
    renderer.render(game.engine.scene, game.engine.camera);
    const calls = renderer.info.render.calls;
    const tris = renderer.info.render.triangles;
    renderer.info.autoReset = true;
    game.engine.composer.render(0.016);
    const png = document.getElementById('viewport').toDataURL('image/png');
    return {
      png,
      post: game.engine.postProcessing,
      calls,
      tris,
      fps: +game.engine.fps.toFixed(1),
      biome: game.world.track.biomeAt(game.train.position),
      quality: game.settings.quality,
    };
  });

  const file = join(outDir, `${id}.png`);
  writeFileSync(file, Buffer.from(result.png.split(',')[1], 'base64'));
  console.log(
    `wrote ${file}  post=${result.post} calls=${result.calls} tris=${(result.tris / 1000).toFixed(0)}k biome=${result.biome} q=${result.quality} fps=${result.fps}`,
  );
  await page.close();
}

await browser.close();
