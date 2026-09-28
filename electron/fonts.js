/* Install every font that is sitting on this machine but not installed.
 *
 * Fonts arrive in two places without being installed:
 *
 *   Adobe Fonts    Creative Cloud syncs them into a hidden folder under
 *                  CoreSync/plugins/livetype, filed by number. The .t, .w and
 *                  .r folders hold plain OpenType files; entitlements.xml
 *                  alongside says what each number is called. The .e folder
 *                  holds a wrapped form that is not OpenType and is not read.
 *   Downloads      Loose font files, and font files inside zips, which is how
 *                  a bought font arrives. Zips are read in place, never
 *                  unpacked onto the disk.
 *
 * Installing is what Font Book does for one user: the file goes into
 * ~/Library/Fonts and every app can use it. A font counts as installed when a
 * font with the same PostScript name is already in the user or system font
 * folders, so pressing the button twice installs nothing the second time, and
 * a pack that ships one face as both .otf and .ttf installs it once, as the
 * .otf. Nothing already there is ever overwritten.
 *
 * Names come from each font's own name table, read here without a library.
 * What is installed is cached against each file's size and modification time,
 * so only the first press reads a thousand font files.
 */
'use strict';

const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const zip = require('./zip.js');

const FONT_EXT = /\.(ttf|otf|ttc)$/i;     // what macOS installs
const ZIP_EXT = /\.zip$/i;
const MAX_FILE = 24 * 1024 * 1024;        // read whole; above this, the head only
const HEAD = 4 * 1024 * 1024;
const MAX_ZIP = 80 * 1024 * 1024;         // a font pack, not an archive of a shoot
const MAX_ENTRY = 24 * 1024 * 1024;

/* ---------- names, from the font itself ---------- */

function u16(b, o) { return b.readUInt16BE(o); }
function u32(b, o) { return b.readUInt32BE(o); }

function tableDirectory(buf, base) {
  if (base + 12 > buf.length) return {};
  const n = u16(buf, base + 4);
  const out = {};
  for (let i = 0; i < Math.min(n, 512); i++) {
    const p = base + 12 + i * 16;
    if (p + 16 > buf.length) break;
    out[buf.toString('latin1', p, p + 4)] = { offset: u32(buf, p + 8), length: u32(buf, p + 12) };
  }
  return out;
}

/* Family (1, or the typographic 16), style (2, or 17), full name (4),
 * PostScript name (6). Windows English first, then any Windows or Unicode
 * record, then Macintosh Roman. */
const WANTED = { 1: 1, 2: 1, 4: 1, 6: 1, 16: 1, 17: 1 };

function parseNameTable(nt) {
  if (nt.length < 6) return null;
  const count = u16(nt, 2), strBase = u16(nt, 4);
  const got = {};
  for (let i = 0; i < count; i++) {
    const r = 6 + i * 12;
    if (r + 12 > nt.length) break;
    const platform = u16(nt, r), enc = u16(nt, r + 2), lang = u16(nt, r + 4);
    const id = u16(nt, r + 6), len = u16(nt, r + 8), off = u16(nt, r + 10);
    if (!WANTED[id]) continue;
    const s = strBase + off;
    if (s + len > nt.length) continue;
    const score = platform === 3 && lang === 0x409 ? 4
      : platform === 3 ? 3 : platform === 0 ? 2 : platform === 1 && enc === 0 ? 1 : 0;
    if (!score || (got[id] && got[id].score >= score)) continue;
    let text;
    if (platform === 1) text = nt.toString('latin1', s, s + len);
    else text = Buffer.from(nt.subarray(s, s + (len & ~1))).swap16().toString('utf16le');
    text = text.replace(/\0/g, '').trim();
    if (text) got[id] = { score, text };
  }
  const g = (id) => (got[id] ? got[id].text : '');
  const family = g(16) || g(1);
  const style = g(17) || g(2) || 'Regular';
  const full = g(4) || (family + (style && style !== 'Regular' ? ' ' + style : ''));
  if (!family && !full) return null;
  return { family: family || full, style, full: full || family, postscript: g(6) };
}

function namesAt(buf, base) {
  const t = tableDirectory(buf, base).name;
  if (!t || t.offset + t.length > buf.length) return null;
  return parseNameTable(buf.subarray(t.offset, t.offset + t.length));
}

/* One file may hold one font or, as a collection, several. */
function namesOf(buf) {
  if (!buf || buf.length < 12) return [];
  const tag = buf.toString('latin1', 0, 4);
  if (tag === 'ttcf') {
    const out = [];
    for (let i = 0; i < Math.min(u32(buf, 8), 64); i++) {
      const nm = namesAt(buf, u32(buf, 12 + i * 4));
      if (nm) out.push(nm);
    }
    return out;
  }
  if (tag === 'OTTO' || tag === 'true' || u32(buf, 0) === 0x00010000) {
    const nm = namesAt(buf, 0);
    return nm ? [nm] : [];
  }
  return [];
}

/* What makes two fonts the same font. */
function keyOf(nm) {
  return String(nm.postscript || nm.full || '').toLowerCase().replace(/\s+/g, '');
}

/* ---------- where things are ---------- */

function places(env) {
  const e = env || {};
  const home = e.home || os.homedir();
  return {
    target: e.target || path.join(home, 'Library/Fonts'),
    downloads: e.downloads || path.join(home, 'Downloads'),
    adobe: e.adobe || path.join(home, 'Library/Application Support/Adobe/CoreSync/plugins/livetype'),
    system: e.system || ['/Library/Fonts', '/System/Library/Fonts']
  };
}

async function walk(dir, depth, onFile) {
  let list;
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of list) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (depth > 0) await walk(full, depth - 1, onFile); }
    else if (ent.isFile()) await onFile(full, ent.name);
  }
}

async function readHead(file, size) {
  if (size <= MAX_FILE) return fsp.readFile(file);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD);
    const r = await fh.read(buf, 0, HEAD, 0);
    return buf.subarray(0, r.bytesRead);
  } finally { await fh.close(); }
}

/* ---------- what is installed ---------- */

async function installedKeys(userData, P) {
  const cacheFile = path.join(userData, 'fonts-index.json');
  let cache = {};
  try { cache = JSON.parse(await fsp.readFile(cacheFile, 'utf8')).files || {}; } catch (e) { cache = {}; }
  const files = {};
  const keys = new Set();
  for (const dir of [P.target].concat(P.system)) {
    await walk(dir, 2, async (file, name) => {
      if (!FONT_EXT.test(name) && !/\.dfont$/i.test(name)) return;
      let st;
      try { st = await fsp.stat(file); } catch (e) { return; }
      const k = file + '|' + st.size + '|' + Math.round(st.mtimeMs);
      let names = cache[k];
      if (!names) {
        try { names = namesOf(await readHead(file, st.size)); } catch (e) { names = []; }
      }
      files[k] = names;
      names.forEach((nm) => { const key = keyOf(nm); if (key) keys.add(key); });
    });
  }
  try { await fsp.writeFile(cacheFile, JSON.stringify({ built: Date.now(), files })); } catch (e) { /* read only */ }
  return keys;
}

/* ---------- what is waiting ---------- */

function cleanName(name) {
  return String(name || '')
    .replace(/�/g, '')                   // an entry name in a legacy encoding
    .replace(/[\/\\:\u0000-\u001f]+/g, ' ')
    .replace(/^\.+/, '')                      // never a hidden file
    .replace(/\s+/g, ' ')
    .trim();
}

/* A file name worth keeping: the one the font came with when it reads
 * cleanly, otherwise the font's own full name. */
function fileNameFor(original, names, ext) {
  const base = String(original || '');
  if (base && base.indexOf('�') < 0 && !base.startsWith('.')) {
    const c = cleanName(base);
    if (c && FONT_EXT.test(c)) return c;
  }
  return (cleanName(names[0] && names[0].full) || 'Font') + ext;
}

async function candidates(P) {
  const out = [];

  // Adobe Fonts: the manifest says what each number is.
  let xml = '';
  try { xml = await fsp.readFile(path.join(P.adobe, '.c', 'entitlements.xml'), 'utf8'); } catch (e) { xml = ''; }
  for (const block of xml.split('<font>').slice(1)) {
    const pick = (tag) => {
      const m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(block);
      return m ? m[1].trim() : '';
    };
    const id = pick('id');
    if (!/^\d+$/.test(id)) continue;
    for (const sub of ['.t', '.w', '.r']) {
      let buf;
      try { buf = await fsp.readFile(path.join(P.adobe, sub, '.' + id + '.otf')); } catch (e) { continue; }
      const names = namesOf(buf);
      if (!names.length) break;
      const full = pick('fullName') || names[0].full;
      out.push({ source: 'Adobe Fonts', font: full, file: fileNameFor('', [{ full }], '.otf'),
                 names, bytes: buf });
      break;
    }
  }

  // Downloads: loose, and inside zips.
  await walk(P.downloads, 3, async (file, base) => {
    if (FONT_EXT.test(base)) {
      let st;
      try { st = await fsp.stat(file); } catch (e) { return; }
      if (st.size > MAX_FILE) return;
      let buf;
      try { buf = await fsp.readFile(file); } catch (e) { return; }
      const names = namesOf(buf);
      if (names.length) {
        out.push({ source: 'Downloads', font: names[0].full, names, bytes: buf,
                   file: fileNameFor(base, names, path.extname(base).toLowerCase()) });
      }
      return;
    }
    if (!ZIP_EXT.test(base)) return;
    let buf;
    try {
      if ((await fsp.stat(file)).size > MAX_ZIP) return;
      buf = await fsp.readFile(file);
    } catch (e) { return; }
    let list;
    try { list = zip.entries(buf); } catch (e) { return; }
    for (const ent of list) {
      if (ent.dir || !FONT_EXT.test(ent.name) || /(^|\/)__MACOSX\//.test(ent.name)) continue;
      if (ent.usize > MAX_ENTRY) continue;
      let data;
      try { data = zip.extract(buf, ent); } catch (e) { continue; }
      const names = namesOf(data);
      if (!names.length) continue;
      const inner = ent.name.split('/').pop();
      out.push({ source: 'Downloads', font: names[0].full, names, bytes: data,
                 file: fileNameFor(inner, names, path.extname(inner).toLowerCase()) });
    }
  });

  // Adobe first for its clean names, then .otf ahead of its .ttf twin.
  const rank = (c) => (c.source === 'Adobe Fonts' ? 0 : 1) * 10 + (/\.otf$/i.test(c.file) ? 0 : 1);
  return out.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map((x) => x.c);
}

/* ---------- the button ---------- */

async function writeFresh(dir, name, bytes) {
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 100; n++) {
    const file = path.join(dir, n === 1 ? name : stem + ' ' + n + ext);
    try {
      await fsp.writeFile(file, bytes, { flag: 'wx' });   // never over something already there
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('no free file name for ' + name);
}

async function install(userData, opts) {
  const o = opts || {};
  const P = places(o.env);
  const keys = await installedKeys(userData, P);
  const found = await candidates(P);
  const installed = [], failed = [];
  let already = 0;
  if (!o.dryRun) await fsp.mkdir(P.target, { recursive: true });
  for (const c of found) {
    const ks = c.names.map(keyOf).filter(Boolean);
    if (ks.length && ks.every((k) => keys.has(k))) { already++; continue; }
    try {
      const file = o.dryRun ? path.join(P.target, c.file) : await writeFresh(P.target, c.file, c.bytes);
      ks.forEach((k) => keys.add(k));
      installed.push({ font: c.font, file: path.basename(file), source: c.source });
    } catch (e) {
      failed.push({ font: c.font, error: e.message || String(e) });
    }
  }
  return { installed, already, failed, target: P.target, dryRun: !!o.dryRun,
           found: found.length };
}

module.exports = { install, namesOf, parseNameTable, keyOf, fileNameFor, places };
