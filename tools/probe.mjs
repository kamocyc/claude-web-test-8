/**
 * Scratch probe: drives the capture rig to a biome and reports numbers about
 * the world rather than a picture. Used while tuning the terrain.
 */
import { chromium } from 'playwright';

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:5204/';
const biome = process.argv[3] ?? 'farmland';
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
page.setDefaultNavigationTimeout(180000);
page.on('pageerror', (e) => console.log('ERR', e.message));
await page.goto(`${baseUrl}?capture=1&seed=4242&time=10.5`, { waitUntil: 'load' });
await page.waitForTimeout(9000);
await page.evaluate(() => document.querySelector('.overlay .button')?.click());
await page.waitForTimeout(6000);
await page.evaluate(() => { window.game.auto.enabled = true; });

for (let i = 0; i < 20; i++) {
  const here = await page.evaluate(() => window.game.world.track.biomeAt(window.game.train.position));
  if (here === biome) break;
  await page.evaluate(() => window.game.skipToNextBiome());
  await page.waitForTimeout(1500);
}
await page.evaluate(() => { window.game.auto.enabled = true; });
await page.waitForTimeout(12000);
await page.waitForTimeout(4000);

await page.evaluate(() => { window.game.camera.setMode('chase'); });
await page.waitForTimeout(8000);
const fs = await import('node:fs');
const shoot = async (tag, prep) => {
  await page.evaluate(prep);
  await page.waitForTimeout(2000);
  const png = await page.evaluate(() => {
    const g = window.game;
    g.engine.stop();
    g.engine.composer.render(1 / 60);
    const d = document.getElementById('viewport').toDataURL('image/png');
    g.engine.start();
    return d;
  });
  fs.writeFileSync(`shots/dbg/${tag}.png`, Buffer.from(png.split(',')[1], 'base64'));
};
await shoot('all', () => {});
await shoot('notiles', () => { window.game.world.tiles.group.visible = false; });
await shoot('nochunks', () => {
  const w = window.game.world;
  w.tiles.group.visible = true;
  w.group.children.find((c) => c.name === 'chunks').visible = false;
});
await shoot('nosea', () => {
  const w = window.game.world;
  w.group.children.find((c) => c.name === 'chunks').visible = true;
  w.sea.mesh.visible = false;
});
const out = await page.evaluate(() => {
  const g = window.game;
  const w = g.world;
  const s = g.train.position;
  const sm = w.track.at(w.track.sampleIndex(s));
  const depths = w.sea.mesh.geometry.getAttribute('aDepth').array;
  let wet = 0;
  let maxd = -99;
  for (let i = 0; i < depths.length; i++) { if (depths[i] > 0) wet++; if (depths[i] > maxd) maxd = depths[i]; }
  const heights = [];
  for (let dx = -400; dx <= 400; dx += 100)
    for (let dz = -400; dz <= 400; dz += 100)
      heights.push(+w.field.heightAt(sm.x + dx, sm.z + dz).y.toFixed(1));
  heights.sort((a, b) => a - b);
  const names = {};
  w.group.traverse((o) => { if (o.isMesh && o.visible) names[o.name || o.type] = (names[o.name || o.type] || 0) + 1; });
  return {
    s: Math.round(s), trackY: +sm.y.toFixed(1),
    coastW: +sm.weights[0].toFixed(3), seaSide: sm.seaSide,
    seaVisible: w.sea.mesh.visible, seaWetVerts: wet, seaMaxDepth: +maxd.toFixed(1),
    groundMin: heights[0], groundMed: heights[Math.floor(heights.length / 2)], groundMax: heights[heights.length - 1],
    tiles: w.tiles.tileCount,
    pending: w.tiles.pendingCount,
    sampleUs: (() => {
      const t0 = performance.now();
      let hint = -1;
      for (let i = 0; i < 4000; i++) {
        const r = w.field.heightAt(sm.x + (i % 64) * 4, sm.z + Math.floor(i / 64) * 4, hint);
        hint = r.projection.hint;
      }
      return +(((performance.now() - t0) / 4000) * 1000).toFixed(2);
    })(),
    tileMs: (() => {
      const out = [];
      for (let level = 0; level < 5; level++) {
        const t0 = performance.now();
        const m = w.tiles.buildTile(level, 900 + level, 900);
        out.push(+(performance.now() - t0).toFixed(2));
        m.geometry.dispose();
      }
      return out;
    })(),
    tris: g.engine.triangles,
    calls: g.engine.drawCalls,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
