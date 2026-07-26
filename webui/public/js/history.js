// history.js — recently played films and where you got to in each.
//
// Stored in localStorage alongside presets and the last setup, so a resume
// point survives a reload without needing any server state. Entries carry
// enough to restart playback on their own (id, title, poster, runtime and the
// playback mode), which is what lets the continue-watching row start a film
// without re-probing its container first.

const KEY = 'iptv-watch-history-v1';
const MAX = 30;
// Below this, "where you got to" isn't worth remembering — you'd rather start
// the film again than resume 8 seconds in.
const MIN_RESUME = 15;
// Within this of the end, treat the film as watched rather than resumable.
const NEAR_END = 60;

export class WatchHistory {
  constructor() {
    this.data = this._read();
  }

  _read() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  _write() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage full or disabled — history just won't persist */
    }
  }

  // Most recently played first.
  list() {
    return this.data.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // Films and episodes come from different id spaces, so an id alone could
  // collide. Entries written before types existed are films.
  get(id, type = 'movie') {
    return this.data.find((e) => e.id === id && (e.type || 'movie') === type) || null;
  }

  // Where playback should start: 0 unless there's a meaningful resume point
  // that isn't effectively the end.
  resumeAt(id, type = 'movie') {
    const e = this.get(id, type);
    if (!e || e.finished) return 0;
    return e.position > MIN_RESUME ? e.position : 0;
  }

  // Called when something starts and periodically as it plays.
  record({
    id,
    type = 'movie',
    title,
    poster,
    durationSecs,
    mode,
    position = 0,
    showId,
    showName,
    showCover,
    season,
    episode,
  }) {
    if (!id) return;
    let entry = this.get(id, type);
    if (!entry) {
      entry = { id, type };
      this.data.push(entry);
    }
    entry.type = type;
    if (showId !== undefined) entry.showId = showId;
    if (showName !== undefined) entry.showName = showName;
    if (showCover !== undefined) entry.showCover = showCover;
    if (season !== undefined) entry.season = season;
    if (episode !== undefined) entry.episode = episode;
    entry.title = title || entry.title || '';
    entry.poster = poster || entry.poster || '';
    entry.durationSecs = durationSecs || entry.durationSecs || null;
    entry.mode = mode || entry.mode || 'direct';
    entry.position = Math.max(0, Math.floor(position));
    entry.finished = !!(
      entry.durationSecs && entry.position >= entry.durationSecs - NEAR_END
    );
    entry.updatedAt = Date.now();

    // Drop the oldest once we're over the cap.
    if (this.data.length > MAX) {
      this.data.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      this.data = this.data.slice(0, MAX);
    }
    this._write();
  }

  // One entry per show — the episode you were last watching. That's what a
  // "continue watching" row for series should offer, rather than every episode
  // of the same show competing for space.
  listShows() {
    const byShow = new Map();
    for (const e of this.data) {
      if ((e.type || 'movie') !== 'episode') continue;
      const key = e.showId ?? e.showName ?? e.id;
      const seen = byShow.get(key);
      if (!seen || (e.updatedAt || 0) > (seen.updatedAt || 0)) byShow.set(key, e);
    }
    return [...byShow.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  // Drop every episode of a show, so removing it from the row doesn't just
  // surface an older episode of the same series.
  removeShow(showId) {
    const before = this.data.length;
    this.data = this.data.filter(
      (e) => !((e.type || 'movie') === 'episode' && e.showId === showId)
    );
    if (this.data.length !== before) this._write();
  }

  remove(id, type = 'movie') {
    const before = this.data.length;
    this.data = this.data.filter((e) => !(e.id === id && (e.type || 'movie') === type));
    if (this.data.length !== before) this._write();
  }

  clear() {
    this.data = [];
    this._write();
  }
}
