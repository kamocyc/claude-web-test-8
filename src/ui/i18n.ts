/**
 * Interface language.
 *
 * The cab display, menus and messages exist in English and Japanese. Station
 * and line names are always generated in both scripts, so switching language
 * changes which one leads rather than translating anything at run time.
 */

export type Language = 'en' | 'ja';

type Dict = Record<string, string>;

const en: Dict = {
  'app.title': 'Infinite Rail',
  'app.tagline':
    'An endlessly generated Japanese railway. Drive a four car EMU along a line that has never existed before — coast, mountain, forest, paddy field, suburb and city — and keep it on time.',
  'app.seed': 'Route seed',

  'menu.start': 'Start driving',
  'menu.resume': 'Resume',
  'menu.newRoute': 'New route',
  'menu.quality': 'Quality',
  'menu.volume': 'Volume',
  'menu.assist': 'Driving aid',
  'menu.shake': 'Camera shake',
  'menu.language': 'Language',
  'menu.paused': 'Paused',
  'menu.pausedNote': 'The train is held with the brakes applied.',
  'menu.controls': 'Controls',

  'quality.low': 'Low',
  'quality.medium': 'Medium',
  'quality.high': 'High',
  'quality.ultra': 'Ultra',

  'hud.nextStation': 'Next Sta',
  'hud.score': 'Score',
  'hud.late': 'Late',
  'hud.speed': 'Speed',
  'hud.limit': 'Limit',
  'hud.position': 'Current Pos',
  'hud.route': 'Route',
  'hud.brake': 'Brake',
  'hud.master': 'Master Controller',
  'hud.reverser': 'Reverser',
  'hud.toStop': 'Distance to Stop',
  'hud.target': 'Target',
  'hud.doorsOpen': 'Doors open',
  'hud.brakeCurve': 'Brake curve',
  'hud.auto': 'AUTO',
  'hud.start': 'GAME START',
  'hud.pause': 'PAUSE',

  'msg.depart': 'DEPART WHEN READY',
  'msg.doorsClosing': 'DOORS CLOSING',
  'msg.overspeed': 'OVERSPEED',
  'msg.emergency': 'EMERGENCY BRAKE',
  'msg.stationPassed': 'STATION PASSED',
  'msg.perfectStop': 'PERFECT STOP',
  'msg.goodStop': 'GOOD STOP',
  'msg.fairStop': 'STOP OK',
  'msg.poorStop': 'POOR STOP',
  'msg.headlightsOn': 'HEADLIGHTS ON',
  'msg.headlightsOff': 'HEADLIGHTS OFF',
  'msg.autoOn': 'AUTOMATIC DRIVING ON',
  'msg.autoOff': 'MANUAL DRIVING',
  'msg.uiHidden': 'DISPLAY OFF — press U to restore',
  'msg.reverserStop': 'STOP THE TRAIN FIRST',
  'msg.skipping': 'SKIPPING AHEAD…',

  'reverser.forward': 'FWD',
  'reverser.neutral': 'N',
  'reverser.reverse': 'REV',

  'weather.clear': 'CLEAR',
  'weather.fair': 'FAIR',
  'weather.overcast': 'OVERCAST',
  'weather.rain': 'RAIN',
  'weather.mist': 'MIST',
  'weather.snow': 'SNOW',

  'camera.cab': 'Cab',
  'camera.window': 'Passenger window',
  'camera.chase': 'Chase',
  'camera.lineside': 'Lineside',
  'camera.nose': 'Nose',
  'camera.roof': 'Roof',

  'biome.coast': 'Coast',
  'biome.mountain': 'Mountain',
  'biome.forest': 'Forest',
  'biome.farmland': 'Farmland',
  'biome.suburb': 'Suburb',
  'biome.city': 'City',
  'biome.riverside': 'Riverside',

  'key.powerUp': 'Master controller: notch up',
  'key.powerDown': 'Master controller: notch down',
  'key.brakeOn': 'Brake: step on',
  'key.brakeOff': 'Brake: step off',
  'key.emergency': 'Emergency brake',
  'key.reverserUp': 'Reverser forward',
  'key.reverserDown': 'Reverser reverse',
  'key.horn1': 'Horn (low)',
  'key.horn2': 'Horn (high)',
  'key.camera': 'Change camera',
  'key.look': 'Look around',
  'key.pan': 'Slide the view sideways',
  'key.panMouse': 'Slide the view sideways',
  'key.recentre': 'Recentre the view',
  'key.headlights': 'Headlights',
  'key.time': 'Advance the clock',
  'key.weather': 'Cycle the weather',
  'key.auto': 'Automatic driving',
  'key.hideUi': 'Hide the display',
  'key.nextBiome': 'Skip to the next landscape',
  'key.language': 'English / 日本語',
  'key.pause': 'Pause',
  'key.debug': 'Performance overlay',
};

const ja: Dict = {
  'app.title': '無限鉄道',
  'app.tagline':
    '無限に生成される日本の鉄道路線。海岸・山岳・森林・田園・郊外・市街を走る、まだ誰も走ったことのない線区を、4両編成の電車で定時運転してください。',
  'app.seed': '路線シード',

  'menu.start': '運転開始',
  'menu.resume': '再開',
  'menu.newRoute': '別の路線へ',
  'menu.quality': '画質',
  'menu.volume': '音量',
  'menu.assist': '運転支援',
  'menu.shake': '画面の揺れ',
  'menu.language': '言語',
  'menu.paused': '一時停止',
  'menu.pausedNote': 'ブレーキを込めて停車中です。',
  'menu.controls': '操作方法',

  'quality.low': '低',
  'quality.medium': '中',
  'quality.high': '高',
  'quality.ultra': '最高',

  'hud.nextStation': '次駅',
  'hud.score': '得点',
  'hud.late': '遅延',
  'hud.speed': '速度',
  'hud.limit': '制限',
  'hud.position': '現在位置',
  'hud.route': '路線',
  'hud.brake': 'ブレーキ',
  'hud.master': 'マスコン',
  'hud.reverser': '逆転器',
  'hud.toStop': '停止位置まで',
  'hud.target': '目標',
  'hud.doorsOpen': 'ドア開',
  'hud.brakeCurve': 'ブレーキ曲線',
  'hud.auto': '自動運転',
  'hud.start': 'ゲーム開始',
  'hud.pause': '一時停止',

  'msg.depart': '出発進行',
  'msg.doorsClosing': 'ドアが閉まります',
  'msg.overspeed': '速度超過',
  'msg.emergency': '非常ブレーキ',
  'msg.stationPassed': '停車駅通過',
  'msg.perfectStop': '定位置停止',
  'msg.goodStop': '停止位置 良',
  'msg.fairStop': '停止位置 可',
  'msg.poorStop': '停止位置 不良',
  'msg.headlightsOn': '前照灯 点灯',
  'msg.headlightsOff': '前照灯 消灯',
  'msg.autoOn': '自動運転 開始',
  'msg.autoOff': '手動運転',
  'msg.uiHidden': '表示を消しました — U キーで復帰',
  'msg.reverserStop': '停車してから操作してください',
  'msg.skipping': '次の車窓へ…',

  'reverser.forward': '前',
  'reverser.neutral': '切',
  'reverser.reverse': '後',

  'weather.clear': '快晴',
  'weather.fair': '晴れ',
  'weather.overcast': '曇り',
  'weather.rain': '雨',
  'weather.mist': '霧',
  'weather.snow': '雪',

  'camera.cab': '運転台',
  'camera.window': '車窓',
  'camera.chase': '追跡',
  'camera.lineside': '沿線',
  'camera.nose': '前頭部',
  'camera.roof': '屋根上',

  'biome.coast': '海岸',
  'biome.mountain': '山岳',
  'biome.forest': '森林',
  'biome.farmland': '田園',
  'biome.suburb': '郊外',
  'biome.city': '市街',
  'biome.riverside': '河川',

  'key.powerUp': 'マスコン ＋（力行）',
  'key.powerDown': 'マスコン －',
  'key.brakeOn': 'ブレーキ ＋（込め）',
  'key.brakeOff': 'ブレーキ －（緩め）',
  'key.emergency': '非常ブレーキ',
  'key.reverserUp': '逆転器ハンドル ↑（前）',
  'key.reverserDown': '逆転器ハンドル ↓（後）',
  'key.horn1': '警笛 1',
  'key.horn2': '警笛 2',
  'key.camera': '視点切替',
  'key.look': '見回す',
  'key.pan': '視点を左右に移動',
  'key.panMouse': '視点を左右に移動',
  'key.recentre': '視点を戻す',
  'key.headlights': '前照灯',
  'key.time': '時刻を進める',
  'key.weather': '天候切替',
  'key.auto': '自動運転',
  'key.hideUi': '表示を消す',
  'key.nextBiome': '次の風景へ',
  'key.language': 'English / 日本語',
  'key.pause': '一時停止',
  'key.debug': '性能表示',
};

const DICTS: Record<Language, Dict> = { en, ja };

let current: Language = 'en';
const listeners = new Set<() => void>();

export function setLanguage(language: Language): void {
  if (current === language) return;
  current = language;
  for (const listener of listeners) listener();
}

export function getLanguage(): Language {
  return current;
}

/** Registers a callback fired whenever the language changes. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Looks up a phrase; unknown keys fall back to the key itself. */
export function t(key: string): string {
  return DICTS[current][key] ?? DICTS.en[key] ?? key;
}

/** Picks the better default from the browser's language settings. */
export function detectLanguage(): Language {
  const langs = navigator.languages ?? [navigator.language];
  return langs.some((l) => l && l.toLowerCase().startsWith('ja')) ? 'ja' : 'en';
}

/** Name of a place in the leading script for the current language. */
export function placeName(name: { ja: string; ro: string }): string {
  return current === 'ja' ? name.ja : name.ro;
}

/** The same name in the secondary script, for the smaller line beneath. */
export function placeNameSub(name: { ja: string; ro: string }): string {
  return current === 'ja' ? name.ro : name.ja;
}
