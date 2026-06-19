// shortcuts.js — global keyboard handling. Delegates to the App instance.
//
// While a text input has focus (the channel search), we stay out of the way so
// keys are literal text; the search box manages its own Arrow/Enter/Esc keys.

const SPLIT_STEP = 0.03;

export function installShortcuts(app) {
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    switch (e.key) {
      case 'f':
      case 'F':
        e.preventDefault();
        app.toggleFullscreen();
        break;

      case 'ArrowLeft':
        e.preventDefault();
        app.adjustSplit(-SPLIT_STEP, 0);
        break;
      case 'ArrowRight':
        e.preventDefault();
        app.adjustSplit(SPLIT_STEP, 0);
        break;
      case 'ArrowUp':
        e.preventDefault();
        app.adjustSplit(0, -SPLIT_STEP);
        break;
      case 'ArrowDown':
        e.preventDefault();
        app.adjustSplit(0, SPLIT_STEP);
        break;

      case 'd':
      case 'D':
        e.preventDefault();
        app.toggleInfo();
        break;

      case 'l':
      case 'L':
        e.preventDefault();
        app.toggleLive();
        break;

      case 'c':
      case 'C':
        e.preventDefault();
        app.toggleControls();
        break;

      case '1':
        e.preventDefault();
        app.openSearchFor(1);
        break;
      case '2':
        e.preventDefault();
        app.openSearchFor(2);
        break;

      case '?':
      case 'h':
      case 'H':
        e.preventDefault();
        app.toggleHelp();
        break;

      default:
        break;
    }
  });
}
