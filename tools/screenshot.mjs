/**
 * Headless screenshot tool.
 *
 *   npm run build && npm run preview
 *   node tools/screenshot.mjs [url] [modes] [outDir]
 *
 * Loads the game with `?capture=1` (which pins the drawing buffer and turns off
 * dynamic resolution), starts the service, then grabs one frame per camera
 * mode straight out of the WebGL buffer - an ordinary page screenshot races the
 * compositor and frequently comes back empty.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:4173/?capture=1&seed=4242&time=10.5';
const modes = (process.argv[3] ?? 'cab,chase,lineside,nose').split(',');
const outDir = process.argv[4] ?? 'screenshots';
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

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

const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (error) => console.error('[page error]', error.message));

await page.goto(url.includes('capture=') ? url : `${url}${url.includes('?') ? '&' : '?'}capture=1`, {
  waitUntil: 'load',
});
// Let the first chunks and terrain tiles build.
await page.waitForTimeout(12000);
await page.evaluate(() => document.querySelector('.overlay .button')?.click());
await page.waitForTimeout(16000);

for (const mode of modes) {
  await page.evaluate((m) => window.game.camera.setMode(m), mode);
  await page.waitForTimeout(6000);
  const dataUrl = await page.evaluate(() => {
    const game = window.game;
    game.engine.stop();
    // Straight to the canvas: on software GL the watchdog usually has the post
    // chain bypassed by now, and calling the composer then returns a black
    // frame.
    game.engine.renderer.setRenderTarget(null);
    game.engine.renderer.render(game.engine.scene, game.engine.camera);
    const png = document.getElementById('viewport').toDataURL('image/png');
    game.engine.start();
    return png;
  });
  const file = join(outDir, `${mode}.png`);
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('wrote', file);
}

await page.screenshot({ path: join(outDir, 'hud.png') });
console.log(
  'stats',
  await page.evaluate(() =>
    JSON.stringify({
      fps: +window.game.engine.fps.toFixed(1),
      chunks: window.game.world.chunkCount,
      tiles: window.game.world.tiles.tileCount,
    }),
  ),
);
await browser.close();
