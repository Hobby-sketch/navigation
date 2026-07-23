/**
 * boot.js
 * Drives the boot screen: animates the progress bar over ~2.5s, then
 * fades the boot screen out and the app shell in.
 */

export function runBootSequence({ durationMs = 2500 } = {}) {
  return new Promise((resolve) => {
    const bootScreen = document.getElementById('boot-screen');
    const fill = document.getElementById('boot-progress-fill');
    const app = document.getElementById('app');

    const start = performance.now();
    function step(ts) {
      const elapsed = ts - start;
      const pct = Math.min(100, (elapsed / durationMs) * 100);
      fill.style.width = `${pct}%`;
      if (pct < 100) {
        requestAnimationFrame(step);
      } else {
        setTimeout(() => {
          bootScreen.classList.add('boot-screen--fade');
          app.classList.remove('app--hidden');
          setTimeout(() => {
            bootScreen.remove();
            resolve();
          }, 750);
        }, 150);
      }
    }
    requestAnimationFrame(step);
  });
}
