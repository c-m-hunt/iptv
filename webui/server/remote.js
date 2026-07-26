// remote.js — phone remote control: pairing, and the relay between a browser
// screen and the phones controlling it.
//
// A phone can't reach the desktop browser directly (browsers accept no inbound
// connections), so this server sits in the middle. It holds no video and no
// persistent state: just a registry of live screens, each with the last state
// its browser reported and the sockets currently attached to it.
//
//   phone ──cmd──► server ──cmd──► screen
//         ◄─state─        ◄─state─
//
// WebSocket rather than SSE because a streaming player already holds one of the
// browser's ~6 HTTP/1.1 connections per origin; two screens running two players
// each would exhaust that budget and stall artwork and API calls. WebSockets use
// a separate, far larger pool.

const crypto = require('crypto');
const os = require('os');

const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

// How long a freshly-issued pairing token stays valid before first use. Once a
// phone has connected it stops expiring, so it can reconnect all evening.
const PAIR_TTL = Number(process.env.REMOTE_PAIR_TTL || 600) * 1000;
const STALE_SCREEN_MS = 60000; // drop screens that stop reporting

const sessions = new Map(); // sessionId -> session

function newSession(id) {
  const session = {
    id,
    token: null,
    tokenExpiresAt: 0,
    tokenUsed: false,
    label: 'Screen',
    state: null,
    screen: null, // the browser's socket
    remotes: new Set(), // phone sockets
    lastSeen: Date.now(),
  };
  sessions.set(id, session);
  return session;
}

function getSession(id, { create = false } = {}) {
  let s = sessions.get(id);
  if (!s && create) s = newSession(id);
  return s || null;
}

// -- addressing -------------------------------------------------------------
// "Look up the network IP" has several answers on a real machine: this one
// reports a Wi-Fi address, a VM bridge and a VPN tunnel. Only the first is
// reachable from a phone, so candidates are ranked rather than guessed.
function scoreInterface(name, address) {
  let score = 0;
  if (/^(en|eth|wl|wlan)/i.test(name)) score += 10; // physical LAN
  if (/^(utun|tun|tap|ppp|wg|ipsec)/i.test(name)) score -= 20; // VPN tunnel
  if (/^(bridge|vmnet|vboxnet|docker|veth|lxc)/i.test(name)) score -= 15; // virtual
  if (address.startsWith('192.168.')) score += 5;
  else if (address.startsWith('10.')) score += 2;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 1;
  return score;
}

function lanCandidates() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ host: a.address, label: `${a.address} (${name})`, score: scoreInterface(name, a.address) });
    }
  }
  out.sort((a, b) => b.score - a.score);

  // mDNS name last: it survives a DHCP change, but plenty of managed networks
  // block multicast DNS, so it's an alternative rather than the default.
  const hostname = os.hostname();
  const mdns = hostname.endsWith('.local') ? hostname : `${hostname}.local`;
  out.push({ host: mdns, label: `${mdns} (mDNS)`, score: -100 });
  return out;
}

// The address the desktop itself used is the best evidence of something the
// phone can reach too — unless it's loopback, which tells us nothing.
function hostFromRequest(req) {
  const host = String(req.hostname || '').trim();
  if (!host) return null;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return null;
  return host;
}

function buildUrls(req, port) {
  const candidates = [];
  const seen = new Set();
  const push = (host, label) => {
    if (!host || seen.has(host)) return;
    seen.add(host);
    candidates.push({ host, label, url: `http://${host}:${port}/remote` });
  };

  if (process.env.REMOTE_HOST) push(process.env.REMOTE_HOST, `${process.env.REMOTE_HOST} (REMOTE_HOST)`);
  push(hostFromRequest(req), `${hostFromRequest(req)} (this page's address)`);
  for (const c of lanCandidates()) push(c.host, c.label);
  return candidates;
}

// -- pairing ----------------------------------------------------------------
async function pair(req, res, port) {
  const sessionId = String(req.query.session || req.body?.session || '').trim();
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) {
    return res.status(400).json({ error: 'a valid session id is required' });
  }
  const session = getSession(sessionId, { create: true });

  // A fresh token each time the button is pressed, so a QR shown on a shared
  // screen earlier stops working.
  session.token = crypto.randomBytes(16).toString('hex');
  session.tokenExpiresAt = Date.now() + PAIR_TTL;
  session.tokenUsed = false;

  const urls = buildUrls(req, port);
  if (!urls.length) return res.status(500).json({ error: 'no reachable address found' });

  // The token rides in the fragment: fragments are never sent to a server, so
  // it stays out of access logs and Referer headers.
  const primary = `${urls[0].url}#s=${encodeURIComponent(sessionId)}&t=${session.token}`;
  let qrSvg = '';
  try {
    qrSvg = await QRCode.toString(primary, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch (err) {
    return res.status(500).json({ error: `could not build QR: ${err.message}` });
  }

  res.json({
    sessionId,
    url: primary,
    qrSvg,
    expiresAt: session.tokenExpiresAt,
    alternatives: urls.slice(1).map((u) => ({
      label: u.label,
      url: `${u.url}#s=${encodeURIComponent(sessionId)}&t=${session.token}`,
    })),
  });
}

// Re-render the QR for one of the alternative addresses, when the first one
// turns out to be unreachable from the phone.
async function qrFor(req, res) {
  const url = String(req.query.url || '');
  if (!/^https?:\/\/[^\s]{1,300}$/.test(url)) {
    return res.status(400).json({ error: 'bad url' });
  }
  try {
    const qrSvg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });
    res.json({ qrSvg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// -- relay ------------------------------------------------------------------
function send(ws, msg) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket went away mid-send */
    }
  }
}

function screenList() {
  const now = Date.now();
  return [...sessions.values()]
    .filter((s) => s.screen && now - s.lastSeen < STALE_SCREEN_MS)
    .map((s) => ({ id: s.id, label: s.label, online: true }));
}

function broadcastToRemotes(session, msg) {
  for (const ws of session.remotes) send(ws, msg);
}

// A screen's label is whatever it's showing — that's what makes a switcher
// meaningful when several screens are open.
function labelFor(state) {
  if (!state || !Array.isArray(state.players) || !state.players.length) return 'Screen';
  const names = state.players.map((p) => p.title || '(nothing)');
  return names.length > 1 ? `${names.length} players — ${names.join(' / ')}` : names[0];
}

function parse(data) {
  try {
    const msg = JSON.parse(String(data));
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

function attach(server, { path = '/ws' } = {}) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return socket.destroy();
    }
    if (!url.pathname.startsWith(path)) return; // not ours; leave it alone

    const role = url.pathname.slice(path.length).replace(/^\//, '');
    const sessionId = url.searchParams.get('s') || '';
    const token = url.searchParams.get('t') || '';
    if (role !== 'screen' && role !== 'remote') return socket.destroy();
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return socket.destroy();

    if (role === 'remote') {
      const session = getSession(sessionId);
      const valid =
        session &&
        session.token &&
        token &&
        token.length === session.token.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(session.token)) &&
        (session.tokenUsed || Date.now() < session.tokenExpiresAt);
      if (!valid) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._role = role;
      ws._sessionId = sessionId;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const role = ws._role;
    const session = getSession(ws._sessionId, { create: role === 'screen' });
    if (!session) return ws.close(4004, 'unknown session');

    if (role === 'screen') {
      // A reload produces a new socket for the same session; the old one is
      // already dead, so the newcomer takes over.
      if (session.screen && session.screen !== ws) {
        try {
          session.screen.close(4000, 'replaced');
        } catch {
          /* already gone */
        }
      }
      session.screen = ws;
      session.lastSeen = Date.now();
      broadcastToRemotes(session, { type: 'screen', online: true });
    } else {
      session.remotes.add(ws);
      session.tokenUsed = true; // stop the pairing token expiring under them
      // Bring the phone up to date immediately rather than waiting for a tick.
      send(ws, { type: 'state', state: session.state, label: session.label });
      send(ws, { type: 'screens', screens: screenList() });
      send(ws, { type: 'screen', online: !!session.screen });
    }

    ws.on('message', (data) => {
      const msg = parse(data);
      if (!msg) return;
      session.lastSeen = Date.now();

      if (role === 'screen') {
        if (msg.type === 'state') {
          session.state = msg.state || null;
          session.label = labelFor(session.state);
          broadcastToRemotes(session, { type: 'state', state: session.state, label: session.label });
        } else if (msg.type === 'ack') {
          broadcastToRemotes(session, { type: 'ack', name: msg.name, ok: msg.ok, error: msg.error });
        }
        return;
      }

      // From a phone: commands are forwarded verbatim; the screen decides what
      // it will honour, against its own whitelist.
      if (msg.type === 'cmd' && typeof msg.name === 'string') {
        if (!session.screen) return send(ws, { type: 'error', error: 'that screen is not connected' });
        send(session.screen, { type: 'cmd', name: msg.name, args: msg.args || {} });
      } else if (msg.type === 'screens') {
        send(ws, { type: 'screens', screens: screenList() });
      } else if (msg.type === 'ping') {
        send(ws, { type: 'pong' });
      }
    });

    ws.on('close', () => {
      if (role === 'screen') {
        if (session.screen === ws) {
          session.screen = null;
          broadcastToRemotes(session, { type: 'screen', online: false });
        }
      } else {
        session.remotes.delete(ws);
      }
      // Nothing left attached and nothing to control: forget the session.
      if (!session.screen && !session.remotes.size) sessions.delete(session.id);
    });
  });

  return wss;
}

module.exports = { pair, qrFor, attach, screenList, sessions };
