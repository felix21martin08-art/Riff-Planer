/**
 * @file main.js — VOXELIA entry point.
 *
 * Everything interesting lives in `game/game.js`; this module only binds the
 * game to the `#gl` canvas, forwards boot progress to the splash screen
 * declared in `index.html`, and turns a missing WebGL2 context into a readable
 * German message instead of a black page.
 */

import { Game } from './game/game.js';

/**
 * Hand a fatal failure to the boot splash of `index.html`, falling back to a
 * minimal inline panel when that page was replaced.
 * @param {string} title German headline.
 * @param {string} detail German explanation (or a stack trace).
 * @returns {void}
 */
function fatal(title, detail) {
  console.error(`[VOXELIA] ${title}\n${detail}`);
  const hook = /** @type {*} */ (window).voxFatal;
  if (typeof hook === 'function') {
    try {
      hook(title, detail);
      return;
    } catch { /* fall through to the inline panel */ }
  }
  const box = document.getElementById('fatal');
  const text = document.getElementById('fatal-text');
  if (text) text.textContent = `${title}\n\n${detail}`;
  if (box) box.style.display = 'block';
  const boot = document.getElementById('boot');
  if (boot) boot.classList.add('hidden');
}

/**
 * Forward loading progress to the splash bar installed by `index.html`.
 * @param {number} fraction Progress `0..1`.
 * @param {string} label German step name.
 * @returns {void}
 */
function progress(fraction, label) {
  const hook = /** @type {*} */ (window).voxProgress;
  if (typeof hook !== 'function') return;
  try {
    hook(fraction, label);
  } catch { /* the splash is cosmetic; never let it stop the boot */ }
}

/**
 * Hide the splash once the menu is up.
 * @returns {void}
 */
function bootDone() {
  const hook = /** @type {*} */ (window).voxBootDone;
  if (typeof hook !== 'function') return;
  try {
    hook();
  } catch { /* ignore */ }
}

/**
 * Boot VOXELIA: create the game, run it, and report anything that goes wrong.
 * @returns {Promise<void>} Resolves once the loop is running (or a fatal
 *   message is on screen).
 */
async function main() {
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('gl'));
  if (!canvas) {
    fatal('VOXELIA konnte nicht starten', 'Das Canvas-Element „#gl" fehlt in der Seite.');
    return;
  }

  // Checked before the game touches the canvas, so a device without WebGL2 gets
  // a real explanation instead of a stack trace.
  let supported = false;
  try {
    supported = !!document.createElement('canvas').getContext('webgl2');
  } catch {
    supported = false;
  }
  if (!supported) {
    fatal('WebGL2 wird nicht unterstützt',
      'VOXELIA benötigt WebGL2. Bitte einen aktuellen Chrome, Firefox, Edge oder Safari 15+ '
      + 'verwenden und die Hardwarebeschleunigung in den Browsereinstellungen aktivieren.');
    return;
  }

  const game = new Game(canvas);
  window.game = game;

  try {
    await game.boot((fraction, label) => progress(fraction, label));
  } catch (err) {
    const detail = (err && (err.stack || err.message)) || String(err);
    fatal('VOXELIA konnte nicht starten', detail);
    return;
  }

  game.start();
  bootDone();
  // Read by tools/smoke.mjs and by the error trap in index.html, which stops
  // reporting page errors as fatal once the game owns them.
  window.__voxReady = true;
}

main().catch((err) => {
  const detail = (err && (err.stack || err.message)) || String(err);
  fatal('VOXELIA konnte nicht starten', detail);
});
