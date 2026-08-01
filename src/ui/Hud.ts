import './hud.css';
import { Dial, Ring } from './Gauges';
import {
  formatClock,
  formatDelta,
  formatDistance,
  formatScore,
  clamp01,
} from '../core/MathUtils';
import { MAX_BRAKE_NOTCH, MAX_POWER_NOTCH } from '../train/TrainPhysics';
import type { StationInfo } from '../world/TrackPath';

/**
 * The cab overlay.
 *
 * Laid out like a modern Japanese driver's information display: running
 * information top left, speed and permitted speed dead centre where the eye
 * falls, the route diagram top right, and the controller state with the clock
 * bottom right beside the dials.
 */

export interface HudState {
  nextStation: StationInfo | null;
  distanceToStation: number;
  stationProgress: number;
  score: number;
  delay: number;
  speed: number;
  limit: number;
  milepost: string;
  routeTitle: string;
  serviceLine: string;
  operator: string;
  serviceBadge: string;
  stations: StationInfo[];
  position: number;
  routeSpan: number;
  powerNotch: number;
  brakeNotch: number;
  brakePressure: number;
  distanceToStop: number;
  timeOfDay: number;
  dateLabel: string;
  assistTarget: number;
  assistEnabled: boolean;
  doorsOpen: boolean;
  dwellLeft: number;
}

export class Hud {
  readonly root: HTMLDivElement;

  private readonly stationName: HTMLElement;
  private readonly stationJa: HTMLElement;
  private readonly stationProgress: HTMLElement;
  private readonly stationDistance: HTMLElement;
  private readonly scoreValue: HTMLElement;
  private readonly delayValue: HTMLElement;
  private readonly speedValue: HTMLElement;
  private readonly limitValue: HTMLElement;
  private readonly milepostValue: HTMLElement;
  private readonly routeTitle: HTMLElement;
  private readonly routeService: HTMLElement;
  private readonly routeOperator: HTMLElement;
  private readonly routeBadge: HTMLElement;
  private readonly routeStrip: HTMLElement;
  private readonly routeProgress: HTMLElement;
  private readonly brakeValue: HTMLElement;
  private readonly masterValue: HTMLElement;
  private readonly stopValue: HTMLElement;
  private readonly clock: HTMLElement;
  private readonly message: HTMLElement;
  private readonly assist: HTMLElement;
  private readonly assistFill: HTMLElement;
  private readonly assistMarker: HTMLElement;
  private readonly assistLabel: HTMLElement;
  private readonly debug: HTMLElement;

  private readonly speedRing: Ring;
  private readonly powerRing: Ring;
  private readonly brakeDial: Dial;
  private readonly masterDial: Dial;

  private messageTimer = 0;
  private routeSignature = '';

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    container.appendChild(this.root);

    // --- next station -----------------------------------------------------
    const next = el('div', 'panel next-station');
    const row = el('div', 'next-station__row');
    row.innerHTML =
      '<svg class="next-station__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="3" width="14" height="13" rx="3"/><path d="M5 12h14M8.5 19.5 6 22M15.5 19.5 18 22"/><circle cx="8.6" cy="15.5" r="0.9" fill="currentColor"/><circle cx="15.4" cy="15.5" r="0.9" fill="currentColor"/></svg>';
    this.stationName = el('span');
    this.stationName.textContent = 'Next Sta: --';
    row.appendChild(this.stationName);
    next.appendChild(row);
    this.stationJa = el('div', 'next-station__ja');
    next.appendChild(this.stationJa);
    const progress = el('div', 'progress');
    this.stationProgress = el('div', 'progress__fill');
    progress.appendChild(this.stationProgress);
    next.appendChild(progress);
    this.stationDistance = el('div', 'next-station__distance');
    next.appendChild(this.stationDistance);
    this.root.appendChild(next);

    // --- score ------------------------------------------------------------
    const score = el('div', 'panel score-panel');
    const scoreRow = el('div', 'score-row');
    scoreRow.appendChild(el('span', 'score-row__label', 'Score:'));
    this.scoreValue = el('span', 'score-row__value', '0');
    scoreRow.appendChild(this.scoreValue);
    score.appendChild(scoreRow);
    const delayRow = el('div', 'score-row');
    delayRow.appendChild(el('span', 'score-row__label', 'Late:'));
    this.delayValue = el('span', 'score-row__value value--ontime', '+0:00s');
    delayRow.appendChild(this.delayValue);
    score.appendChild(delayRow);
    this.root.appendChild(score);

    // --- speed ------------------------------------------------------------
    const speedPanel = el('div', 'panel speed-panel');
    this.speedRing = new Ring({ size: 78, thickness: 7, accent: '#5cc6ff' });
    speedPanel.appendChild(this.speedRing.canvas);
    const readout = el('div', 'speed-readout');
    readout.appendChild(el('span', 'speed-readout__label', 'Speed:'));
    this.speedValue = el('span', 'speed-readout__value', '0 km/h');
    readout.appendChild(this.speedValue);
    readout.appendChild(el('span', 'speed-readout__label', 'Limit:'));
    this.limitValue = el('span', 'speed-readout__value', '0 km/h');
    readout.appendChild(this.limitValue);
    readout.appendChild(el('span', 'speed-readout__label', 'Current Pos:'));
    this.milepostValue = el('span', 'speed-readout__value', 'K0+000');
    readout.appendChild(this.milepostValue);
    speedPanel.appendChild(readout);
    this.powerRing = new Ring({ size: 66, thickness: 6, accent: '#9be36f' });
    speedPanel.appendChild(this.powerRing.canvas);
    this.root.appendChild(speedPanel);

    // --- route ------------------------------------------------------------
    const routePanel = el('div', 'panel route-panel');
    this.routeTitle = el('div', 'route-panel__title', 'Route: --');
    routePanel.appendChild(this.routeTitle);
    this.routeService = el('div', 'route-panel__service', '--');
    routePanel.appendChild(this.routeService);
    this.routeStrip = el('div', 'route-strip');
    const line = el('div', 'route-strip__line');
    this.routeStrip.appendChild(line);
    this.routeProgress = el('div', 'route-strip__progress');
    this.routeStrip.appendChild(this.routeProgress);
    this.routeBadge = el('div', 'route-badge', 'Local');
    this.routeStrip.appendChild(this.routeBadge);
    this.routeOperator = el('div', 'route-operator', 'JR');
    this.routeStrip.appendChild(this.routeOperator);
    routePanel.appendChild(this.routeStrip);
    this.root.appendChild(routePanel);

    // --- controls ---------------------------------------------------------
    const controls = el('div', 'controls-panel');
    const dials = el('div', 'panel dials');
    this.brakeDial = new Dial({
      min: 0,
      max: 100,
      majorStep: 20,
      minorPerMajor: 4,
      label: 'Brake',
      accent: '#ffb03a',
      size: 116,
    });
    this.masterDial = new Dial({
      min: 0,
      max: 160,
      majorStep: 20,
      minorPerMajor: 2,
      label: 'Master',
      redline: 120,
      accent: '#5cc6ff',
      size: 116,
    });
    dials.appendChild(this.brakeDial.canvas);
    dials.appendChild(this.masterDial.canvas);
    controls.appendChild(dials);

    const readouts = el('div', 'panel readouts');
    this.brakeValue = this.addReadout(readouts, 'Brake', 'N/B8', 'brake');
    this.masterValue = this.addReadout(readouts, 'Master Controller', 'N/P5');
    this.stopValue = this.addReadout(readouts, 'Distance to Stop', '--');
    this.clock = el('div', 'clock', '--:--:-- JST');
    readouts.appendChild(this.clock);
    controls.appendChild(readouts);
    this.root.appendChild(controls);

    // --- messages and driving aid -----------------------------------------
    this.message = el('div', 'message');
    this.root.appendChild(this.message);

    this.assist = el('div', 'panel assist');
    this.assistLabel = el('span', '', 'Brake curve');
    this.assist.appendChild(this.assistLabel);
    const bar = el('div', 'assist__bar');
    this.assistFill = el('div', 'assist__fill');
    bar.appendChild(this.assistFill);
    this.assistMarker = el('div', 'assist__marker');
    bar.appendChild(this.assistMarker);
    this.assist.appendChild(bar);
    this.root.appendChild(this.assist);

    this.debug = el('div', 'panel debug');
    this.root.appendChild(this.debug);
  }

  private addReadout(parent: HTMLElement, label: string, value: string, extra = ''): HTMLElement {
    const row = el('div', 'readout-row');
    row.appendChild(el('span', 'readout-row__label', label));
    const v = el('span', `readout-row__value ${extra}`.trim(), value);
    row.appendChild(v);
    parent.appendChild(row);
    return v;
  }

  /** Adds the transport controls; the callbacks are wired by the game. */
  addTransport(onStart: () => void, onPause: () => void): { start: HTMLElement; pause: HTMLElement } {
    const transport = el('div', 'transport');
    const start = document.createElement('button');
    start.className = 'transport__button';
    start.innerHTML = '<span class="transport__glyph">&#9654;</span><span>GAME START</span>';
    start.addEventListener('click', onStart);
    const pause = document.createElement('button');
    pause.className = 'transport__button';
    pause.innerHTML = '<span class="transport__glyph">&#10073;&#10073;</span><span>PAUSE</span>';
    pause.addEventListener('click', onPause);
    transport.appendChild(start);
    transport.appendChild(pause);
    this.root.appendChild(transport);
    return { start, pause };
  }

  showMessage(text: string, seconds: number): void {
    this.message.textContent = text;
    this.message.classList.add('visible');
    this.messageTimer = seconds;
  }

  setDebug(lines: string[], visible: boolean): void {
    this.debug.classList.toggle('visible', visible);
    if (visible) this.debug.innerHTML = lines.join('<br>');
  }

  update(dt: number, state: HudState): void {
    // Next station.
    if (state.nextStation) {
      this.stationName.textContent = `Next Sta: ${state.nextStation.name.ro}`;
      this.stationJa.textContent = state.nextStation.name.ja;
    } else {
      this.stationName.textContent = 'Next Sta: --';
      this.stationJa.textContent = '';
    }
    this.stationProgress.style.width = `${(clamp01(state.stationProgress) * 100).toFixed(1)}%`;
    this.stationDistance.textContent = Number.isFinite(state.distanceToStation)
      ? formatDistance(Math.max(0, state.distanceToStation))
      : '--';

    // Score and punctuality.
    this.scoreValue.textContent = formatScore(state.score);
    this.delayValue.textContent = formatDelta(state.delay);
    this.delayValue.className =
      'score-row__value ' +
      (Math.abs(state.delay) < 10 ? 'value--ontime' : state.delay > 0 ? 'value--late' : 'value--early');

    // Speed.
    const speed = Math.round(state.speed);
    const over = state.speed > state.limit + 2;
    this.speedValue.textContent = `${speed} km/h`;
    this.speedValue.classList.toggle('over', over);
    this.limitValue.textContent = `${Math.round(state.limit)} km/h`;
    this.milepostValue.textContent = state.milepost;
    this.speedRing.set(clamp01(state.speed / Math.max(state.limit, 20)), String(speed), 'km/h');
    const notchFraction =
      state.brakeNotch > 0
        ? state.brakeNotch / MAX_BRAKE_NOTCH
        : state.powerNotch / MAX_POWER_NOTCH;
    this.powerRing.set(
      notchFraction,
      state.brakeNotch > 0 ? `B${state.brakeNotch}` : state.powerNotch > 0 ? `P${state.powerNotch}` : 'N',
    );

    // Route.
    this.routeTitle.textContent = state.routeTitle;
    this.routeService.textContent = state.serviceLine;
    this.routeOperator.textContent = state.operator;
    this.routeBadge.textContent = state.serviceBadge;
    this.updateRouteStrip(state);

    // Controller readouts.
    this.brakeValue.textContent =
      state.brakeNotch >= 9 ? 'EB' : state.brakeNotch > 0 ? `B${state.brakeNotch}/B8` : 'N/B8';
    this.masterValue.textContent = state.powerNotch > 0 ? `P${state.powerNotch}/P5` : 'N/P5';
    this.stopValue.textContent = Number.isFinite(state.distanceToStop)
      ? formatDistance(Math.max(0, state.distanceToStop))
      : '--';
    this.clock.textContent = `${formatClock(state.timeOfDay)} JST, ${state.dateLabel}`;

    this.brakeDial.setValue(state.brakePressure * 100);
    this.masterDial.setValue(state.speed);
    this.brakeDial.update(dt);
    this.masterDial.update(dt);
    this.speedRing.update(dt);
    this.powerRing.update(dt);

    // Driving aid: a bar comparing actual speed with the braking curve.
    const showAssist = state.assistEnabled && Number.isFinite(state.distanceToStop) && state.distanceToStop < 1400;
    this.assist.style.display = showAssist ? 'flex' : 'none';
    if (showAssist) {
      const scale = Math.max(state.limit, 40);
      this.assistFill.style.width = `${(clamp01(state.speed / scale) * 100).toFixed(1)}%`;
      this.assistMarker.style.left = `${(clamp01(state.assistTarget / scale) * 100).toFixed(1)}%`;
      this.assistLabel.textContent = state.doorsOpen
        ? `Doors open  ${state.dwellLeft.toFixed(0)}s`
        : `Target ${Math.round(state.assistTarget)} km/h`;
    }

    if (this.messageTimer > 0) {
      this.messageTimer -= dt;
      if (this.messageTimer <= 0) this.message.classList.remove('visible');
    }
  }

  private updateRouteStrip(state: HudState): void {
    const signature = state.stations.map((s) => s.name.ja).join('|');
    if (signature !== this.routeSignature) {
      this.routeSignature = signature;
      for (const node of Array.from(this.routeStrip.querySelectorAll('.route-stop'))) node.remove();
      for (let i = 0; i < state.stations.length; i++) {
        const station = state.stations[i];
        const dot = el('div', 'route-stop');
        const label = el('div', 'route-stop__label', station.name.ja);
        dot.appendChild(label);
        dot.dataset.index = String(i);
        this.routeStrip.appendChild(dot);
      }
    }

    const dots = Array.from(this.routeStrip.querySelectorAll('.route-stop')) as HTMLElement[];
    const span = Math.max(state.routeSpan, 1);
    const origin = state.position - span * 0.12;
    for (let i = 0; i < dots.length; i++) {
      const station = state.stations[i];
      if (!station) continue;
      const t = clamp01((station.s - origin) / span);
      dots[i].style.left = `${6 + t * (this.routeStrip.clientWidth - 12)}px`;
      dots[i].classList.toggle('route-stop--served', station.served);
      dots[i].classList.toggle(
        'route-stop--next',
        !station.served && station === state.nextStation,
      );
    }
    const progress = clamp01((state.position - origin) / span);
    this.routeProgress.style.width = `${progress * (this.routeStrip.clientWidth - 12)}px`;
  }
}

function el(tag: string, className = '', text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
