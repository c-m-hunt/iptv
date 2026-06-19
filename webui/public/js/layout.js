// layout.js — pure geometry for the player arrangements.
//
// split = { x, y } as fractions in (0,1). Returns rectangles in PERCENT units
// ({ x, y, w, h }) plus the handle position and which corners are free for the
// World Cup panels.

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

// Returns { rects: [r0, r1], handle, corners } for the given mode.
//   handle: { kind: 'vertical'|'point', x, y } in percent, or null
//   corners: { scores: rect|null, standings: rect|null } in percent
// dataOn: when the World Cup panels are showing, the large player pulls back to
// the split so it doesn't sit under the panels (overlaps the inset otherwise).
export function computeLayout(mode, split, dataOn = false) {
  const { x, y } = clampSplit(split);
  const ov = dataOn ? 0 : OVERLAP;

  if (mode === 'single') {
    return {
      rects: [{ x: 0, y: 0, w: 100, h: 100 }],
      handle: null,
      corners: { scores: null, standings: null },
    };
  }

  if (mode === 'horizontal') {
    return {
      rects: [
        { x: 0, y: 0, w: pct(x), h: 100 },
        { x: pct(x), y: 0, w: pct(1 - x), h: 100 },
      ],
      handle: { kind: 'vertical', x: pct(x), y: 50 },
      corners: { scores: null, standings: null },
    };
  }

  if (mode === 'diag-tlbr') {
    // Player 1 (large) anchored top-left; player 2 (small) in the bottom-right
    // corner. The large player ends at the split + ov (overlaps the inset when
    // data is off; pulls back to the split when data is on). Panels: TR, BL,
    // positioned beyond the large player so they never sit over the video.
    const bx = Math.min(1, x + ov);
    const by = Math.min(1, y + ov);
    return {
      rects: [
        { x: 0, y: 0, w: pct(bx), h: pct(by) },
        { x: pct(x), y: pct(y), w: pct(1 - x), h: pct(1 - y) },
      ],
      handle: { kind: 'point', x: pct(x), y: pct(y) },
      corners: {
        scores: { x: pct(bx), y: 0, w: Math.max(0, pct(1 - bx)), h: pct(y) }, // top-right
        standings: { x: 0, y: pct(by), w: pct(x), h: Math.max(0, pct(1 - by)) }, // bottom-left
      },
    };
  }

  // diag-bltr: player 1 (large) anchored bottom-left; player 2 (small) in the
  // top-right corner. Panels: TL, BR, beyond the large player.
  const topY = Math.max(0, y - ov);
  const bx = Math.min(1, x + ov);
  return {
    rects: [
      { x: 0, y: pct(topY), w: pct(bx), h: pct(1 - topY) },
      { x: pct(x), y: 0, w: pct(1 - x), h: pct(y) },
    ],
    handle: { kind: 'point', x: pct(x), y: pct(y) },
    corners: {
      scores: { x: 0, y: 0, w: pct(x), h: pct(topY) }, // top-left
      standings: { x: pct(bx), y: pct(y), w: Math.max(0, pct(1 - bx)), h: pct(1 - y) }, // bottom-right
    },
  };
}

export function applyRect(el, rect) {
  el.style.left = rect.x + '%';
  el.style.top = rect.y + '%';
  el.style.width = rect.w + '%';
  el.style.height = rect.h + '%';
}
