// layout.js — pure geometry for the player arrangements.
//
// split = { x, y } as fractions in (0,1). Returns rectangles in PERCENT units
// ({ x, y, w, h }) plus the handle position and which corners are free for the
// overlay panels.

export const MODES = ['horizontal', 'diag-tlbr', 'diag-bltr'];

export const MODE_LABELS = {
  single: 'single',
  horizontal: 'horizontal',
  'diag-tlbr': 'diagonal ↖↘',
  'diag-bltr': 'diagonal ↙↗',
};

const MIN = 0.12;
const MAX = 0.88;

export function clampSplit(split) {
  return {
    x: Math.min(MAX, Math.max(MIN, split.x)),
    y: Math.min(MAX, Math.max(MIN, split.y)),
  };
}

const pct = (v) => v * 100;

// How much the small (inset) player overlaps the large one in diagonal mode.
const OVERLAP = 0.13;

// Returns { rects: [r0, r1], handle } for the given mode.
//   handle: { kind: 'vertical'|'point', x, y } in percent, or null
export function computeLayout(mode, split) {
  const { x, y } = clampSplit(split);

  if (mode === 'single') {
    return {
      rects: [{ x: 0, y: 0, w: 100, h: 100 }],
      handle: null,
    };
  }

  if (mode === 'horizontal') {
    return {
      rects: [
        { x: 0, y: 0, w: pct(x), h: 100 },
        { x: pct(x), y: 0, w: pct(1 - x), h: 100 },
      ],
      handle: { kind: 'vertical', x: pct(x), y: 50 },
    };
  }

  if (mode === 'diag-tlbr') {
    // Player 1 (large) anchored top-left; player 2 (small) overlapping inset bottom-right.
    const bx = Math.min(1, x + OVERLAP);
    const by = Math.min(1, y + OVERLAP);
    return {
      rects: [
        { x: 0, y: 0, w: pct(bx), h: pct(by) },
        { x: pct(x), y: pct(y), w: pct(1 - x), h: pct(1 - y) },
      ],
      handle: { kind: 'point', x: pct(x), y: pct(y) },
    };
  }

  // diag-bltr: player 1 (large) anchored bottom-left; player 2 (small) overlapping inset top-right.
  const topY = Math.max(0, y - OVERLAP);
  const bx = Math.min(1, x + OVERLAP);
  return {
    rects: [
      { x: 0, y: pct(topY), w: pct(bx), h: pct(1 - topY) },
      { x: pct(x), y: 0, w: pct(1 - x), h: pct(y) },
    ],
    handle: { kind: 'point', x: pct(x), y: pct(y) },
  };
}

export function applyRect(el, rect) {
  el.style.left = rect.x + '%';
  el.style.top = rect.y + '%';
  el.style.width = rect.w + '%';
  el.style.height = rect.h + '%';
}
