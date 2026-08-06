/**
 * Blind A/B pairing for visual review.
 *
 *   node tools/blind.mjs <beforeDir> <afterDir> <outDir> [scenarioList]
 *
 * For each scenario present in both directories this copies the two frames out
 * as `<id>-A.png` and `<id>-B.png` with the side chosen from a hash of the
 * scenario id, and writes the key to `key.json` in a sibling directory that the
 * reviewer is not given. A reviewer looking only at the image pair therefore
 * cannot tell which frame is the new work, which is the whole point: the
 * judgement has to come from the picture rather than from knowing which one
 * somebody just spent an hour on.
 */

import { copyFileSync, mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';

const [beforeDir, afterDir, outDir, list] = process.argv.slice(2);
if (!beforeDir || !afterDir || !outDir) {
  console.error('usage: node tools/blind.mjs <beforeDir> <afterDir> <outDir> [ids]');
  process.exit(1);
}

const wanted = list && list !== 'all' ? new Set(list.split(',').map((s) => s.trim())) : null;
const ids = readdirSync(beforeDir)
  .filter((f) => f.endsWith('.png'))
  .map((f) => f.slice(0, -4))
  .filter((id) => existsSync(join(afterDir, `${id}.png`)))
  .filter((id) => !wanted || wanted.has(id));

if (!ids.length) {
  console.error('no scenarios common to both directories');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const keyDir = join(dirname(outDir), `${outDir.split('/').pop()}-key`);
mkdirSync(keyDir, { recursive: true });

const key = {};
for (const id of ids) {
  // Deterministic but not guessable from the id alone at a glance, and it
  // varies per round so a reviewer cannot learn "B is always the new one".
  const digest = createHash('sha256').update(`${id}:${afterDir}`).digest();
  const afterIsA = (digest[0] & 1) === 0;
  copyFileSync(join(afterIsA ? afterDir : beforeDir, `${id}.png`), join(outDir, `${id}-A.png`));
  copyFileSync(join(afterIsA ? beforeDir : afterDir, `${id}.png`), join(outDir, `${id}-B.png`));
  key[id] = { A: afterIsA ? 'after' : 'before', B: afterIsA ? 'before' : 'after' };
}

writeFileSync(join(keyDir, 'key.json'), JSON.stringify(key, null, 2));
console.log(`paired ${ids.length} scenarios into ${outDir}`);
console.log(`key written to ${join(keyDir, 'key.json')} - do not show this to the reviewer`);
console.log(ids.join(','));
