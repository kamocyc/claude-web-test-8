/**
 * Photographs one model on the turntable (`tools/model.html`).
 *
 *   npm run dev
 *   node tools/modelshot.mjs <subject> [outDir] [url]
 *
 * `subject` is one of car, cab-car, station, crossing, buildings. Several
 * views are taken of each so a shape can be judged in the round rather than
 * from the one angle that happens to flatter it - which is the whole point of
 * having a stage separate from the game.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const subject = process.argv[2] ?? 'car';
const outDir = process.argv[3] ?? 'modelshots';
const baseUrl = process.argv[4] ?? 'http://127.0.0.1:5173/tools/model.html';
const executablePath =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/** azimuth, elevation, distance scale, target height, target along the line, label. */
const VIEWS = {
  car: [
    [2.5, 0.16, 1.0, 2.0, 0, 'three-quarter-front'],
    [Math.PI / 2, 0.08, 1.0, 2.0, 0, 'side'],
    [Math.PI, 0.12, 0.8, 2.0, 0, 'front'],
    [0, 0.12, 0.8, 2.0, 0, 'rear'],
    [2.5, 0.62, 1.0, 2.0, 0, 'above'],
    [1.9, 0.03, 0.26, 0.9, 7.0, 'bogie'],
    [2.2, 0.12, 0.30, 2.3, -8.2, 'cab-end'],
    [1.55, 0.08, 0.26, 2.4, -8.6, 'cab-side'],
    [2.2, 0.3, 0.28, 3.6, 5.6, 'pantograph'],
  ],
  station: [
    [2.4, 0.2, 1.0, 3.0, 0, 'three-quarter'],
    [Math.PI / 2, 0.1, 1.0, 3.0, 0, 'side'],
    [2.4, 0.55, 1.6, 3.0, 0, 'above'],
    [1.9, 0.06, 0.4, 2.5, 12, 'platform-close'],
  ],
  crossing: [
    [2.4, 0.16, 1.0, 2.5, 0, 'three-quarter'],
    [Math.PI / 2, 0.08, 0.8, 2.0, 0, 'along-the-road'],
    [2.4, 0.5, 1.3, 2.0, 0, 'above'],
    [3.0, 0.05, 0.3, 2.6, 0, 'warning-device'],
  ],
  buildings: [
    [2.4, 0.24, 1.0, 8.0, 0, 'three-quarter'],
    [2.4, 0.6, 1.3, 6.0, 0, 'above'],
    [2.3, 0.1, 0.3, 5.0, 0, 'street'],
  ],
};

/** yaw, pitch, label - first person views taken from the driver's eye. */
const EYE_VIEWS = [
  [0, 0, 'ahead'],
  [0, -0.32, 'desk'],
  [0.55, -0.05, 'left'],
  [-0.55, -0.05, 'right'],
  [1.4, -0.1, 'left-window'],
  [-1.4, -0.1, 'right-window'],
  [0, 0.3, 'up'],
];

const views = VIEWS[subject] ?? VIEWS.car;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.error('[console]', m.text());
});

await page.goto(`${baseUrl}?subject=${subject}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.stageReady === true, null, { timeout: 60000 });
await page.waitForTimeout(1500);

if (subject === 'cab') {
  for (const [yaw, pitch, label] of EYE_VIEWS) {
    const dataUrl = await page.evaluate(
      ([y, p]) => {
        window.stage.renderEye(y, p, [0, 0, 0]);
        return document.querySelector('canvas').toDataURL('image/png');
      },
      [yaw, pitch],
    );
    const file = join(outDir, `cab-${label}.png`);
    writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote', file);
  }
  await browser.close();
  process.exit(0);
}

for (const [azimuth, elevation, scale, height, along, label] of views) {
  const dataUrl = await page.evaluate(
    ([a, e, s, h, z]) => {
      const base = window.__radius ?? 0;
      window.stage.render(a, e, base * s, [0, h, z]);
      return document.querySelector('canvas').toDataURL('image/png');
    },
    [azimuth, elevation, scale, height, along],
  );
  const file = join(outDir, `${subject}-${label}.png`);
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', file);
}

await browser.close();
