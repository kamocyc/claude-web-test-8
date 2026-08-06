/**
 * Checks that free look never rolls the horizon.
 *
 *   npm run dev
 *   node tools/camroll.mjs [url]
 *
 * Turning the camera about its own axes tips the frame as soon as the shot
 * carries any pitch, and the tilt creeps in far enough from the centre of the
 * view that it is easy to miss in a still. Measuring the roll directly, at a
 * spread of yaw and pitch in every mode, is not: the number has to stay put.
 * What remains in the cab views is the cant the car is really leaning at.
 */

import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:5173/?capture=1&seed=4242&time=10.5';
const executablePath =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(9000);
await page.evaluate(() => document.querySelector('.overlay .button')?.click());
await page.waitForTimeout(8000);

let worst = 0;
for (const mode of ['cab', 'window', 'chase', 'lineside', 'nose', 'roof']) {
  const byPitch = [];
  for (const pitch of [-0.5, 0, 0.5]) {
    const rolls = [];
    for (const yaw of [-1.2, -0.6, 0, 0.6, 1.2]) {
      const y = await page.evaluate(
        async ([m, a, b]) => {
          const camera = window.game.camera;
          camera.setMode(m);
          camera.shake = 0;
          camera.yaw = a;
          camera.pitch = b;
          await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
          const c = window.game.engine.camera;
          c.updateMatrixWorld(true);
          return new window.THREE.Vector3().setFromMatrixColumn(c.matrixWorld, 0).y;
        },
        [mode, yaw, pitch],
      );
      rolls.push((Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI);
    }
    byPitch.push(rolls);
  }
  // Turning the head must not change the tilt: the spread across yaw, at a
  // fixed pitch, is the bug. What is left is the cant the car is leaning at,
  // which is real, and the fraction of it that a head tipped up or down sees
  // differently - a couple of tenths of a degree, and also real.
  const spread = Math.max(...byPitch.map((r) => Math.max(...r) - Math.min(...r)));
  worst = Math.max(worst, spread);
  console.log(
    `${mode.padEnd(9)} cant ${byPitch[1][2].toFixed(2)}deg  spread across yaw ${spread.toFixed(3)}deg`,
  );
}
console.log(worst < 0.05 ? 'ok: the horizon holds still' : `FAILED: rolls by ${worst.toFixed(2)}deg`);
await browser.close();
process.exit(worst < 0.05 ? 0 : 1);
