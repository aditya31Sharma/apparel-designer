/* Every font on this machine, and the bytes of any one of them.
 *
 * The renderer cannot see the filesystem, and Electron does not expose the
 * browser's local font query, so the shell walks the places fonts live and
 * hands back a list: family, style, where it came from, and an id to ask for
 * the file by. The list is built once and cached against each file's size and
 * modification time, so a rescan after the first costs a directory walk.
 *
 * Four places, in the order they are worth showing:
 *
 *   Adobe Fonts    Creative Cloud syncs them into a hidden folder under
 *                  CoreSync/plugins/livetype, filed by number. The names are
 *                  in entitlements.xml alongside; the OpenType files sit in
 *                  the .t, .w and .r folders. The .e folder holds the same
 *                  fonts in a wrapped form that is not an OpenType file, so
 *                  it is not read.
 *   Downloads      Loose font files, and font files inside zips, which is
 *                  how a bought font arrives. Zips are read in place.
 *   Yours          ~/Library/Fonts, and anything dropped onto the app, which
 *                  is copied into the app's own fonts folder.
 *   System         /Library/Fonts and /System/Library/Fonts, including the
 *                  Supplemental set.
 *
 * Names come from the font's own name table, read here without any library:
 * the table directory, the name records, the strings. A collection (.ttc)
 * holds several fonts; each is listed on its own and handed out as a file of
 * its own, since the outline parser reads single fonts only.
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const zip = require('./zip.js');

const FONT_EXT = /\.(ttf|otf|ttc|woff)$/i;
const ZIP_EXT = /\.zip$/i;
const MAX_FILE = 24 * 1024 * 1024;       // read whole; above this, the head only
const HEAD = 4 * 1024 * 1024;
const MAX_ZIP = 80 * 1024 * 1024;        // a font pack, not an archive of a shoot
const MAX_ENTRY = 24 * 1024 * 1024;

/* ---------- the name table ---------- */

function u16(b, o) { return b.readUInt16BE(o); }
function u32(b, o) { return b.readUInt32BE(o); }

/* Table directory of one sfnt whose offset table starts at `base`. */
function tableDirectory(buf, base) {
  if (base + 12 > buf.length) return {};
  const n = u16(buf, base + 4);
  const out = {};
  for (let i = 0; i < Math.min(n, 512); i++) {
    const p = base + 12 + i * 16;
    if (p + 16 > buf.length) break;
    const tag = buf.toString('latin1', p, p + 4);
    out[tag] = { offset: u32(buf, p + 8), length: u32(buf, p + 12) };
  }
  return out;
}

/* The name records that matter: family (1, or the typographic 16), style
 * (2, or 17), full name (4), PostScript name (6). Windows English first,
 * then any Windows or Unicode record, then Macintosh Roman. */
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

/* WOFF wraps the same tables, each one deflated on its own. */
function namesWoff(buf) {
  if (buf.length < 44) return null;
  const n = u16(buf, 12);
  for (let i = 0; i < Math.min(n, 512); i++) {
    const p = 44 + i * 20;
    if (p + 20 > buf.length) break;
    if (buf.toString('latin1', p, p + 4) !== 'name') continue;
    const off = u32(buf, p + 4), comp = u32(buf, p + 8), orig = u32(buf, p + 12);
    if (off + comp > buf.length) return null;
    const raw = buf.subarray(off, off + comp);
    try {
      return parseNameTable(comp < orig ? zlib.inflateSync(raw) : raw);
    } catch (e) { return null; }
  }
  return null;
}

/* One file may hold one font or, as a collection, several. */
function namesOf(buf) {
  if (!buf || buf.length < 12) return [];
  const tag = buf.toString('latin1', 0, 4);
  if (tag === 'ttcf') {
    const n = u32(buf, 8);
    const out = [];
    for (let i = 0; i < Math.min(n, 64); i++) {
      const off = u32(buf, 12 + i * 4);
      const nm = namesAt(buf, off);
      if (nm) out.push(Object.assign({ index: i }, nm));
    }
    return out;
  }
  if (tag === 'wOFF') {
    const nm = namesWoff(buf);
    return nm ? [Object.assign({ index: 0 }, nm)] : [];
  }
  if (tag === 'OTTO' || tag === 'true' || tag === 'typ1' || u32(buf, 0) === 0x00010000) {
    const nm = namesAt(buf, 0);
    return nm ? [Object.assign({ index: 0 }, nm)] : [];
  }
  return [];
}

/* Pull one font out of a collection as a file of its own. The tables keep
 * their bytes; only the directory is rewritten so the offsets point into the
 * new file rather than the old one. */
function extractFromCollection(buf, index) {
  if (buf.toString('latin1', 0, 4) !== 'ttcf') return buf;
  const n = u32(buf, 8);
  if (!(index >= 0 && index < n)) throw new Error('no font ' + index + ' in this collection');
  const base = u32(buf, 12 + index * 4);
  const numTables = u16(buf, base + 4);
  const head = Buffer.alloc(12 + numTables * 16);
  buf.copy(head, 0, base, base + 12);
  let dataOffset = head.length;
  const chunks = [head];
  for (let i = 0; i < numTables; i++) {
    const p = base + 12 + i * 16, q = 12 + i * 16;
    buf.copy(head, q, p, p + 8);
    const off = u32(buf, p + 8), len = u32(buf, p + 12);
    if (off + len > buf.length) throw new Error('collection table runs past the file');
    head.writeUInt32BE(dataOffset, q + 8);
    head.writeUInt32BE(len, q + 12);
    const padded = (len + 3) & ~3;
    const chunk = Buffer.alloc(padded);
    buf.copy(chunk, 0, off, off + len);
    chunks.push(chunk);
    dataOffset += padded;
  }
  return Buffer.concat(chunks);
}

/* The outline parser reads cmap subtables of formats 0, 4, 12 and 14 and
 * throws on any other, and Apple's system fonts lead with a format 6 table on
 * the Unicode platform, so a Helvetica every app on the machine can use would
 * fail to load. Drop the records it cannot read; the ones it can read are
 * there behind them. The subtables stay where they are, only the record
 * list at the head of the table shrinks, so this is a copy with a few bytes
 * rewritten. Checksums go stale, and nothing that reads the result checks
 * them. */
const CMAP_OK = { 0: 1, 4: 1, 12: 1, 14: 1 };

function fixCmap(buf) {
  const t = tableDirectory(buf, 0).cmap;
  if (!t || t.offset + 4 > buf.length) return buf;
  const c = t.offset, n = u16(buf, c + 2);
  const keep = [];
  for (let i = 0; i < Math.min(n, 64); i++) {
    const r = c + 4 + i * 8;
    if (r + 8 > buf.length) break;
    const off = u32(buf, r + 4);
    if (c + off + 2 > buf.length) continue;
    if (CMAP_OK[u16(buf, c + off)]) keep.push(Buffer.from(buf.subarray(r, r + 8)));
  }
  if (keep.length === n || !keep.length) return buf;
  const out = Buffer.from(buf);
  out.writeUInt16BE(keep.length, c + 2);
  keep.forEach((rec, i) => rec.copy(out, c + 4 + i * 8));
  return out;
}

/* ---------- where fonts live ---------- */

function adobeDir() {
  return path.join(os.homedir(), 'Library/Application Support/Adobe/CoreSync/plugins/livetype');
}

function roots(userData) {
  const home = os.homedir();
  return [
    { source: 'downloads', dir: path.join(home, 'Downloads'), depth: 3, zips: true },
    { source: 'added', dir: path.join(userData, 'fonts'), depth: 1 },
    { source: 'user', dir: path.join(home, 'Library/Fonts'), depth: 2 },
    { source: 'system', dir: '/Library/Fonts', depth: 2 },
    { source: 'system', dir: '/System/Library/Fonts', depth: 2 }
  ];
}

function fontId(file, zipEntry, index) {
  return [file, zipEntry || '', index || 0].join('|');
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

async function walk(dir, depth, onFile) {
  let list;
  try { list = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of list) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (depth > 0) await walk(full, depth - 1, onFile);
    } else if (ent.isFile()) {
      await onFile(full, ent.name);
    }
  }
}

/* Adobe Fonts: names from the entitlements manifest, files by number. */
async function adobeFonts(cache) {
  const dir = adobeDir();
  let xml;
  try { xml = await fsp.readFile(path.join(dir, '.c', 'entitlements.xml'), 'utf8'); } catch (e) { return []; }
  const out = [];
  const blocks = xml.split('<font>').slice(1);
  for (const b of blocks) {
    const pick = (tag) => {
      const m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(b);
      return m ? m[1].trim() : '';
    };
    const id = pick('id');
    if (!id) continue;
    let file = null;
    for (const sub of ['.t', '.w', '.r']) {
      const cand = path.join(dir, sub, '.' + id + '.otf');
      try { const st = await fsp.stat(cand); if (st.size > 100) { file = { path: cand, st }; break; } } catch (e) { /* not here */ }
    }
    if (!file) continue;                       // entitled but not synced yet
    const family = pick('familyName'), style = pick('variationName') || 'Regular';
    const full = pick('fullName') || (family + ' ' + style);
    out.push({
      id: fontId(file.path, '', 0), family, style, full, source: 'adobe',
      path: file.path, index: 0, zipEntry: '', mtime: file.st.mtimeMs
    });
  }
  return out;
}

/* ---------- the index ---------- */

function indexPath(userData) { return path.join(userData, 'fonts-index.json'); }

async function build(userData, force) {
  let cache = {};
  if (!force) {
    try { cache = JSON.parse(await fsp.readFile(indexPath(userData), 'utf8')).files || {}; } catch (e) { cache = {}; }
  }
  const files = {};
  const fonts = [];

  function keep(key, names, source, file, zipEntry, mtime) {
    files[key] = names;
    names.forEach((nm) => {
      fonts.push({
        id: fontId(file, zipEntry, nm.index), family: nm.family, style: nm.style,
        full: nm.full, postscript: nm.postscript || '', source, path: file,
        index: nm.index || 0, zipEntry: zipEntry || '', mtime
      });
    });
  }

  for (const root of roots(userData)) {
    await walk(root.dir, root.depth || 1, async (file, name) => {
      const isFont = FONT_EXT.test(name), isZip = root.zips && ZIP_EXT.test(name);
      if (!isFont && !isZip) return;
      let st;
      try { st = await fsp.stat(file); } catch (e) { return; }
      if (isFont) {
        const key = file + '|' + st.size + '|' + Math.round(st.mtimeMs);
        if (cache[key]) { keep(key, cache[key], root.source, file, '', st.mtimeMs); return; }
        try {
          const names = namesOf(await readHead(file, st.size));
          keep(key, names, root.source, file, '', st.mtimeMs);
        } catch (e) { /* not a font after all */ }
        return;
      }
      if (st.size > MAX_ZIP) return;
      let buf;
      try { buf = await fsp.readFile(file); } catch (e) { return; }
      let list;
      try { list = zip.entries(buf); } catch (e) { return; }
      for (const ent of list) {
        if (ent.dir || !FONT_EXT.test(ent.name) || /(^|\/)__MACOSX\//.test(ent.name)) continue;
        if (ent.usize > MAX_ENTRY) continue;
        const key = file + '!' + ent.name + '|' + st.size + '|' + Math.round(st.mtimeMs);
        if (cache[key]) { keep(key, cache[key], root.source, file, ent.name, st.mtimeMs); continue; }
        try {
          keep(key, namesOf(zip.extract(buf, ent)), root.source, file, ent.name, st.mtimeMs);
        } catch (e) { /* a broken entry is not a font */ }
      }
    });
  }

  const adobe = await adobeFonts();
  const all = adobe.concat(fonts);
  const index = { built: Date.now(), files, fonts: all };
  try { await fsp.writeFile(indexPath(userData), JSON.stringify(index)); } catch (e) { /* read only */ }
  return index;
}

let last = null;

async function list(userData, force) {
  if (!last || force) last = await build(userData, force);
  return { built: last.built, fonts: last.fonts };
}

/* The bytes of one font, as a single OpenType file whatever it came out of. */
async function read(userData, id) {
  if (!last) last = await build(userData, false);
  let entry = last.fonts.find((f) => f.id === id);
  if (!entry) {
    last = await build(userData, true);
    entry = last.fonts.find((f) => f.id === id);
  }
  if (!entry) throw new Error('no such font');
  let buf = await fsp.readFile(entry.path);
  if (entry.zipEntry) {
    const ent = zip.entries(buf).find((e) => e.name === entry.zipEntry);
    if (!ent) throw new Error('the zip no longer holds that font');
    buf = zip.extract(buf, ent);
  }
  buf = fixCmap(extractFromCollection(buf, entry.index || 0));
  return { name: entry.full, bytes: buf };
}

/* A font dropped on the app, kept in the app's own folder so it is there
 * next time. */
async function add(userData, name, bytes) {
  const buf = Buffer.from(bytes);
  const names = namesOf(buf);
  if (!names.length) throw new Error('that is not a font file this can read');
  const dir = path.join(userData, 'fonts');
  await fsp.mkdir(dir, { recursive: true });
  const safe = String(name || 'font').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'font';
  const file = path.join(dir, safe);
  await fsp.writeFile(file, buf);
  last = await build(userData, false);
  return last.fonts.filter((f) => f.path === file);
}

module.exports = {
  list, read, add, namesOf, parseNameTable, extractFromCollection, fixCmap,
  adobeDir, roots, fontId
};
