/**
 * Reports any part of a model that reaches outside the body it belongs to.
 *
 *   npm run dev
 *   node tools/overhang.mjs [subject] [halfWidth]
 *
 * A stack of transformed primitives hides this class of mistake completely: a
 * quarter turn applied to a prefab whose origin is at one end swings the whole
 * part out sideways, and the result reads as a perfectly ordinary model until
 * something pokes through the side of the train. Scanning the built vertices
 * finds it in a second; looking for it in renders takes an afternoon.
 */

import { chromium } from 'playwright';

const subject = process.argv[2] ?? 'cab-car';
const limit = Number(process.argv[3] ?? 1.476);
const baseUrl = process.argv[4] ?? 'http://127.0.0.1:5173/tools/model.html';
const executablePath =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));

await page.goto(`${baseUrl}?subject=${subject}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.stageReady === true, null, { timeout: 60000 });

const rows = await page.evaluate((l) => window.stage.overhang(l), limit);
if (rows.length === 0) console.log(`${subject}: nothing wider than ${limit} m`);
else {
  console.log(`${subject}: reaching wider than ${limit} m, worst first`);
  for (const row of rows) console.log(' ', row);
}
await browser.close();
