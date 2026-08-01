import * as THREE from 'three';
import { Game } from './game/Game';

/**
 * Entry point: find the canvas, start the game, and report anything that goes
 * wrong in a way the player can actually read.
 */

function fail(message: string, detail?: unknown): void {
  const node = document.createElement('div');
  node.style.cssText =
    'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:40px;' +
    'font-family:system-ui,sans-serif;color:#e6eef6;background:#0a0d12;text-align:center;line-height:1.6;';
  node.innerHTML = `<div><h1 style="font-size:22px;margin:0 0 10px">${message}</h1>` +
    `<p style="opacity:.7;max-width:520px;font-size:14px">${
      detail ? String(detail) : 'This game needs a browser with WebGL 2 support.'
    }</p></div>`;
  document.body.appendChild(node);
}

function boot(): void {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
  const container = document.getElementById('ui');
  if (!canvas || !container) {
    fail('Could not start', 'The page is missing its canvas.');
    return;
  }

  // Probe on a throwaway canvas: creating a context on the real one would
  // lock in its attributes before the renderer gets to choose them.
  const probe = document.createElement('canvas').getContext('webgl2');
  if (!probe) {
    fail('WebGL 2 is not available');
    return;
  }
  probe.getExtension('WEBGL_lose_context')?.loseContext();

  try {
    const game = new Game(canvas, container);
    (window as unknown as { game: Game }).game = game;
    if (new URLSearchParams(location.search).has('capture')) {
      (window as unknown as { THREE: typeof THREE }).THREE = THREE;
    }
  } catch (error) {
    console.error(error);
    fail('The game failed to start', error instanceof Error ? error.message : error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
