/**
 * Headless smoke test: starts the service, exercises the new controls and
 * reports whether anything threw. Run against `npm run preview`.
 */

import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/?capture=1&seed=4242&time=10.5';
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});

const key = (code, shift = false) =>
  page.evaluate(
    ([c, s]) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, shiftKey: s })),
    [code, shift],
  );
const state = () =>
  page.evaluate(() => {
    const g = window.game;
    return {
      s: Math.round(g.train.position),
      v: +g.train.speedKmh.toFixed(1),
      p: g.train.powerNotch,
      b: g.train.brakeNotch,
      rev: g.train.reverser,
      auto: g.auto.enabled,
      cam: g.camera.mode,
      biome: g.world.track.biomeAt(g.train.position),
      hud: getComputedStyle(document.getElementById('hud')).display,
      lang: document.querySelector('.score-row__label')?.textContent,
      running: g.running,
    };
  });

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(11000);
await page.evaluate(() => document.querySelector('.overlay .button')?.click());
await page.waitForTimeout(3000);

console.log('start          ', JSON.stringify(await state()));

await key('KeyJ'); // Japanese
await page.waitForTimeout(600);
console.log('after J (lang) ', JSON.stringify(await state()));

// Brake release must not disturb the master controller.
await key('KeyZ');
await key('KeyZ');
await page.waitForTimeout(3000);
const withPower = await state();
await key('Comma');
await key('Comma');
await page.waitForTimeout(3000);
const afterRelease = await state();
console.log('power then brake release:', JSON.stringify({ withPower, afterRelease }));

await key('KeyF'); // automatic driving
await page.waitForTimeout(20000);
console.log('auto 20s       ', JSON.stringify(await state()));

await key('KeyC'); // cab -> window
await page.waitForTimeout(2500);
console.log('after C        ', JSON.stringify(await state()));

await key('KeyU'); // hide the display
await page.waitForTimeout(1200);
console.log('after U        ', JSON.stringify(await state()));
await key('KeyU');

await key('KeyB'); // skip to the next landscape
await page.waitForTimeout(12000);
console.log('after B        ', JSON.stringify(await state()));

await key('ArrowDown'); // reverser (should be refused while moving)
await page.waitForTimeout(800);
console.log('after Down     ', JSON.stringify(await state()));

console.log('errors:', errors.slice(0, 8));
await browser.close();
