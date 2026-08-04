/**
 * Ad-hoc scene probe. Loads the game and evaluates an expression against it,
 * which is much faster than rendering a frame on the software rasteriser when
 * all you want to know is what state something is in.
 *
 *   node tools/probe.mjs "expr" [url]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const expr = process.argv[2] ?? '1';
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:5201/';
const time = process.env.PROBE_TIME ?? '17.6';
const executablePath =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({
  viewport: { width: Number(process.env.PROBE_W ?? 480), height: Number(process.env.PROBE_H ?? 270) },
});
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(
  `${baseUrl}?capture=1&seed=4242&time=${time}&quality=${process.env.PROBE_QUALITY ?? 'high'}`,
  {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  },
);
await page.waitForTimeout(12000);
await page.evaluate(() => document.querySelector('.overlay .button')?.click());
await page.waitForTimeout(8000);
const mode = process.env.PROBE_MODE;
const shot = process.env.PROBE_SHOT;
if (mode) await page.evaluate((m) => window.game.camera.setMode(m), mode);
if (mode) await page.waitForTimeout(6000);

const result = await page.evaluate(
  (source) => JSON.stringify(new Function('game', `return (${source});`)(window.game), null, 1),
  expr,
);
console.log(result);

if (shot) {
  const png = await page.evaluate(() => {
    const game = window.game;
    game.engine.stop();
    game.engine.composer.render(0.016);
    return document.getElementById('viewport').toDataURL('image/png');
  });
  mkdirSync('probe-shots', { recursive: true });
  writeFileSync(`probe-shots/${shot}.png`, Buffer.from(png.split(',')[1], 'base64'));
  console.log('wrote', `probe-shots/${shot}.png`);
}
await browser.close();
