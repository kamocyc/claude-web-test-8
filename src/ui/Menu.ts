import type { GameSettings, QualityLevel } from '../core/Settings';
import { getLanguage, onLanguageChange, setLanguage, t, type Language } from './i18n';

/**
 * Title, pause and settings screens.
 *
 * Kept deliberately small: the game starts on one keypress and the options
 * that matter (language, quality, volume, driving aid) are reachable without
 * leaving the cab.
 */

export interface MenuCallbacks {
  onStart: () => void;
  onResume: () => void;
  onRestart: (seed?: number) => void;
  onSettingsChanged: (settings: GameSettings) => void;
}

/** Key caps and the phrase key describing what they do. */
const KEYS: [string, string][] = [
  ['Z / /', 'key.powerUp'],
  ['A / :', 'key.powerDown'],
  ['.', 'key.brakeOn'],
  [',', 'key.brakeOff'],
  ['Q / @', 'key.emergency'],
  ['↑', 'key.reverserUp'],
  ['↓', 'key.reverserDown'],
  ['Enter', 'key.horn1'],
  ['Shift + Enter', 'key.horn2'],
  ['C', 'key.camera'],
  ['← / →', 'key.pan'],
  ['R', 'key.recentre'],
  ['F', 'key.auto'],
  ['B', 'key.nextBiome'],
  ['U', 'key.hideUi'],
  ['J', 'key.language'],
  ['L', 'key.headlights'],
  ['T', 'key.time'],
  ['W', 'key.weather'],
  ['P / Esc', 'key.pause'],
  ['F3', 'key.debug'],
  ['Mouse', 'key.look'],
  ['Right drag', 'key.panMouse'],
];

export class Menu {
  private readonly overlay: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly keyGrid: HTMLElement;
  private readonly actions: HTMLElement;
  private mode: 'title' | 'paused' | 'hidden' = 'title';
  private seedLabel = '';

  constructor(
    container: HTMLElement,
    private settings: GameSettings,
    private readonly callbacks: MenuCallbacks,
  ) {
    this.overlay = document.createElement('div');
    this.overlay.className = 'overlay';

    const card = document.createElement('div');
    card.className = 'overlay__card';

    this.title = document.createElement('h1');
    this.title.className = 'overlay__title';
    card.appendChild(this.title);

    this.subtitle = document.createElement('p');
    this.subtitle.className = 'overlay__subtitle';
    card.appendChild(this.subtitle);

    this.keyGrid = document.createElement('div');
    this.keyGrid.className = 'key-grid';
    card.appendChild(this.keyGrid);

    this.actions = document.createElement('div');
    this.actions.className = 'overlay__actions';
    card.appendChild(this.actions);

    this.overlay.appendChild(card);
    container.appendChild(this.overlay);

    onLanguageChange(() => this.rebuild());
    this.rebuild();
  }

  private rebuild(): void {
    this.buildKeyGrid();
    if (this.mode === 'paused') {
      this.title.textContent = t('menu.paused');
      this.subtitle.textContent = t('menu.pausedNote');
      this.buildPauseActions();
    } else {
      this.title.textContent = t('app.title');
      this.subtitle.innerHTML = `${t('app.tagline')}<br><span style="opacity:.6">${t('app.seed')} ${this.seedLabel}</span>`;
      this.buildTitleActions();
    }
  }

  private buildKeyGrid(): void {
    this.keyGrid.innerHTML = '';
    for (const [cap, key] of KEYS) {
      const row = document.createElement('div');
      row.className = 'key-row';
      const kbd = document.createElement('kbd');
      kbd.textContent = cap;
      row.appendChild(kbd);
      const text = document.createElement('span');
      text.textContent = t(key);
      row.appendChild(text);
      this.keyGrid.appendChild(row);
    }
  }

  private buildTitleActions(): void {
    this.actions.innerHTML = '';
    this.actions.appendChild(button(t('menu.start'), () => this.callbacks.onStart()));
    this.actions.appendChild(this.languageField());

    const quality = field(t('menu.quality'));
    const select = document.createElement('select');
    for (const level of ['low', 'medium', 'high', 'ultra'] as QualityLevel[]) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = t(`quality.${level}`);
      if (level === this.settings.quality) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      this.settings = { ...this.settings, quality: select.value as QualityLevel };
      this.callbacks.onSettingsChanged(this.settings);
    });
    quality.appendChild(select);
    this.actions.appendChild(quality);

    const volume = field(t('menu.volume'));
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '0';
    range.max = '100';
    range.value = String(Math.round(this.settings.masterVolume * 100));
    range.addEventListener('input', () => {
      this.settings = { ...this.settings, masterVolume: Number(range.value) / 100 };
      this.callbacks.onSettingsChanged(this.settings);
    });
    volume.appendChild(range);
    this.actions.appendChild(volume);

    const aid = field(t('menu.assist'));
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.settings.assist;
    checkbox.addEventListener('change', () => {
      this.settings = { ...this.settings, assist: checkbox.checked };
      this.callbacks.onSettingsChanged(this.settings);
    });
    aid.appendChild(checkbox);
    this.actions.appendChild(aid);

    const seedField = field(t('app.seed'));
    const seedInput = document.createElement('input');
    seedInput.type = 'number';
    seedInput.style.width = '110px';
    seedField.appendChild(seedInput);
    const newRoute = button(t('menu.newRoute'), () => {
      const value = seedInput.value.trim();
      this.callbacks.onRestart(value === '' ? undefined : Number(value) >>> 0);
    });
    newRoute.classList.add('button--ghost');
    seedField.appendChild(newRoute);
    this.actions.appendChild(seedField);
  }

  private languageField(): HTMLElement {
    const wrapper = field(t('menu.language'));
    const select = document.createElement('select');
    for (const [value, caption] of [
      ['en', 'English'],
      ['ja', '日本語'],
    ] as [Language, string][]) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = caption;
      if (value === getLanguage()) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      const language = select.value as Language;
      setLanguage(language);
      this.settings = { ...this.settings, language };
      this.callbacks.onSettingsChanged(this.settings);
    });
    wrapper.appendChild(select);
    return wrapper;
  }

  private buildPauseActions(): void {
    this.actions.innerHTML = '';
    this.actions.appendChild(button(t('menu.resume'), () => this.callbacks.onResume()));
    const restart = button(t('menu.newRoute'), () => this.callbacks.onRestart());
    restart.classList.add('button--ghost');
    this.actions.appendChild(restart);
    this.actions.appendChild(this.languageField());
  }

  showTitle(seedLabel: string): void {
    this.mode = 'title';
    this.seedLabel = seedLabel;
    this.rebuild();
    this.overlay.classList.remove('hidden');
  }

  showPaused(): void {
    this.mode = 'paused';
    this.rebuild();
    this.overlay.classList.remove('hidden');
  }

  hide(): void {
    this.mode = 'hidden';
    this.overlay.classList.add('hidden');
  }

  get isOpen(): boolean {
    return this.mode !== 'hidden';
  }

  updateSettings(settings: GameSettings): void {
    this.settings = settings;
  }
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.className = 'button';
  node.textContent = text;
  node.addEventListener('click', () => {
    node.blur();
    onClick();
  });
  return node;
}

function field(label: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';
  const caption = document.createElement('span');
  caption.textContent = label;
  wrapper.appendChild(caption);
  return wrapper;
}
