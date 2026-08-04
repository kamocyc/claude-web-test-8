import { chromium } from 'playwright';
const exe = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));

const wanted = process.argv[2] ?? 'city';
const seeds = (process.argv[3] ?? '4242,771,1,7,99,1234,5150,8888,31337,2024').split(',');

for (const seed of seeds) {
  await page.goto(`http://127.0.0.1:4173/?capture=1&seed=${seed}&time=10.5`, {
    waitUntil: 'load',
    timeout: 180000,
  });
  await page.waitForTimeout(6000);
  const r = await page.evaluate((target) => {
    const track = window.game?.world?.track;
    if (!track) return { err: 'no track' };
    const hits = {};
    let firstTarget = null;
    for (let s = 400; s < 200_000; s += 400) {
      track.extendTo(s + 1200);
      const b = track.biomeAt(s);
      hits[b] = (hits[b] ?? 0) + 1;
      if (b === target && firstTarget === null) firstTarget = s;
    }
    return { firstTarget, hits };
  }, wanted);
  console.log(seed, JSON.stringify(r));
}
await browser.close();
