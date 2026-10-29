#!/usr/bin/env node
// mock-dlna-renderer.mjs — a fake DLNA TV for testing "Play on TV".
//
//   node dev/mock-dlna-renderer.mjs [--port 8098] [--no-redirects] [--lan-only] [--name "Mock TV"]
//
// Answers SSDP searches, serves a device description at /dmr (Samsung's
// path), and handles SetAVTransportURI / Play / Stop / GetTransportInfo. On
// Play it really downloads the stream and reports PLAYING once bytes flow,
// so a broken URL shows up as a failure. --no-redirects refuses 3xx answers,
// as some TVs do, and --lan-only refuses anything off the local network; both
// make the app fall back to its relay.
//
// From the Android emulator the TV is at http://10.0.2.2:8098/dmr. URLs the
// app hands over that point at 10.0.2.x (emulator addresses) are fetched from
// 127.0.0.1 instead; for the relay, forward its port first:
//   adb forward tcp:8765 tcp:8765

import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('--port', 8098));
const NAME = arg('--name', 'Mock TV');
const NO_REDIRECTS = process.argv.includes('--no-redirects');
const LAN_ONLY = process.argv.includes('--lan-only');
const isPrivate = (h) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(h);
const UDN = 'uuid:00000000-mock-dlna-0000-000000000001';

const lanIp =
  Object.values(os.networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address ||
  '127.0.0.1';

let state = 'NO_MEDIA_PRESENT';
let uri = '';
let fetchAbort = null;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const unescape = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, t) => xml.match(new RegExp(`<(?:\\w+:)?${t}>([\\s\\S]*?)</(?:\\w+:)?${t}>`))?.[1] ?? '';
// Credentials sit in the stream path; keep them out of the log.
const redact = (u) => u.replace(/\/live\/[^/]+\/[^/]+\//, '/live/<user>/<pass>/');

const description = () => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>${NAME}</friendlyName>
    <manufacturer>Mock Electronics</manufacturer>
    <modelName>DLNA-1</modelName>
    <UDN>${UDN}</UDN>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <controlURL>/upnp/control/RenderingControl1</controlURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <controlURL>/upnp/control/AVTransport1</controlURL>
      </service>
    </serviceList>
  </device>
</root>`;

const soap = (action, inner = '') => `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
<u:${action}Response xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">${inner}</u:${action}Response>
</s:Body></s:Envelope>`;

const fault = (code, desc) => `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>
<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>
<UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError>
</detail></s:Fault></s:Body></s:Envelope>`;

function stopFetch() {
  fetchAbort?.abort();
  fetchAbort = null;
}

async function startPlayback() {
  stopFetch();
  const ac = new AbortController();
  fetchAbort = ac;
  state = 'TRANSITIONING';
  const target = new URL(uri);
  if (LAN_ONLY && !isPrivate(target.hostname)) {
    log(`refusing ${target.hostname}: not on the LAN (--lan-only)`);
    state = 'STOPPED';
    return;
  }
  if (/^10\.0\.2\.\d+$/.test(target.hostname)) target.hostname = '127.0.0.1';
  try {
    const resp = await fetch(target, {
      redirect: NO_REDIRECTS ? 'manual' : 'follow',
      headers: { 'User-Agent': 'MockTV/1.0 DLNADOC/1.50' },
      signal: ac.signal,
    });
    const h = (k) => resp.headers.get(k) ?? '-';
    log(`GET ${redact(target.toString())} -> ${resp.status} type=${h('content-type')} transferMode=${h('transfermode.dlna.org')} contentFeatures=${h('contentfeatures.dlna.org')}`);
    if (resp.status >= 300 && resp.status < 400) {
      log('refusing redirect (--no-redirects)');
      state = 'STOPPED';
      return;
    }
    if (!resp.ok) {
      state = 'STOPPED';
      return;
    }
    let bytes = 0;
    let lastLog = Date.now();
    for await (const chunk of resp.body) {
      bytes += chunk.length;
      if (state === 'TRANSITIONING' && bytes > 64 * 1024) {
        state = 'PLAYING';
        log('PLAYING');
      }
      if (Date.now() - lastLog > 5000) {
        log(`received ${(bytes / 1e6).toFixed(1)} MB`);
        lastLog = Date.now();
      }
    }
    log('stream ended');
    state = 'STOPPED';
  } catch (e) {
    if (ac.signal.aborted) return;
    log('playback error:', e.message);
    state = 'STOPPED';
  }
}

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/dmr') {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.end(description());
      return;
    }
    if (req.method === 'POST' && req.url === '/upnp/control/AVTransport1') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const action = (req.headers.soapaction || '').replace(/"/g, '').split('#')[1];
        const reply = (xml, code = 200) => {
          res.writeHead(code, { 'Content-Type': 'text/xml; charset="utf-8"' });
          res.end(xml);
        };
        switch (action) {
          case 'SetAVTransportURI': {
            if (state === 'PLAYING' || state === 'TRANSITIONING') return reply(fault(705, 'Transport is locked'), 500);
            uri = unescape(tag(body, 'CurrentURI'));
            const meta = unescape(tag(body, 'CurrentURIMetaData'));
            log(`SetAVTransportURI ${redact(uri)}`);
            log(`  title="${tag(meta, 'dc:title')}" protocolInfo="${meta.match(/protocolInfo="([^"]*)"/)?.[1] ?? '-'}"`);
            state = 'STOPPED';
            return reply(soap(action));
          }
          case 'Play':
            log('Play');
            startPlayback();
            return reply(soap(action));
          case 'Stop':
            log('Stop');
            stopFetch();
            state = uri ? 'STOPPED' : 'NO_MEDIA_PRESENT';
            return reply(soap(action));
          case 'GetTransportInfo':
            return reply(soap(action,
              `<CurrentTransportState>${state}</CurrentTransportState>` +
              '<CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>'));
          default:
            return reply(fault(401, 'Invalid Action'), 500);
        }
      });
      return;
    }
    res.writeHead(404).end();
  })
  .listen(PORT, () => log(`mock TV "${NAME}" on http://${lanIp}:${PORT}/dmr${NO_REDIRECTS ? ' (refuses redirects)' : ''}${LAN_ONLY ? ' (LAN only)' : ''}`));

// SSDP: answer M-SEARCH for renderers.
const ssdp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
ssdp.on('message', (msg, rinfo) => {
  const text = msg.toString();
  if (!text.startsWith('M-SEARCH')) return;
  const st = text.match(/^ST:\s*(.+)$/im)?.[1]?.trim() ?? '';
  if (!/MediaRenderer|AVTransport|ssdp:all|upnp:rootdevice/.test(st)) return;
  const reply =
    'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nEXT:\r\n' +
    `LOCATION: http://${lanIp}:${PORT}/dmr\r\nSERVER: Mock/1 UPnP/1.0 MockTV/1\r\n` +
    `ST: ${st}\r\nUSN: ${UDN}::${st}\r\n\r\n`;
  ssdp.send(reply, rinfo.port, rinfo.address);
  log(`SSDP reply to ${rinfo.address}:${rinfo.port} for ${st}`);
});
ssdp.bind(1900, () => {
  try {
    ssdp.addMembership('239.255.255.250');
  } catch (e) {
    log('SSDP multicast join failed:', e.message);
  }
});
