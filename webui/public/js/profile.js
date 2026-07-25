// profile.js — account / subscription panel, recreating the desktop app's
// profile page: subscription expiry front and centre, plus connection limits
// and portal details.
//
// Data comes from GET /api/account (the Xtream auth endpoint). "Days left" is
// computed against the provider's own clock when it reports one, so a skewed
// browser clock can't misreport the expiry.

const DAY = 86400;
const WARN_DAYS = 14; // amber inside two weeks of expiry
// `active_cons` moves in real time, so keep refreshing while the panel is up.
// Matches the server's own account cache, so this doesn't add upstream load.
const POLL_MS = 15000;

export class Profile {
  constructor(panelEl) {
    this.panel = panelEl;
    this.account = null;
    this.error = null;
    this.loading = false;

    this.panel.innerHTML = `
      <div class="profile-head">
        <span class="profile-title">Profile</span>
        <button class="profile-refresh" title="Refresh account info">⟳</button>
        <button class="profile-close" title="Close (A / Esc)">×</button>
      </div>
      <div class="profile-body"></div>
      <div class="profile-foot"><b>A</b> toggles this panel · <b>Esc</b> closes</div>`;

    this.bodyEl = this.panel.querySelector('.profile-body');
    this.panel
      .querySelector('.profile-refresh')
      .addEventListener('click', () => this.refresh({ force: true }));
    this.panel.querySelector('.profile-close').addEventListener('click', () => this.forceClose());
    this.render();
  }

  // -- open/close ---------------------------------------------------------
  isOpen() {
    return this.panel.classList.contains('open');
  }
  open() {
    this.panel.classList.add('open');
    this.refresh();
    clearInterval(this._poll);
    this._poll = setInterval(() => this.refresh(), POLL_MS);
  }
  forceClose() {
    this.panel.classList.remove('open');
    clearInterval(this._poll);
  }
  toggle() {
    if (this.isOpen()) this.forceClose();
    else this.open();
  }

  // -- data ---------------------------------------------------------------
  async refresh({ force = false } = {}) {
    if (this.loading) return;
    this.loading = true;
    if (!this.account) this.render(); // show the loading state on first fetch
    try {
      const resp = await fetch('/api/account' + (force ? '?force=1' : ''));
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      this.account = data;
      this.error = null;
    } catch (err) {
      this.error = err.message;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  // -- render -------------------------------------------------------------
  render() {
    if (this.error) {
      this.bodyEl.innerHTML = `<div class="profile-msg bad">Couldn't load account info<br /><span class="muted">${esc(
        this.error
      )}</span></div>`;
      return;
    }
    if (!this.account) {
      this.bodyEl.innerHTML = `<div class="profile-msg muted">${
        this.loading ? 'Loading account…' : 'No account info yet.'
      }</div>`;
      return;
    }

    const { user, server } = this.account;
    const now = server.timestampNow || Math.floor(Date.now() / 1000);
    const expired = user.expDate != null && user.expDate <= now;
    const daysLeft = user.expDate != null ? Math.ceil((user.expDate - now) / DAY) : null;

    let tone = 'ok';
    if (expired) tone = 'bad';
    else if (daysLeft != null && daysLeft <= WARN_DAYS) tone = 'warn';

    const statusOk = /^active$/i.test(user.status) && !expired;

    this.bodyEl.innerHTML = `
      <div class="profile-user">
        <div class="profile-avatar">${esc((user.username || '?').slice(0, 1).toUpperCase())}</div>
        <div class="profile-ident">
          <div class="profile-name">${esc(user.username || '—')}</div>
          <div class="profile-pills">
            <span class="pill ${statusOk ? 'ok' : 'bad'}">${esc(user.status || 'Unknown')}</span>
            ${user.isTrial ? '<span class="pill warn">Trial</span>' : ''}
          </div>
        </div>
      </div>

      <div class="profile-hero ${tone}">
        <div class="hero-label">${expired ? 'Expired' : 'Subscription expires'}</div>
        <div class="hero-date">${esc(fmtDate(user.expDate))}</div>
        <div class="hero-sub">${esc(expiryPhrase(daysLeft, expired))}</div>
        ${renderBar(user.createdAt, user.expDate, now, tone)}
      </div>

      ${rows('Subscription', [
        ['Connections', connectionsText(user)],
        ['Max connections', user.maxConnections == null ? '—' : String(user.maxConnections)],
        ['Started', fmtDate(user.createdAt)],
        ['Formats', user.allowedFormats.length ? user.allowedFormats.join(', ') : '—'],
      ])}

      ${rows('Portal', [
        ['Server', server.url || '—'],
        ['Protocol', portsText(server)],
        ['Timezone', server.timezone || '—'],
        ['Server time', server.timeNow || '—'],
      ])}

      ${user.message ? `<div class="profile-msg note">${esc(user.message)}</div>` : ''}
      <div class="profile-stamp">${
        this.account.stale ? 'Portal unreachable — last known values · ' : ''
      }Updated ${esc(fmtClock(this.account.fetchedAt))}${
        this.loading ? ' · refreshing…' : ''
      }</div>`;
  }
}

// -- helpers ----------------------------------------------------------------
function connectionsText(user) {
  if (user.activeConnections == null) return '—';
  const max = user.maxConnections;
  return max == null
    ? `${user.activeConnections} active`
    : `${user.activeConnections} of ${max} in use`;
}

function portsText(server) {
  if (!server.protocol) return '—';
  const bits = [server.protocol.toUpperCase()];
  if (server.port) bits.push(`port ${server.port}`);
  if (server.httpsPort) bits.push(`https ${server.httpsPort}`);
  return bits.join(' · ');
}

function expiryPhrase(daysLeft, expired) {
  if (daysLeft == null) return 'No expiry date set';
  if (expired) {
    const ago = Math.abs(daysLeft);
    return ago === 0 ? 'Expired today' : `${ago} day${ago === 1 ? '' : 's'} ago`;
  }
  if (daysLeft === 0) return 'Expires today';
  if (daysLeft === 1) return 'Tomorrow — 1 day left';
  return `${daysLeft} days left${daysLeft >= 60 ? ` (about ${Math.round(daysLeft / 30)} months)` : ''}`;
}

// Progress through the subscription period, when both ends are known.
function renderBar(createdAt, expDate, now, tone) {
  if (createdAt == null || expDate == null || expDate <= createdAt) return '';
  const pct = Math.max(0, Math.min(1, (now - createdAt) / (expDate - createdAt)));
  return `<div class="hero-bar"><span class="hero-bar-fill ${tone}" style="width:${(
    pct * 100
  ).toFixed(1)}%"></span></div>`;
}

function rows(title, pairs) {
  const body = pairs
    .map(
      ([k, v]) =>
        `<div class="prow"><span class="pk">${esc(k)}</span><span class="pv">${esc(v)}</span></div>`
    )
    .join('');
  return `<div class="profile-section"><div class="profile-section-title">${esc(
    title
  )}</div>${body}</div>`;
}

function fmtDate(unixSeconds) {
  if (unixSeconds == null) return 'Never';
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function fmtClock(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}
