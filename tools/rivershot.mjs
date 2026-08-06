/**
 * Screenshot the approach to, and the crossing of, the first river on a route.
 *
 * A river is the one piece of the landscape that has to agree with three other
 * systems at once - the terrain it cut its valley into, the bridge that spans
 * it and the water surface drawn on the bed - so it is worth being able to
 * look at one on demand rather than waiting for the scenario matrix to happen
 * across a crossing.
 *
 *   npm run build && npm run preview
 *   node tools/rivershot.mjs [seed] [outDir] [url]
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const seed = process.argv[2] ?? '4242';
const outDir = process.argv[3] ?? 'screenshots/river';
const base = process.argv[4] ?? 'http://127.0.0.1:4173/';
const url = `${base}?capture=1&seed=${seed}&time=11.5`;
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (error) => console.error('[page error]', error.message));

page.setDefaultNavigationTimeout(180000);
await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(10000);
await page.evaluate(() => document.querySelector('.overlay .button')?.click());
await page.waitForTimeout(4000);

const river = await page.evaluate(() => {
  const track = window.game.world.track;
  for (let s = 600; s < 120000; s += 400) {
    track.extendTo(s + 2000);
    // Take one wide enough to be worth looking at.
    const found = track.rivers.find((r) => r.s > 900 && r.width > 70);
    if (found) return { s: found.s, width: found.width, skew: found.skew };
  }
  return null;
});
console.log('river', JSON.stringify(river));
if (!river) {
  await browser.close();
  process.exit(1);
}

const shots = [
  ['approach', river.s - 300, 'cab'],
  ['bank', river.s - 90, 'chase'],
  ['over', river.s, 'chase'],
  ['side', river.s - 20, 'lineside'],
  ['above', river.s - 40, 'roof'],
];

for (const [name, s, mode] of shots) {
  await page.evaluate(
    ([pos, m]) => {
      const g = window.game;
      g.world.track.extendTo(pos + 2000);
      for (const st of g.world.track.stations) if (st.s < pos - 60) st.served = true;
      g.train.position = pos;
      g.train.speed = 0;
      g.train.applyFullBrake();
      g.journey.resetTo(pos);
      g.camera.setMode(m);
    },
    [s, mode],
  );
  await page.waitForTimeout(11000);
  const dataUrl = await page.evaluate(() => {
    const game = window.game;
    game.engine.stop();
    // Through the composer, so the frame carries the exposure and tone mapping
    // a player sees. A raw render is linear and unmetered, and reads every
    // shadow as black - which is not a landscape fault to go chasing.
    game.engine.composer.render(0.016);
    const png = document.getElementById('viewport').toDataURL('image/png');
    game.engine.start();
    return png;
  });
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', name);
}

await browser.close();
