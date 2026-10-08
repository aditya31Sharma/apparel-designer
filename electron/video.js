/* Video Editor: the main-process half.
 *
 * The editor page lives in src/video/ and only ever sees media through a small
 * loopback server started here. That server streams files the user picked (and
 * nothing else) with HTTP Range support, which <video> needs to seek, and with
 * the CORS/CORP headers the app's cross-origin isolation requires.
 *
 * Rendering is ffmpeg. The page sends a project (clips, overlays rendered to
 * PNG by the page itself, effect ranges, audio rows) and this file turns it into
 * one filter graph. ffmpeg, ffprobe and yt-dlp are found on the machine; they are
 * not bundled yet.
 */
'use strict';

const { ipcMain, dialog, app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
function tool(name) {
  for (const d of TOOL_DIRS) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* next */ }
  }
  return null;
}

const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.gif': 'image/gif'
};

const media = new Map();          // token -> absolute path
let port = 0;
let workDir = null;

function register(file) {
  for (const [t, p] of media) if (p === file) return t;
  const token = crypto.randomBytes(9).toString('hex') + path.extname(file).toLowerCase();
  media.set(token, file);
  return token;
}
const urlFor = (token) => `http://127.0.0.1:${port}/m/${token}`;

function startMediaServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Range'); res.writeHead(204); return res.end(); }
      const m = /^\/m\/([a-f0-9]{18}\.[a-z0-9]+)$/.exec(req.url.split('?')[0]);
      const file = m && media.get(m[1]);
      if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); return res.end(); }
      let stat;
      try { stat = fs.statSync(file); } catch (e) { res.writeHead(404); return res.end(); }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', type);
      const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const a = range[1] ? parseInt(range[1], 10) : 0;
        const b = range[2] ? Math.min(parseInt(range[2], 10), stat.size - 1) : stat.size - 1;
        if (a >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
        res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${stat.size}`, 'Content-Length': b - a + 1 });
        if (req.method === 'HEAD') return res.end();
        return fs.createReadStream(file, { start: a, end: b }).pipe(res);
      }
      res.writeHead(200, { 'Content-Length': stat.size });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port); });
  });
}

function probe(file) {
  return new Promise((resolve) => {
    const fp = tool('ffprobe');
    if (!fp) return resolve({});
    execFile(fp, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 8 << 20 }, (err, out) => {
      if (err) return resolve({});
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s) => s.codec_type === 'video');
        const a = (j.streams || []).find((s) => s.codec_type === 'audio');
        let fps = 24;
        if (v && v.r_frame_rate) { const [n, d] = v.r_frame_rate.split('/').map(Number); if (n && d) fps = n / d; }
        resolve({ duration: parseFloat(j.format && j.format.duration) || 0, width: v ? v.width : 0, height: v ? v.height : 0,
          fps, hasVideo: !!v, hasAudio: !!a });
      } catch (e) { resolve({}); }
    });
  });
}

async function describe(file) {
  const token = register(file);
  return { token, url: urlFor(token), path: file, name: path.basename(file), ...(await probe(file)) };
}

/* ---------- YouTube audio (same rules as the Social Media Master importer) ---------- */
function youtubeUrl(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.replace(/^\/|\/$/g, '').split('/');
  let id = '';
  if ((host === 'youtu.be' || host === 'www.youtu.be') && parts.length === 1) id = parts[0];
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else if (parts.length === 2 && ['shorts', 'live', 'embed'].includes(parts[0])) id = parts[1];
  }
  return /^[A-Za-z0-9_-]{11}$/.test(id) ? 'https://www.youtube.com/watch?v=' + id : null;
}

function importYoutube(raw) {
  return new Promise((resolve, reject) => {
    const url = youtubeUrl(raw);
    if (!url) return reject(new Error('Paste a YouTube video link, not a channel or playlist.'));
    const yt = tool('yt-dlp');
    if (!yt || !tool('ffmpeg')) return reject(new Error('YouTube import needs yt-dlp and ffmpeg (brew install yt-dlp ffmpeg).'));
    const dir = path.join(workDir, 'youtube', crypto.randomBytes(6).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    const args = ['--ignore-config', '--no-playlist', '--no-cache-dir', '--no-progress', '--socket-timeout', '10', '--retries', '1',
      '--max-filesize', '32M', '--match-filters', '!is_live & duration<=900', '-f', 'bestaudio/best', '--extract-audio',
      '--audio-format', 'mp3', '--audio-quality', '0', '--ffmpeg-location', path.dirname(tool('ffmpeg')),
      '--print', 'after_move:title', '-o', path.join(dir, 'audio.%(ext)s'), '--', url];
    let title = '', errText = '';
    const p = spawn(yt, args, { env: { ...process.env, PATH: TOOL_DIRS.join(':') + ':' + (process.env.PATH || '') } });
    const timer = setTimeout(() => { p.kill('SIGTERM'); }, 150000);
    p.stdout.on('data', (d) => { title += d.toString(); });
    p.stderr.on('data', (d) => { errText += d.toString(); });
    p.on('close', async (code) => {
      clearTimeout(timer);
      const out = path.join(dir, 'audio.mp3');
      if (code || !fs.existsSync(out)) return reject(new Error('YouTube could not provide this audio. Use a public video under 15 minutes.'));
      const clean = (title.trim().split('\n').pop() || 'YouTube audio').replace(/[\x00-\x1f/\\:*?"<>|]/g, '').slice(0, 120);
      const final = path.join(dir, clean + '.mp3');
      try { fs.renameSync(out, final); } catch (e) { /* keep audio.mp3 */ }
      resolve(await describe(fs.existsSync(final) ? final : out));
    });
  });
}

/* ---------- render ---------- */
const num = (x, d = 0) => (Number.isFinite(+x) ? +x : d);
const f3 = (x) => num(x).toFixed(3);

/* Speed for a clip: constant, or a linear ramp from speed to speedEnd across the
 * clip. A ramp is rendered as eight constant-speed steps, which reads as a ramp
 * and keeps the audio in step. Returns the pieces in source time. */
function speedPieces(c) {
  const a = num(c.in), b = num(c.out), s0 = num(c.speed, 1), s1 = c.ramp ? num(c.speedEnd, s0) : s0;
  if (!c.ramp || Math.abs(s1 - s0) < 1e-3) return [{ a, b, s: s0 }];
  const N = 8, out = [];
  for (let i = 0; i < N; i++) out.push({ a: a + (b - a) * i / N, b: a + (b - a) * (i + 1) / N, s: s0 + (s1 - s0) * (i + 0.5) / N });
  return out;
}
function atempoChain(s) {
  const parts = []; let r = s;
  while (r > 2) { parts.push(2); r /= 2; }
  while (r < 0.5) { parts.push(0.5); r /= 0.5; }
  parts.push(r);
  return parts.map((x) => 'atempo=' + x.toFixed(4)).join(',');
}

function buildGraph(P, overlayFiles) {
  const W = num(P.width, 1080), H = num(P.height, 1920), FPS = num(P.fps, 30);
  const inputs = []; const fc = []; let n = 0;
  const addInput = (file, extra) => { inputs.push(...(extra || []), '-i', file); return n++; };
  const vlab = []; const alab = [];
  let total = 0;
  (P.clips || []).forEach((c, ci) => {
    const file = media.get(c.token);
    if (!file) return;
    const ix = addInput(file);
    speedPieces(c).forEach((pc, pi) => {
      const L = `c${ci}_${pi}`;
      const dur = (pc.b - pc.a) / pc.s;
      let v = `[${ix}:v]trim=start=${f3(pc.a)}:end=${f3(pc.b)},setpts=(PTS-STARTPTS)/${pc.s.toFixed(4)},fps=${FPS},` +
        `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
      const g = c.grade || {};
      if (g.exposure || g.contrast || g.saturation || g.gamma)
        v += `,eq=brightness=${f3(num(g.exposure) * 0.25)}:contrast=${f3(1 + num(g.contrast))}:saturation=${f3(1 + num(g.saturation))}`;
      // motion: zoom runs across the whole clip, so each speed piece takes its share of the ramp
      const zf = Math.max(1, num(c.zoomFrom, 1)), zt = Math.max(1, num(c.zoomTo, 1)), np = speedPieces(c).length;
      if (zf !== 1 || zt !== 1) {
        const zs = zf + (zt - zf) * pi / np, ze = zf + (zt - zf) * (pi + 1) / np, N = Math.max(1, Math.round(dur * FPS));
        const px = Math.max(-1, Math.min(1, num(c.panX))), py = Math.max(-1, Math.min(1, num(c.panY)));
        v += `,zoompan=z='${f3(zs)}+(${f3(ze)}-${f3(zs)})*on/${N}':x='(iw-iw/zoom)/2*(1+${f3(px)})':y='(ih-ih/zoom)/2*(1+${f3(py)})':d=1:s=${W}x${H}:fps=${FPS}`;
      }
      v += ',format=yuv420p';
      const first = pi === 0, last = pi === speedPieces(c).length - 1;
      if (first && num(c.fadeIn) > 0) v += `,fade=t=in:st=0:d=${f3(c.fadeIn)}`;
      if (last && num(c.fadeOut) > 0) v += `,fade=t=out:st=${f3(Math.max(0, dur - num(c.fadeOut)))}:d=${f3(c.fadeOut)}`;
      fc.push(v + `[v${L}]`); vlab.push(`[v${L}]`);
      const vol = c.muted ? 0 : num(c.volume, 1);
      if (c.hasAudio)
        fc.push(`[${ix}:a]atrim=start=${f3(pc.a)}:end=${f3(pc.b)},asetpts=PTS-STARTPTS,${atempoChain(pc.s)},aformat=sample_rates=48000:channel_layouts=stereo,volume=${vol},apad,atrim=0:${f3(dur)}[a${L}]`);
      else
        fc.push(`anullsrc=r=48000:cl=stereo,atrim=0:${f3(dur)}[a${L}]`);
      alab.push(`[a${L}]`);
      total += dur;
    });
  });
  if (!vlab.length) throw new Error('Add at least one video clip to the timeline.');
  fc.push(vlab.map((v, i) => v + alab[i]).join('') + `concat=n=${vlab.length}:v=1:a=1[vcat][acat]`);
  let cur = '[vcat]';
  const step = (expr) => { const L = `[x${fc.length}]`; fc.push(cur + expr + L); cur = L; };
  const E = (fx) => `enable='between(t,${f3(fx.start)},${f3(fx.end)})'`;

  // timeline effects
  (P.effects || []).filter((fx) => fx.on !== false).forEach((fx) => {
    if (fx.type === 'bw') {
      const L = `[bw${fc.length}]`, S = `[bs${fc.length}]`;
      fc.push(`${cur}split${S}${L}`);
      const out = `[bo${fc.length}]`;
      fc.push(`${L}hue=s=0,eq=contrast=${f3(num(fx.amount, 2))}${out}`);
      const mix = `[bm${fc.length}]`; fc.push(`${S}${out}overlay=${E(fx)}${mix}`); cur = mix;
    } else if (fx.type === 'blur') {
      const r = Math.max(1, Math.round(num(fx.amount, 8)));
      step(`boxblur=luma_radius=${r}:luma_power=2:chroma_radius=${Math.max(1, r >> 1)}:${E(fx)}`);
    } else if (fx.type === 'grade') {
      step(`eq=brightness=${f3(num(fx.exposure) * 0.25)}:contrast=${f3(1 + num(fx.contrast))}:saturation=${f3(1 + num(fx.saturation))}:${E(fx)}`);
    } else if (fx.type === 'grain') {
      step(`noise=c0s=${Math.round(num(fx.amount, 0.5) * 40)}:c0f=t+u:${E(fx)}`);
    } else if (fx.type === 'fade' || fx.type === 'white') {
      const blk = `[fb${fc.length}]`;
      fc.push(`color=c=${fx.type === 'white' ? 'white' : 'black'}:s=${W}x${H}:r=${FPS}:d=${f3(total)},format=rgba,colorchannelmixer=aa=${f3(num(fx.amount, 1))}${blk}`);
      const mix = `[fm${fc.length}]`; fc.push(`${cur}${blk}overlay=${E(fx)}${mix}`); cur = mix;
    }
  });

  // overlays: text and images arrive as full-frame transparent PNGs drawn by the page
  (overlayFiles || []).forEach((o) => {
    const ix = addInput(o.file, ['-loop', '1', '-t', f3(total)]);
    const fi = num(o.fadeIn), fo = num(o.fadeOut);
    let src = `[${ix}:v]format=rgba,scale=${W}:${H}`;
    if (fi > 0) src += `,fade=t=in:st=${f3(o.start)}:d=${f3(fi)}:alpha=1`;
    if (fo > 0) src += `,fade=t=out:st=${f3(Math.max(o.start, o.end - fo))}:d=${f3(fo)}:alpha=1`;
    const L = `[ov${fc.length}]`; fc.push(src + L);
    const mix = `[om${fc.length}]`; fc.push(`${cur}${L}overlay=0:0:${E(o)}${mix}`); cur = mix;
  });
  fc.push(`${cur}format=yuv420p,trim=0:${f3(total)}[vout]`);

  // audio: clip audio plus the music and sfx rows
  const am = ['[acat]'];
  (P.audio || []).filter((a) => a.on !== false && media.get(a.token)).forEach((a, ai) => {
    const ix = addInput(media.get(a.token));
    const len = Math.max(0.05, Math.min(num(a.length, total), total - num(a.at)));
    let ch = `[${ix}:a]atrim=start=${f3(a.from)}:duration=${f3(len)},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo,volume=${f3(num(a.volume, 1))}`;
    if (num(a.fadeIn) > 0) ch += `,afade=t=in:d=${f3(a.fadeIn)}`;
    if (num(a.fadeOut) > 0) ch += `,afade=t=out:st=${f3(Math.max(0, len - num(a.fadeOut)))}:d=${f3(a.fadeOut)}`;
    const mu = a.muffle;
    if (mu && mu.on && num(mu.intensity) > 0) {
      const fq = Math.round(20000 * Math.pow(300 / 20000, num(mu.intensity)));
      const s = num(mu.start) - num(a.at), e = num(mu.end) - num(a.at);
      const xf = `(clip((t-${f3(s)})/0.15,0,1)*clip((${f3(e)}-t)/0.15,0,1))`;
      ch += `,asplit=2[mc${ai}][mw${ai}];[mc${ai}]volume='1-${xf}':eval=frame[mcc${ai}];[mw${ai}]lowpass=f=${fq}:p=2,volume='${xf}':eval=frame[mww${ai}];[mcc${ai}][mww${ai}]amix=inputs=2:duration=first:normalize=0`;
    }
    const ms = Math.round(num(a.at) * 1000);
    fc.push(ch + `,adelay=${ms}|${ms}[au${ai}]`); am.push(`[au${ai}]`);
  });
  fc.push(am.join('') + `amix=inputs=${am.length}:duration=first:normalize=0,alimiter=limit=0.95,apad,atrim=0:${f3(total)}[aout]`);
  return { inputs, graph: fc.join(';'), total };
}

let rendering = null;
async function render(win, P, overlays) {
  if (typeof P === 'string') P = JSON.parse(P);
  if (typeof overlays === 'string') overlays = JSON.parse(overlays);
  const ff = tool('ffmpeg');
  if (!ff) throw new Error('Rendering needs ffmpeg (brew install ffmpeg).');
  const dir = path.join(workDir, 'render', crypto.randomBytes(5).toString('hex'));
  await fsp.mkdir(dir, { recursive: true });
  const ovFiles = [];
  for (let i = 0; i < (overlays || []).length; i++) {
    const o = overlays[i]; const f = path.join(dir, `ov${i}.png`);
    await fsp.writeFile(f, Buffer.from(o.png, typeof o.png === 'string' ? 'base64' : undefined));
    ovFiles.push({ ...o, file: f });
  }
  const { inputs, graph, total } = buildGraph(P, ovFiles);
  const name = (P.name || 'Tenzen video').replace(/[\\/:*?"<>|]/g, '') + ' ' + new Date().toTimeString().slice(0, 8).replace(/:/g, '-') + '.mp4';
  const out = path.join(app.getPath('downloads'), name);
  const args = ['-y', '-v', 'error', '-progress', 'pipe:1', ...inputs, '-filter_complex', graph, '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(num(P.crf, 17)), '-pix_fmt', 'yuv420p', '-r', String(num(P.fps, 30)),
    '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-t', f3(total), out];
  await fsp.writeFile(path.join(dir, 'command.txt'), [ff, ...args].join('\n'));
  return new Promise((resolve, reject) => {
    const p = spawn(ff, args); rendering = p; let err = '';
    p.stdout.on('data', (d) => {
      const m = /out_time_ms=(\d+)/.exec(d.toString());
      if (m && win && !win.isDestroyed()) win.webContents.send('video:progress', Math.min(1, (+m[1] / 1e6) / total));
    });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('close', (code) => {
      rendering = null;
      if (code) return reject(new Error(err.trim().split('\n').slice(-3).join(' ') || 'Render failed'));
      resolve({ path: out, name });
    });
  });
}

function init(getWin) {
  workDir = path.join(app.getPath('userData'), 'video');
  fs.mkdirSync(workDir, { recursive: true });
  const ready = startMediaServer();

  ipcMain.handle('video:status', async () => {
    await ready;
    return { ffmpeg: !!tool('ffmpeg'), ffprobe: !!tool('ffprobe'), ytdlp: !!tool('yt-dlp'), port };
  });
  ipcMain.handle('video:pick', async (_e, kind) => {
    await ready;
    const filters = kind === 'audio'
      ? [{ name: 'Audio', extensions: ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac', 'mp4', 'mov'] }]
      : kind === 'image'
        ? [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif'] }]
        : [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm'] }];
    const res = await dialog.showOpenDialog(getWin(), { properties: ['openFile', 'multiSelections'], filters });
    if (res.canceled) return [];
    return Promise.all(res.filePaths.map(describe));
  });
  ipcMain.handle('video:youtube', async (_e, url) => { await ready; return importYoutube(url); });
  ipcMain.handle('video:project:save', async (_e, json) => {
    await fsp.writeFile(path.join(workDir, 'project.json'), json); return true;
  });
  ipcMain.handle('video:project:load', async () => {
    await ready;
    try {
      const P = JSON.parse(await fsp.readFile(path.join(workDir, 'project.json'), 'utf8'));
      // re-register every file the project points at so its tokens work again
      const fix = async (item) => { if (item && item.path && fs.existsSync(item.path)) { const d = await describe(item.path); item.token = d.token; item.url = d.url; } };
      for (const c of P.clips || []) await fix(c);
      for (const a of P.audio || []) await fix(a);
      for (const o of P.overlays || []) if (o.kind === 'image') await fix(o);
      return P;
    } catch (e) { return null; }
  });
  ipcMain.handle('video:render', async (_e, P, overlays) => render(getWin(), P, overlays));
  ipcMain.handle('video:cancel', () => { if (rendering) rendering.kill('SIGTERM'); return true; });
  ipcMain.handle('video:reveal', (_e, file) => { shell.showItemInFolder(file); return true; });
}

module.exports = { init, buildGraph, speedPieces, youtubeUrl };
