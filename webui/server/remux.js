// remux.js — play the half of the film catalogue browsers can't open.
//
// Roughly half the films are MKV or AVI, which no browser will touch. The video
// is H.264 throughout the catalogue, so this is a container swap rather than a
// re-encode: ffmpeg copies the video stream, converts audio only when it isn't
// already AAC, and writes fragmented MP4 to stdout. Measured at ~100x realtime,
// about half a second of CPU per minute of film.
//
// Seeking: a piped fMP4 stream has no byte-range mapping, so the client can't
// seek it natively. Instead the player restarts the stream at an offset
// (`?t=`), which ffmpeg turns into an input seek — the film's own duration comes
// from get_vod_info, so the UI can still show a real scrub bar.

const { spawn, execFile } = require('child_process');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const UA = process.env.IPTV_USER_AGENT || 'VLC/3.0.20 LibVLC/3.0.20';

// Browsers play AAC; AC3/EAC3/DTS need converting. Everything else about the
// file is passed through untouched.
const AUDIO_PASSTHROUGH = new Set(['aac']);

let ffmpegOk = null; // cached availability check

function available() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return new Promise((resolve) => {
    execFile(FFMPEG, ['-version'], { timeout: 5000 }, (err) => {
      ffmpegOk = !err;
      if (err) console.warn(`[remux] ${FFMPEG} not available — remuxing disabled`);
      resolve(ffmpegOk);
    });
  });
}

// -- inspection -------------------------------------------------------------
const inspectCache = new Map(); // url -> { at, data }
const INSPECT_TTL = 24 * 3600 * 1000;

function inspect(url) {
  const hit = inspectCache.get(url);
  if (hit && Date.now() - hit.at < INSPECT_TTL) return Promise.resolve(hit.data);

  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE,
      [
        '-v', 'error',
        '-user_agent', UA,
        '-show_entries', 'stream=index,codec_type,codec_name,channels:format=duration,format_name',
        '-of', 'json',
        url,
      ],
      { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe failed: ${err.message.split('\n')[0]}`));
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return reject(new Error('ffprobe returned unreadable output'));
        }
        const streams = parsed.streams || [];
        const v = streams.find((s) => s.codec_type === 'video') || null;
        const a = streams.find((s) => s.codec_type === 'audio') || null;
        const data = {
          format: (parsed.format?.format_name || '').split(',')[0],
          duration: Number(parsed.format?.duration) || null,
          video: v ? v.codec_name : null,
          audio: a ? a.codec_name : null,
          channels: a ? a.channels || null : null,
          // Audio is the only thing that ever needs re-encoding here.
          audioCopy: a ? AUDIO_PASSTHROUGH.has(a.codec_name) : false,
        };
        inspectCache.set(url, { at: Date.now(), data });
        resolve(data);
      }
    );
  });
}

// -- streaming --------------------------------------------------------------
function buildArgs(url, { start = 0, audioCopy = false }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', UA];

  // -ss before -i is an input seek: ffmpeg range-requests its way to the
  // nearest keyframe instead of decoding everything before it.
  if (start > 0) args.push('-ss', String(start));

  args.push('-i', url);

  // First video and audio track only. Films here carry up to a dozen subtitle
  // tracks, none of which belong in a fragmented MP4. `-map_chapters -1` is the
  // non-obvious one: MKV chapters survive `-sn` and the MP4 muxer writes them
  // as a text track, leaving a stray data stream in the output.
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_chapters', '-1');
  args.push('-c:v', 'copy');

  if (audioCopy) {
    args.push('-c:a', 'copy');
  } else {
    // Downmix to stereo: 5.1 AC3 is common here and browsers are happier with
    // two channels than with a surround AAC layout.
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }

  // Copying from mid-file leaves timestamps starting wherever the keyframe was;
  // rebase them so the browser sees a stream that starts at zero.
  args.push('-avoid_negative_ts', 'make_zero', '-fflags', '+genpts');
  args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof');
  args.push('-f', 'mp4', 'pipe:1');
  return args;
}

async function stream(url, { start = 0 }, clientReq, clientRes) {
  if (!(await available())) {
    clientRes.status(501).json({ error: 'ffmpeg is not installed on the server' });
    return;
  }

  let info;
  try {
    info = await inspect(url);
  } catch (err) {
    clientRes.status(502).json({ error: err.message });
    return;
  }

  const args = buildArgs(url, { start, audioCopy: info.audioCopy });
  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    // SIGKILL rather than SIGTERM: ffmpeg reading a stalled HTTP source can sit
    // in a blocking read and ignore a polite request to leave. Each live ffmpeg
    // holds one of the account's limited connections, so it has to go.
    ff.kill('SIGKILL');
  };
  clientReq.on('close', stop);
  clientRes.on('close', stop);

  clientRes.status(200);
  clientRes.setHeader('Content-Type', 'video/mp4');
  clientRes.setHeader('Cache-Control', 'no-store');
  // Explicitly not seekable by range — the player seeks by restarting at ?t=.
  clientRes.setHeader('Accept-Ranges', 'none');

  ff.stdout.pipe(clientRes);

  let errTail = '';
  ff.stderr.on('data', (d) => {
    errTail = (errTail + d.toString()).slice(-2000);
  });

  ff.on('error', (err) => {
    console.warn('[remux] spawn failed:', err.message);
    if (!clientRes.headersSent) clientRes.status(500).json({ error: err.message });
    else clientRes.end();
  });

  ff.on('close', (code) => {
    done = true;
    if (code && code !== 0 && code !== 255) {
      // 255 is ffmpeg's exit code when we kill it, which is the normal path
      // whenever a viewer seeks or closes the tab.
      console.warn(`[remux] ffmpeg exited ${code}: ${errTail.trim().split('\n').pop() || ''}`);
    }
    clientRes.end();
  });
}

module.exports = { available, inspect, stream };
