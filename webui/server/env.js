// env.js — tiny zero-dependency .env loader.
//
// Loads KEY=VALUE lines from `webui/.env` into process.env (without overwriting
// anything already set), so local config (provider URL, credentials, the path
// to an IPTV app's localStorage) lives outside the committed code. Required
// first in index.js, before anything reads process.env.

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', '.env');

try {
  if (fs.existsSync(file)) {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
} catch (err) {
  console.warn('[env] could not read .env:', err.message);
}
