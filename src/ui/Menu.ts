import type { GameSettings, QualityLevel } from '../core/Settings';

/**
 * Title, pause and settings screens.
 *
 * Kept deliberately small: the game starts on one keypress and the options
 * that matter (quality, volume, driving aid) are reachable without leaving
 * the cab.
 */

export interface MenuCallbacks {
  onStart: () => void;
  onResume: () => void;
  onRestart: (seed?: number) => void;
  onSettingsChanged: (settings: GameSettings) => void;
}

const KEYS: [string, string][] = [
  ['Z / A', 'Master controller: more / less power'],
  ['. / ,', 'Brake: apply / release'],
  ['Space', 'Emergency brake'],
  ['S', 'Release brake fully'],
  ['H', 'Horn'],
  ['C', 'Change camera'],
  ['Mouse drag', 'Look around'],
  ['L', 'Headlights'],
  ['T', 'Advance the clock (time of day)'],
  ['W', 'Cycle the weather'],
  ['P / Esc', 'Pause'],
  ['F3', 'Performance overlay'],
];

export class Menu {
  private readonly overlay: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly actions: HTMLElement;
  private mode: 'title' | 'paused' | 'hidden' = 'title';

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
    this.title.textContent = 'Infinite Rail';
    card.appendChild(this.title);

    this.subtitle = document.createElement('p');
    this.subtitle.className = 'overlay__subtitle';
    this.subtitle.innerHTML =
      'An endlessly generated Japanese railway. Drive a four car EMU along a line that has never existed before &mdash; coast, mountain, forest, paddy field, suburb and city &mdash; and keep it on time.';
    card.appendChild(this.subtitle);

    const grid = document.createElement('div');
    grid.className = 'key-grid';
    for (const [key, description] of KEYS) {
      const row = document.createElement('div');
      row.className = 'key-row';
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      row.appendChild(kbd);
      const text = document.createElement('span');
      text.textContent = description;
      row.appendChild(text);
      grid.appendChild(row);
    }
    card.appendChild(grid);

    this.actions = document.createElement('div');
    this.actions.className = 'overlay__actions';
    card.appendChild(this.actions);

    this.overlay.appendChild(card);
    container.appendChild(this.overlay);

    this.buildTitleActions();
  }

  private buildTitleActions(): void {
    this.actions.innerHTML = '';

    const start = button('Start driving', () => this.callbacks.onStart());
    this.actions.appendChild(start);

    const quality = document.createElement('div');
    quality.className = 'field';
    quality.appendChild(labelFor('Quality'));
    const select = document.createElement('select');
    for (const level of ['low', 'medium', 'high', 'ultra'] as QualityLevel[]) {
      const option = document.createElement('option');
      option.value = level;
      option.textContent = level[0].toUpperCase() + level.slice(1);
      if (level === this.settings.quality) option.selected = true;
      select.appendChild(option);
    }
    select.addEventListener('change', () => {
      this.settings = { ...this.settings, quality: select.value as QualityLevel };
      this.callbacks.onSettingsChanged(this.settings);
    });
    quality.appendChild(select);
    this.actions.appendChild(quality);

    const volume = document.createElement('div');
    volume.className = 'field';
    volume.appendChild(labelFor('Volume'));
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

    const aid = document.createElement('div');
    aid.className = 'field';
    aid.appendChild(labelFor('Driving aid'));
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.settings.assist;
    checkbox.addEventListener('change', () => {
      this.settings = { ...this.settings, assist: checkbox.checked };
      this.callbacks.onSettingsChanged(this.settings);
    });
    aid.appendChild(checkbox);
    this.actions.appendChild(aid);

    const seedField = document.createElement('div');
    seedField.className = 'field';
    seedField.appendChild(labelFor('Route seed'));
    const seedInput = document.createElement('input');
    seedInput.type = 'number';
    seedInput.style.width = '110px';
    seedInput.placeholder = 'random';
    seedField.appendChild(seedInput);
    const newRoute = button('New route', () => {
      const value = seedInput.value.trim();
      this.callbacks.onRestart(value === '' ? undefined : Number(value) >>> 0);
    });
    newRoute.classList.add('button--ghost');
    seedField.appendChild(newRoute);
    this.actions.appendChild(seedField);
  }

  private buildPauseActions(): void {
    this.actions.innerHTML = '';
    this.actions.appendChild(button('Resume', () => this.callbacks.onResume()));
    const restart = button('New route', () => this.callbacks.onRestart());
    restart.classList.add('button--ghost');
    this.actions.appendChild(restart);
  }

  showTitle(seedLabel: string): void {
    this.mode = 'title';
    this.title.textContent = 'Infinite Rail';
    this.subtitle.innerHTML = `An endlessly generated Japanese railway. Drive a four car EMU along a line that has never existed before &mdash; coast, mountain, forest, paddy field, suburb and city &mdash; and keep it on time.<br><span style="opacity:.6">Route seed ${seedLabel}</span>`;
    this.buildTitleActions();
    this.overlay.classList.remove('hidden');
  }

  showPaused(): void {
    this.mode = 'paused';
    this.title.textContent = 'Paused';
    this.subtitle.textContent = 'The train is held with the brakes applied.';
    this.buildPauseActions();
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
  node.addEventListener('click', onClick);
  return node;
}

function labelFor(text: string): HTMLElement {
  const node = document.createElement('span');
  node.textContent = text;
  return node;
}
