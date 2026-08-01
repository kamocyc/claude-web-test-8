import type { BiomeId } from './Biome';
import type { Rng } from '../core/Random';

/**
 * Procedural Japanese place names.
 *
 * Names are assembled from real toponym morphemes and rendered in both kanji
 * and Hepburn romaji, so signboards and the cab display agree with each other
 * (e.g. 海の松平 / Umino-Matsudaira).
 */

interface Morpheme {
  ja: string;
  ro: string;
}

const PREFIXES: Morpheme[] = [
  { ja: '東', ro: 'Higashi' },
  { ja: '西', ro: 'Nishi' },
  { ja: '南', ro: 'Minami' },
  { ja: '北', ro: 'Kita' },
  { ja: '新', ro: 'Shin' },
  { ja: '上', ro: 'Kami' },
  { ja: '下', ro: 'Shimo' },
  { ja: '中', ro: 'Naka' },
  { ja: '奥', ro: 'Oku' },
  { ja: '古', ro: 'Furu' },
];

const COAST_PREFIXES: Morpheme[] = [
  { ja: '海の', ro: 'Umino' },
  { ja: '浦', ro: 'Ura' },
  { ja: '汐', ro: 'Shio' },
];

/** First element of the stem. */
const HEADS: Record<'common' | 'coast' | 'mountain' | 'rural' | 'urban', Morpheme[]> = {
  common: [
    { ja: '松', ro: 'Matsu' },
    { ja: '桜', ro: 'Sakura' },
    { ja: '青', ro: 'Ao' },
    { ja: '白', ro: 'Shira' },
    { ja: '高', ro: 'Taka' },
    { ja: '小', ro: 'Ko' },
    { ja: '大', ro: 'Ō' },
    { ja: '長', ro: 'Naga' },
    { ja: '宮', ro: 'Miya' },
    { ja: '福', ro: 'Fuku' },
  ],
  coast: [
    { ja: '汐', ro: 'Shio' },
    { ja: '磯', ro: 'Iso' },
    { ja: '浜', ro: 'Hama' },
    { ja: '波', ro: 'Nami' },
    { ja: '白', ro: 'Shira' },
    { ja: '青', ro: 'Ao' },
  ],
  mountain: [
    { ja: '岩', ro: 'Iwa' },
    { ja: '峰', ro: 'Mine' },
    { ja: '杉', ro: 'Sugi' },
    { ja: '霧', ro: 'Kiri' },
    { ja: '深', ro: 'Fuka' },
    { ja: '高', ro: 'Taka' },
  ],
  rural: [
    { ja: '稲', ro: 'Ina' },
    { ja: '穂', ro: 'Ho' },
    { ja: '菜', ro: 'Na' },
    { ja: '柿', ro: 'Kaki' },
    { ja: '梅', ro: 'Ume' },
    { ja: '桑', ro: 'Kuwa' },
  ],
  urban: [
    { ja: '本', ro: 'Hon' },
    { ja: '栄', ro: 'Sakae' },
    { ja: '緑', ro: 'Midori' },
    { ja: '旭', ro: 'Asahi' },
    { ja: '錦', ro: 'Nishiki' },
    { ja: '曙', ro: 'Akebono' },
  ],
};

/** Second element of the stem. */
const TAILS: Record<'common' | 'coast' | 'mountain' | 'rural' | 'urban', Morpheme[]> = {
  common: [
    { ja: '平', ro: 'daira' },
    { ja: '原', ro: 'hara' },
    { ja: '野', ro: 'no' },
    { ja: '木', ro: 'gi' },
    { ja: '井', ro: 'i' },
    { ja: '本', ro: 'moto' },
    { ja: '倉', ro: 'kura' },
    { ja: '代', ro: 'shiro' },
  ],
  coast: [
    { ja: '浜', ro: 'hama' },
    { ja: '崎', ro: 'zaki' },
    { ja: '津', ro: 'tsu' },
    { ja: '江', ro: 'e' },
    { ja: '浦', ro: 'ura' },
    { ja: '磯', ro: 'iso' },
  ],
  mountain: [
    { ja: '山', ro: 'yama' },
    { ja: '峠', ro: 'tōge' },
    { ja: '谷', ro: 'tani' },
    { ja: '尾', ro: 'o' },
    { ja: '沢', ro: 'sawa' },
    { ja: '岳', ro: 'take' },
  ],
  rural: [
    { ja: '田', ro: 'ta' },
    { ja: '畑', ro: 'hata' },
    { ja: '村', ro: 'mura' },
    { ja: '里', ro: 'sato' },
    { ja: '塚', ro: 'zuka' },
    { ja: '原', ro: 'hara' },
  ],
  urban: [
    { ja: '町', ro: 'machi' },
    { ja: '橋', ro: 'bashi' },
    { ja: '台', ro: 'dai' },
    { ja: '園', ro: 'en' },
    { ja: '通', ro: 'dōri' },
    { ja: '央', ro: 'ō' },
  ],
};

type Flavour = keyof typeof HEADS;

function flavourFor(biome: BiomeId): Flavour {
  switch (biome) {
    case 'coast':
      return 'coast';
    case 'mountain':
    case 'forest':
      return 'mountain';
    case 'farmland':
    case 'riverside':
      return 'rural';
    case 'city':
    case 'suburb':
      return 'urban';
    default:
      return 'common';
  }
}

export interface PlaceName {
  ja: string;
  ro: string;
}

/** Sentence-cases a romaji fragment. */
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function generateStationName(rng: Rng, biome: BiomeId, used: Set<string>): PlaceName {
  const flavour = flavourFor(biome);
  for (let attempt = 0; attempt < 24; attempt++) {
    const heads = rng.chance(0.62) ? HEADS[flavour] : HEADS.common;
    const tails = rng.chance(0.68) ? TAILS[flavour] : TAILS.common;
    const head = rng.pick(heads);
    const tail = rng.pick(tails);

    let ja = head.ja + tail.ja;
    let ro = cap(head.ro) + tail.ro;

    if (rng.chance(0.26)) {
      const pool = biome === 'coast' && rng.chance(0.5) ? COAST_PREFIXES : PREFIXES;
      const prefix = rng.pick(pool);
      ja = prefix.ja + ja;
      ro = `${prefix.ro}-${ro}`;
    }
    if (!used.has(ja)) {
      used.add(ja);
      return { ja, ro };
    }
  }
  const n = used.size;
  used.add(`第${n}`);
  return { ja: `第${n}信号場`, ro: `Signal-${n}` };
}

const REGIONS: { ja: string; ro: string; operator: string }[] = [
  { ja: '九州', ro: 'Kyushu', operator: 'JR Kyushu' },
  { ja: '四国', ro: 'Shikoku', operator: 'JR Shikoku' },
  { ja: '西日本', ro: 'West Japan', operator: 'JR West' },
  { ja: '東日本', ro: 'East Japan', operator: 'JR East' },
  { ja: '北海道', ro: 'Hokkaido', operator: 'JR Hokkaido' },
  { ja: '東海', ro: 'Central', operator: 'JR Central' },
];

export interface RouteName {
  operator: string;
  line: string;
  lineJa: string;
  region: string;
}

export function generateRouteName(rng: Rng, biome: BiomeId): RouteName {
  const region = rng.pick(REGIONS);
  const flavour = flavourFor(biome);
  const head = rng.pick(rng.chance(0.5) ? HEADS[flavour] : HEADS.common);
  const tail = rng.pick(rng.chance(0.5) ? TAILS[flavour] : TAILS.common);
  return {
    operator: region.operator,
    line: `${cap(head.ro)}${tail.ro} Line`,
    lineJa: `${head.ja}${tail.ja}線`,
    region: region.ro,
  };
}

export type ServiceKind = 'Local' | 'Rapid' | 'Express' | 'Limited Express';

export interface ServiceInfo {
  kind: ServiceKind;
  kindJa: string;
  number: string;
  destination: PlaceName;
}

export function generateService(rng: Rng, destination: PlaceName): ServiceInfo {
  const roll = rng.next();
  const kind: ServiceKind = roll < 0.62 ? 'Local' : roll < 0.86 ? 'Rapid' : 'Express';
  const kindJa = kind === 'Local' ? '普通' : kind === 'Rapid' ? '快速' : '急行';
  const suffix = rng.pick(['D', 'M', 'H', '']);
  return {
    kind,
    kindJa,
    number: `${rng.int(100, 999)}${suffix}`,
    destination,
  };
}
