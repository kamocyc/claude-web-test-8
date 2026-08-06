/**
 * Ground contact audit.
 *
 * Walks every instance and mesh a chunk built, takes the world position each
 * one stands at, and asks the terrain field how high the ground is there. What
 * comes back is the distribution of the error: how far the scenery is off the
 * ground it is supposed to be standing on, and the worst offenders by name.
 *
 * A landscape can look plausible in a still and still be wrong - a tree fifteen
 * metres in the air is only obvious from the right angle - so this is the check
 * that does not depend on catching it in a screenshot.
 *
 *   node tools/groundcheck.mjs [biome] [url]
 */
import { chromium } from 'playwright';

const biome = process.argv[2] && process.argv[2] !== 'none' ? process.argv[2] : null;
const baseUrl = process.argv[3] ?? 'http://127.0.0.1:4173/';
const executablePath =
  process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });
page.on('pageerror', (e) => console.error('[page error]', e.message));

await page.goto(`${baseUrl}?capture=1&seed=${process.env.SEED ?? 4242}&time=10.5&quality=high`, {
  waitUntil: 'domcontentloaded',
  timeout: 180000,
});
await page.waitForTimeout(12000);
await page.evaluate(() => document.querySelector('.overlay .button')?.click());
await page.waitForTimeout(8000);

if (biome) {
  const found = await page.evaluate((target) => {
    const track = window.game.world.track;
    for (let s = window.game.train.position + 600; s < 400000; s += 250) {
      track.extendTo(s + 1500);
      if (track.biomeAt(s) === target) return s + 700;
    }
    return null;
  }, biome);
  if (found === null) {
    console.error(`no ${biome} found`);
    await browser.close();
    process.exit(1);
  }
  await page.evaluate((at) => {
    const g = window.game;
    for (const st of g.world.track.stations) if (st.s < at - 60) st.served = true;
    g.train.position = at;
    g.train.speed = 0;
    g.journey.resetTo(at);
  }, found);
  await page.waitForTimeout(14000);
}

const report = await page.evaluate(() => {
  const g = window.game;
  const field = g.world.field;
  // three is not exported to the page, so borrow the constructors off objects
  // the scene graph already holds.
  const root = g.world.group;
  const pos = root.position.clone();
  const scale = root.scale.clone();
  const quat = root.quaternion.clone();
  const m = root.matrix.clone();

  // Things bolted to the railway ride on the formation, not on the terrain, so
  // they are not what this is auditing.
  const skip =
    /rail|sleeper|ballast|formation|corridor|mast|wire|catenary|signal|platform|bridge|tunnel|portal|deck|canopy|footbridge|station|crossing|sign|marker|cable-route|water|paddy|sea|road/i;

  // A roof is supposed to be twenty metres up, so comparing every piece of
  // every object against the ground says nothing. Points are bucketed by
  // position instead and only the lowest in each bucket is judged: that is the
  // part of whatever stands there that is meant to be touching the ground.
  const buckets = new Map();
  let counted = 0;

  const record = (name, x, y, z) => {
    counted++;
    const key = `${Math.round(x / 6)}:${Math.round(z / 6)}`;
    const at = buckets.get(key);
    if (!at || y < at.y) buckets.set(key, { name, x, y, z });
  };

  for (const chunk of g.world.group.getObjectByName('chunks').children) {
    for (const obj of chunk.children) {
      if (skip.test(obj.name)) continue;
      if (obj.isInstancedMesh) {
        for (let i = 0; i < obj.count; i++) {
          obj.getMatrixAt(i, m);
          m.decompose(pos, quat, scale);
          record(obj.name, pos.x, pos.y, pos.z);
        }
      } else if (obj.isMesh && obj.geometry.boundingSphere) {
        // A merged mesh has no per-object transform; sample its vertices.
        const p = obj.geometry.getAttribute('position');
        for (let i = 0; i < p.count; i += Math.max(1, Math.floor(p.count / 60))) {
          record(obj.name, p.getX(i), p.getY(i), p.getZ(i));
        }
      }
    }
  }

  const worst = [];
  const errors = [];
  for (const b of buckets.values()) {
    const gy = field.heightAt(b.x, b.z).y;
    const err = b.y - gy;
    errors.push(err);
    worst.push({ name: b.name, err: +err.toFixed(2), y: +b.y.toFixed(1), ground: +gy.toFixed(1) });
  }
  errors.sort((a, b) => a - b);
  const q = (f) => +(errors[Math.floor((errors.length - 1) * f)] ?? 0).toFixed(2);
  worst.sort((a, b) => Math.abs(b.err) - Math.abs(a.err));
  return {
    counted,
    sites: errors.length,
    biome: g.world.track.biomeAt(g.train.position),
    p01: q(0.01),
    median: q(0.5),
    p99: q(0.99),
    floating: errors.filter((e) => e > 2).length,
    sunk: errors.filter((e) => e < -3).length,
    worst: worst.slice(0, 10),
  };
});

console.log(JSON.stringify(report, null, 1));
await browser.close();
