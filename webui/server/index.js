// index.js — Express API + static frontend host.
//
// Endpoints:
//   GET /api/health              -> { ok, credentials }
//   GET /api/channels?q=&force=  -> [{ id, name }]  (live channels, AND-matched)
//   GET /api/stream/live/:id     -> proxied .ts stream (credentials hidden)
//   GET /api/worldcup?force=     -> { matches, groups, errors, fetchedAt }
//   GET /api/refresh             -> force-refresh catalogue cache
//   /                            -> static frontend (../public)

require('./env'); // load .env into process.env before anything reads it
const path = require('path');
const express = require('express');
const iptv = require('./iptv');

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

app.get('/api/stream/live/:id', (req, res) => {
  const id = String(req.params.id).replace(/[^0-9]/g, '');
  if (!id) return res.status(400).json({ error: 'invalid stream id' });
  iptv.proxyStream(id, req, res);
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
