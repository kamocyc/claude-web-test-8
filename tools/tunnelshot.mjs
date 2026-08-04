/**
 * Screenshot the approach to, and the inside of, the first tunnel on a route.
 *
 *   npm run build && npm run preview
 *   node tools/tunnelshot.mjs [seed] [outDir]
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const seed = process.argv[2] ?? '4242';
const outDir = process.argv[3] ?? 'screenshots/tunnel';
const url = `http://127.0.0.1:5204/?capture=1&seed=${seed}&time=11.5`;
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

// Find the first tunnel on the route.
const tunnel = await page.evaluate(() => {
  const track = window.game.world.track;
  for (let s = 600; s < 60000; s += 400) {
    track.extendTo(s + 1500);
    if (track.tunnels.length) break;
  }
  const t = track.tunnels[0];
  return t ? { sStart: t.sStart, sEnd: t.sEnd } : null;
});
console.log('tunnel', JSON.stringify(tunnel));
if (!tunnel) {
  await browser.close();
  process.exit(1);
}

const shots = [
  ['approach', tunnel.sStart - 120, 'cab'],
  ['mouth', tunnel.sStart - 25, 'cab'],
  ['inside', tunnel.sStart + 45, 'cab'],
  ['deep', (tunnel.sStart + tunnel.sEnd) * 0.5, 'cab'],
  ['exit', tunnel.sEnd - 60, 'cab'],
  ['outside', tunnel.sStart - 90, 'lineside'],
  ['above', tunnel.sStart + 60, 'chase'],
];

for (const [name, s, mode] of shots) {
  await page.evaluate(
    ([pos, m]) => {
      const g = window.game;
      g.world.track.extendTo(pos + 1500);
      g.train.position = pos;
      g.train.speed = 0;
      g.train.applyFullBrake();
      g.journey.resetTo(pos);
      g.camera.setMode(m);
    },
    [s, mode],
  );
  await page.waitForTimeout(9000);
  const dataUrl = await page.evaluate(() => {
    const game = window.game;
    game.engine.stop();
    // Straight to the canvas: on software GL the post chain is often bypassed
    // by the watchdog, and calling the composer then yields a black frame.
    game.engine.renderer.setRenderTarget(null);
    game.engine.renderer.render(game.engine.scene, game.engine.camera);
    const png = document.getElementById('viewport').toDataURL('image/png');
    game.engine.start();
    return png;
  });
  const file = join(outDir, `${name}.png`);
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', file, 's=', Math.round(s));
}

await browser.close();
