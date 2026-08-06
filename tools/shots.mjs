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
// Rendering here is on a software rasteriser, so a smaller frame is the
// difference between a usable iteration loop and a two-minute wait. SHOT_SCALE
// also shortens the settle times, for a quick look while working.
const shotW = +(process.env.SHOT_W ?? 1280);
const shotH = +(process.env.SHOT_H ?? 720);
const settle = +(process.env.SHOT_SETTLE ?? 1);
const wait = (ms) => Math.max(600, Math.round(ms * settle));

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
  // The coast is the one landscape whose whole point is off to one side, so a
  // camera pointed down the train never sees it. This one turns to face the
  // water - which is how the sea being invisible went unnoticed for so long.
  { id: 'coast-sea', seed: 4242, time: 15.0, cam: 'roof', biome: 'coast', seaward: true,
    weather: { cloudCover: 0.3, rain: 0 } },
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

const failed = [];

const ATTEMPTS = +(process.env.SHOT_ATTEMPTS ?? 3);

for (const sc of scenarios) {
  let ok = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !ok; attempt++) {
  const page = await browser.newPage({ viewport: { width: shotW, height: shotH } });
  page.on('pageerror', (e) => errors.push(`[${sc.id}] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${sc.id}] console: ${m.text()}`);
  });

  try {
  const url = `${baseUrl}?capture=1&seed=${sc.seed}&time=${sc.time}`;
  // Several of these runs happen while the box is busy compiling and rendering
  // for somebody else, and a cold page load can take well over the default
  // 30s. A slow machine is not a reason to throw away the whole matrix.
  await page.goto(url, { waitUntil: 'load', timeout: 180_000 });
  await page.waitForTimeout(wait(9000));
  await page.evaluate(() => document.querySelector('.overlay .button')?.click());
  await page.waitForTimeout(wait(6000));

  // Run the train up to line speed under the ATO so the shot is of a service in
  // motion rather than a stationary train in a half-built world.
  await page.evaluate(() => {
    window.game.auto.enabled = true;
  });

  if (sc.biome) {
    // Hopping landscape to landscape with `B` is a random walk over the biome
    // transition chain, and some country simply never comes up inside a
    // sensible number of hops - the city shot spent twenty of them in forest.
    // The alignment can be read ahead of the train instead: extend the route
    // and scan it for the country we actually want, then go straight there.
    const found = await page.evaluate((target) => {
      const track = window.game.world.track;
      const start = window.game.train.position;
      // Forest and mountain reinforce each other strongly and only leak into
      // suburb (and thence city) at low weight, so the walk can stay in the
      // hills for a very long way. Scan far enough that the rarer country is
      // still reachable rather than silently shooting the wrong landscape.
      for (let s = start + 600; s < start + 400_000; s += 250) {
        track.extendTo(s + 1500);
        if (track.biomeAt(s) === target) {
          // Land a little way in so the shot is unmistakably that landscape
          // rather than the tail of the cross-fade into it.
          const at = s + 700;
          track.extendTo(at + 2000);
          return at;
        }
      }
      return null;
    }, sc.biome);

    if (found === null) {
      console.error(`  ${sc.id}: no ${sc.biome} within 160km of the start`);
    } else {
      await page.evaluate((at) => {
        const g = window.game;
        // Everything skipped counts as worked and the timetable moves with us,
        // the same bargain the in-game skip makes.
        for (const st of g.world.track.stations) if (st.s < at - 60) st.served = true;
        g.world.track.shiftSchedule((at - g.train.position) / (70 / 3.6));
        g.train.position = at;
        g.train.speed = 0;
        g.journey.resetTo(at);
        g.auto.enabled = true;
      }, found);
      // The world streams in chunks, so give it time to build the new country.
      await page.waitForTimeout(wait(14000));
    }
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
    await page.waitForTimeout(wait(9000));
  }

  await page.evaluate(
    ([cam, weather, seaward]) => {
      window.game.camera.setMode(cam);
      window.game.sky.setWeather(weather);
      if (seaward) {
        // Whichever side the water is on here, look at it.
        const side = window.game.world.track.sampleAt(window.game.train.position).seaSide || -1;
        window.game.camera.look(side * -1.25, -0.12);
      }
    },
    [sc.cam, sc.weather, !!sc.seaward],
  );
  await page.waitForTimeout(wait(9000));

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
    const gl = renderer.getContext();
    // Judge the whole frame, not four pixels in the middle of it. A lost
    // context or a driver that quietly fails a render target gives back an
    // image that is black everywhere, and a centre probe on a night shot
    // cannot tell that apart from a legitimately dark sky.
    const survey = () => {
      const w = canvas.width;
      const h = canvas.height;
      const step = 16;
      const cols = Math.max(2, Math.floor(w / step));
      const rows = Math.max(2, Math.floor(h / step));
      const row = new Uint8Array(cols * 4);
      let max = 0;
      let sum = 0;
      let n = 0;
      let distinct = new Set();
      for (let r = 0; r < rows; r++) {
        const y = Math.min(h - 1, r * step);
        gl.readPixels(0, y, cols, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
        for (let i = 0; i < cols; i++) {
          const lum = 0.2126 * row[i * 4] + 0.7152 * row[i * 4 + 1] + 0.0722 * row[i * 4 + 2];
          if (lum > max) max = lum;
          sum += lum;
          n++;
          if (distinct.size < 40) distinct.add(`${row[i * 4] >> 3},${row[i * 4 + 1] >> 3},${row[i * 4 + 2] >> 3}`);
        }
      }
      return { max, mean: sum / Math.max(1, n), distinct: distinct.size };
    };

    let used = 'composer';
    if (game.engine.postProcessing === 'off') {
      used = 'direct';
      renderer.setRenderTarget(null);
      renderer.render(game.engine.scene, game.engine.camera);
    } else {
      game.engine.composer.render(1 / 60);
      if (survey().max < 4) {
        used = 'direct-fallback';
        renderer.setRenderTarget(null);
        renderer.render(game.engine.scene, game.engine.camera);
      }
    }
    const frame = survey();
    const png = canvas.toDataURL('image/png');
    game.engine.start();
    return {
      png,
      used,
      frame,
      contextLost: renderer.getContext().isContextLost(),
      fps: +game.engine.fps.toFixed(1),
      tris: cost.tris,
      calls: cost.calls,
      biome: game.world.track.biomeAt(game.train.position),
      speed: +game.train.speedKmh.toFixed(1),
    };
  });

  // A frame with no light anywhere in it, or one flat colour across the whole
  // survey, is a dead render - a lost context or a failed target, not a dark
  // night. Writing it would quietly poison every comparison made against this
  // directory afterwards, so refuse it and let the caller retry.
  const dead =
    shot.contextLost || shot.frame.max < 4 || (shot.frame.distinct <= 2 && shot.frame.mean < 2);
  if (dead) {
    throw new Error(
      `dead frame (max luma ${shot.frame.max.toFixed(1)}, mean ${shot.frame.mean.toFixed(1)}, ` +
        `${shot.frame.distinct} distinct colours, contextLost=${shot.contextLost})`,
    );
  }

  writeFileSync(join(outDir, `${sc.id}.png`), Buffer.from(shot.png.split(',')[1], 'base64'));
  stats[sc.id] = {
    path: sc.id, used: shot.used, fps: shot.fps, tris: shot.tris, calls: shot.calls,
    biome: shot.biome, speed: shot.speed,
    maxLuma: +shot.frame.max.toFixed(1), meanLuma: +shot.frame.mean.toFixed(1),
  };
  console.log(
    `wrote ${sc.id}.png  via=${shot.used} luma=${shot.frame.max.toFixed(0)}/${shot.frame.mean.toFixed(0)} ` +
      `tris=${shot.tris} calls=${shot.calls} biome=${shot.biome} v=${shot.speed}`,
  );
  ok = true;
  } catch (e) {
    console.error(`  ${sc.id} attempt ${attempt}/${ATTEMPTS} failed: ${e.message?.split('\n')[0] ?? e}`);
  }
  await page.close();
  if (ok) break;
  }

  // One scenario going wrong should cost us that scenario, not the fifteen
  // that come after it - but it must be reported, never silently skipped.
  if (!ok) {
    failed.push(sc.id);
    console.error(`FAILED ${sc.id} after ${ATTEMPTS} attempts`);
  }
}

writeFileSync(join(outDir, 'stats.json'), JSON.stringify(stats, null, 2));
if (errors.length) {
  console.error('--- page errors ---');
  for (const e of [...new Set(errors)].slice(0, 40)) console.error(e);
}
await browser.close();
if (failed.length) console.error(`missing scenarios: ${failed.join(',')}`);
console.log(
  `DONE ${Object.keys(stats).length}/${scenarios.length} captured` +
    (errors.length ? `, ${errors.length} page errors` : ', no page errors'),
);
process.exit(failed.length ? 1 : 0);
