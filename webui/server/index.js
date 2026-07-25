// index.js — Express API + static frontend host.
//
// Endpoints:
//   GET /api/health              -> { ok, credentials }
//   GET /api/channels?q=&force=  -> [{ id, name }]  (live channels, AND-matched)
//   GET /api/stream/live/:id     -> proxied .ts stream (credentials hidden)
//   GET /api/account?force=      -> { user, server, fetchedAt }  (no password)
//   GET /api/movies?q=&category= -> { total, items }  (film catalogue search)
//   GET /api/movies/categories   -> [{ id, name, count }]
//   GET /api/movies/:id          -> full film metadata
//   GET /api/movies/:id/playback -> { container, playable, reason, size }
//   GET /api/stream/movie/:id    -> proxied film (byte-range capable)
//   GET /api/poster?u=           -> proxied poster image
//   GET /api/refresh             -> force-refresh catalogue cache
//   /                            -> static frontend (../public)

require('./env'); // load .env into process.env before anything reads it
const path = require('path');
const express = require('express');
const iptv = require('./iptv');
const vod = require('./vod');

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');

app.get('/api/health', (req, res) => {
  res.json({ ok: true, credentials: iptv.hasCredentials() });
});

app.get('/api/channels', async (req, res) => {
  try {
    const channels = await iptv.getChannels(req.query.q || '', {
      force: req.query.force === '1',
      limit: Number(req.query.limit || 200),
    });
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/account', async (req, res) => {
  try {
    const account = await iptv.getAccount({ force: req.query.force === '1' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(account);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream/live/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^0-9]/g, '');
  if (!id) return res.status(400).json({ error: 'invalid stream id' });
  iptv.proxyStream(id, req, res);
});

// -- films ------------------------------------------------------------------
// `/categories` is declared before `/:id` so it isn't swallowed by it.
app.get('/api/movies/categories', async (req, res) => {
  try {
    res.json(await vod.getCategories({ force: req.query.force === '1' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/movies', async (req, res) => {
  try {
    const num = (v) => (v === undefined || v === '' ? null : Number(v));
    res.json(
      await vod.searchMovies({
        q: req.query.q || '',
        category: req.query.category || '',
        yearFrom: num(req.query.yearFrom),
        yearTo: num(req.query.yearTo),
        sort: req.query.sort || 'added',
        limit: Math.min(Number(req.query.limit) || 60, 200),
        offset: Number(req.query.offset) || 0,
        force: req.query.force === '1',
      })
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/movies/:id(\\d+)', async (req, res) => {
  try {
    res.json(await vod.getMovie(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/movies/:id(\\d+)/playback', async (req, res) => {
  try {
    res.json(await vod.probeMovie(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stream/movie/:id(\\d+)', (req, res) => {
  try {
    iptv.proxyFrom(vod.movieUrl(req.params.id, req.query.ext || 'vod'), req, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Posters come from the provider's CDN. Proxying them keeps the principle the
// rest of the app follows — the browser only ever talks to this server — and
// stops the film artwork leaking who's browsing what to a third party.
app.get('/api/poster', async (req, res) => {
  const raw = String(req.query.u || '');
  let url;
  try {
    url = new URL(raw);
  } catch {
    return res.status(400).json({ error: 'bad poster url' });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return res.status(400).json({ error: 'unsupported protocol' });
  }
  try {
    const up = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!up.ok) return res.status(502).end();
    const type = up.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return res.status(415).end();
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await up.arrayBuffer()));
  } catch {
    res.status(502).end();
  }
});

app.get('/api/refresh', async (req, res) => {
  try {
    await iptv.refreshCatalogue();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, HOST, () => {
  console.log(`iptv player-grid listening on http://localhost:${PORT}`);
  console.log(`  credentials: ${iptv.hasCredentials() ? 'OK' : 'MISSING'}`);
  console.log(`  cache dir:   ${iptv.CACHE_DIR}`);
});
