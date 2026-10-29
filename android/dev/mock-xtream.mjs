#!/usr/bin/env node
// mock-xtream.mjs — a fake Xtream Codes portal for testing the app without a
// real subscription. Test login: username "test", password "test".
//
//   node dev/mock-xtream.mjs [port]      (default 8099)
//
// From the Android emulator the host is http://10.0.2.2:<port>. Streams are
// real live MPEG-TS from ffmpeg's test source, served through a 302 to an
// "edge" path, as real portals do. Needs ffmpeg with libx264.

import http from 'node:http';
import { spawn } from 'node:child_process';

const PORT = Number(process.argv[2] || 8099);
const USER = 'test';
const PASS = 'test';

const CATEGORIES = ['UK | Entertainment', 'UK | News', 'UK | Sport', 'US | Movies', 'Kids'];
const CHANNELS = [];
let id = 1000;
for (const [ci, cat] of CATEGORIES.entries()) {
  const tag = cat.split(' ')[0];
  for (let n = 1; n <= 40; n++) {
    CHANNELS.push({
      num: CHANNELS.length + 1,
      name: `${tag}: ${cat.split('| ').pop()} ${n}${n % 3 ? '' : ' HD'}`,
      stream_type: 'live',
      stream_id: id++, // a number here, a string in some portals
      stream_icon: '',
      epg_channel_id: null,
      category_id: String(ci + 1),
    });
  }
}
CHANNELS[0].name = 'UK: BBC One HD';
CHANNELS[1].name = 'UK: BBC Two';
CHANNELS[2].stream_id = String(CHANNELS[2].stream_id);

function json(res, body, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function api(req, res, url) {
  const q = url.searchParams;
  const ok = q.get('username') === USER && q.get('password') === PASS;
  if (!ok) return json(res, { user_info: { auth: 0 } });
  switch (q.get('action')) {
    case null:
      return json(res, {
        user_info: {
          username: USER,
          password: PASS, // real portals echo it too; the app must drop it
          auth: 1,
          status: 'Active',
          exp_date: String(Math.floor(Date.now() / 1000) + 30 * 86400),
          max_connections: '2',
          active_cons: '0',
        },
        server_info: {
          url: req.headers.host.split(':')[0],
          port: String(PORT),
          https_port: '443',
          server_protocol: 'http',
          timezone: 'Europe/London',
        },
      });
    case 'get_live_categories':
      return json(res, CATEGORIES.map((name, i) => ({ category_id: String(i + 1), category_name: name, parent_id: 0 })));
    case 'get_live_streams':
      return json(res, CHANNELS);
    default:
      return json(res, []);
  }
}

// Each stream is a live ffmpeg encode, killed when the client goes away.
function stream(req, res, sid) {
  const hue = (Number(sid) * 47) % 360;
  const ff = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
    '-f', 'lavfi', '-i', `sine=frequency=${300 + (Number(sid) % 10) * 50}`,
    '-vf', `hue=h=${hue}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '50',
    '-c:a', 'aac', '-b:a', '96k', '-f', 'mpegts', 'pipe:1',
  ]);
  res.writeHead(200, { 'Content-Type': 'video/mp2t' });
  ff.stdout.pipe(res);
  ff.stderr.on('data', (d) => process.stderr.write(`[ffmpeg ${sid}] ${d}`));
  const stop = () => ff.kill('SIGKILL');
  req.on('close', stop);
  res.on('close', stop);
  console.log(`stream ${sid} start`);
  ff.on('exit', () => console.log(`stream ${sid} end`));
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    console.log(req.method, url.pathname, `ua=${req.headers['user-agent']}`);
    if (url.pathname === '/player_api.php') return api(req, res, url);

    const live = url.pathname.match(/^\/live\/([^/]+)\/([^/]+)\/(\d+)\.ts$/);
    if (live) {
      if (decodeURIComponent(live[1]) !== USER || decodeURIComponent(live[2]) !== PASS) {
        res.writeHead(403).end();
        return;
      }
      if (live[3] === '1039') { // one channel that is always "offline"
        res.writeHead(404).end();
        return;
      }
      res.writeHead(302, { Location: `/edge/${live[3]}.ts?token=abc` }).end();
      return;
    }
    const edge = url.pathname.match(/^\/edge\/(\d+)\.ts$/);
    if (edge && req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' }).end();
      return;
    }
    if (edge) return stream(req, res, edge[1]);

    res.writeHead(404).end();
  })
  .listen(PORT, () => console.log(`mock Xtream on http://localhost:${PORT} (emulator: http://10.0.2.2:${PORT})`));
