/* The font index's parsers, on real files where the machine has them and on
 * bytes built here where it does not. */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const F = require('../electron/fonts.js');
const Z = require('../electron/zip.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? ' :: ' + detail : '')); }
}

/* ---------- a name table, built by hand ---------- */

function utf16be(s) {
  const b = Buffer.from(s, 'utf16le');
  return b.swap16();
}

function nameTable(records) {
  // records: [{ platform, enc, lang, id, text(Buffer) }]
  const head = Buffer.alloc(6 + records.length * 12);
  head.writeUInt16BE(0, 0);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(head.length, 4);
  const strings = [];
  let off = 0;
  records.forEach((r, i) => {
    const p = 6 + i * 12;
    head.writeUInt16BE(r.platform, p); head.writeUInt16BE(r.enc, p + 2);
    head.writeUInt16BE(r.lang, p + 4); head.writeUInt16BE(r.id, p + 6);
    head.writeUInt16BE(r.text.length, p + 8); head.writeUInt16BE(off, p + 10);
    strings.push(r.text); off += r.text.length;
  });
  return Buffer.concat([head].concat(strings));
}

console.log('\nname table');
(function () {
  const nt = nameTable([
    { platform: 1, enc: 0, lang: 0, id: 1, text: Buffer.from('MacName', 'latin1') },
    { platform: 3, enc: 1, lang: 0x409, id: 1, text: utf16be('Tenzen Sans') },
    { platform: 3, enc: 1, lang: 0x409, id: 2, text: utf16be('Bold') },
    { platform: 3, enc: 1, lang: 0x409, id: 4, text: utf16be('Tenzen Sans Bold') },
    { platform: 3, enc: 1, lang: 0x407, id: 1, text: utf16be('German name') }
  ]);
  const n = F.parseNameTable(nt);
  ok('windows english wins over mac roman and other languages', n && n.family === 'Tenzen Sans', JSON.stringify(n));
  ok('style and full name are read', n && n.style === 'Bold' && n.full === 'Tenzen Sans Bold');
  const mac = F.parseNameTable(nameTable([
    { platform: 1, enc: 0, lang: 0, id: 1, text: Buffer.from('OnlyMac', 'latin1') }
  ]));
  ok('mac roman is enough on its own', mac && mac.family === 'OnlyMac' && mac.style === 'Regular' && mac.full === 'OnlyMac', JSON.stringify(mac));
  ok('a table with nothing in it is no font', F.parseNameTable(nameTable([])) === null);
  ok('garbage is not a font', F.namesOf(Buffer.from('hello world, not a font at all')).length === 0);
})();

/* ---------- real files, where they are ---------- */

const ARIAL = '/System/Library/Fonts/Supplemental/Arial.ttf';
const HELV = '/System/Library/Fonts/Helvetica.ttc';

console.log('\nreal fonts');
(function () {
  if (!fs.existsSync(ARIAL)) { console.log('  (skipped: no Arial.ttf on this machine)'); return; }
  const buf = fs.readFileSync(ARIAL);
  const names = F.namesOf(buf);
  ok('a TrueType file names itself', names.length === 1 && names[0].family === 'Arial', JSON.stringify(names));
  ok('a single font extracts as itself', F.extractFromCollection(buf, 0) === buf);
  ok('a fixed cmap is still a font', F.namesOf(F.fixCmap(buf)).length === 1);
})();

(function () {
  if (!fs.existsSync(HELV)) { console.log('  (skipped: no Helvetica.ttc on this machine)'); return; }
  const buf = fs.readFileSync(HELV);
  const names = F.namesOf(buf);
  ok('a collection lists every face', names.length >= 2, names.length);
  ok('faces are told apart', new Set(names.map((n) => n.full)).size === names.length,
    names.map((n) => n.full).join(', '));
  const one = F.extractFromCollection(buf, 1);
  const tag = one.readUInt32BE(0);
  ok('an extracted face is a single font', tag === 0x00010000 || one.toString('latin1', 0, 4) === 'true' || one.toString('latin1', 0, 4) === 'OTTO');
  const again = F.namesOf(one);
  ok('the extracted face keeps its name', again.length === 1 && again[0].full === names[1].full,
    (again[0] && again[0].full) + ' vs ' + names[1].full);
  // Every table's bytes must land intact where the new directory says.
  const numTables = one.readUInt16BE(4);
  let intact = true;
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    const off = one.readUInt32BE(p + 8), len = one.readUInt32BE(p + 12);
    if (off + len > one.length) intact = false;
  }
  ok('every table fits inside the extracted file', intact && numTables > 5, numTables + ' tables');
  const fixed = F.fixCmap(one);
  const cm = (function () {
    const n = fixed.readUInt16BE(4);
    for (let i = 0; i < n; i++) {
      const p = 12 + i * 16;
      if (fixed.toString('latin1', p, p + 4) === 'cmap') return fixed.readUInt32BE(p + 8);
    }
    return -1;
  })();
  let unsupported = 0;
  if (cm >= 0) {
    const n = fixed.readUInt16BE(cm + 2);
    for (let i = 0; i < n; i++) {
      const off = fixed.readUInt32BE(cm + 4 + i * 8 + 4);
      const fmt = fixed.readUInt16BE(cm + off);
      if ([0, 4, 12, 14].indexOf(fmt) < 0) unsupported++;
    }
  }
  ok('the fixed cmap carries only formats the parser reads', cm >= 0 && unsupported === 0, unsupported + ' unsupported left');
  let threw = false;
  try { F.extractFromCollection(buf, 99); } catch (e) { threw = true; }
  ok('asking for a face that is not there throws', threw);
})();

/* ---------- zips, built here ---------- */

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  // files: [{ name, data, deflate }]
  const locals = [], centrals = [];
  let offset = 0;
  files.forEach((f) => {
    const name = Buffer.from(f.name, 'utf8');
    const data = f.deflate ? zlib.deflateRawSync(f.data) : f.data;
    const method = f.deflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt32LE(crc32(f.data), 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(crc32(f.data), 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, data);
    centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
  });
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, eocd]));
}

console.log('\nzip');
(function () {
  const a = Buffer.from('stored bytes, stored bytes, stored bytes');
  const b = Buffer.from('deflated bytes '.repeat(50));
  const z = makeZip([
    { name: 'Pack/Font Regular.otf', data: a },
    { name: 'Pack/Font Bold.otf', data: b, deflate: true },
    { name: 'Pack/', data: Buffer.alloc(0) }
  ]);
  const list = Z.entries(z);
  ok('every entry is listed', list.length === 3, list.length);
  ok('a folder entry is marked as one', list[2].dir === true);
  ok('a stored entry comes back intact', Z.extract(z, list[0]).equals(a));
  ok('a deflated entry comes back intact', Z.extract(z, list[1]).equals(b));
  ok('names come through as text', list[1].name === 'Pack/Font Bold.otf', list[1].name);
  let threw = false;
  try { Z.entries(Buffer.from('not a zip at all, not even close, really not')); } catch (e) { threw = true; }
  ok('something that is not a zip says so', threw);

  if (fs.existsSync(ARIAL)) {
    const arial = fs.readFileSync(ARIAL);
    const packed = makeZip([{ name: 'Arial/Arial.ttf', data: arial, deflate: true }]);
    const got = Z.extract(packed, Z.entries(packed)[0]);
    ok('a real font survives the round trip through a zip', got.equals(arial) && F.namesOf(got)[0].family === 'Arial');
  }
})();

console.log('\nwhere fonts live');
(function () {
  const r = F.roots('/tmp/ud');
  ok('Downloads is searched, with its zips', r.some((x) => x.source === 'downloads' && x.zips && /Downloads$/.test(x.dir)));
  ok('fonts added to the app have their own folder', r.some((x) => x.source === 'added' && x.dir === path.join('/tmp/ud', 'fonts')));
  ok('the user and system font folders are searched', r.filter((x) => x.source === 'user' || x.source === 'system').length >= 3);
  ok('Adobe Fonts live in the hidden livetype folder', /CoreSync\/plugins\/livetype$/.test(F.adobeDir()));
  ok('font ids tell files, zip entries and faces apart', F.fontId('/a.ttc', '', 2) !== F.fontId('/a.ttc', '', 0) && F.fontId('/p.zip', 'x.otf', 0) !== F.fontId('/p.zip', '', 0));
})();

console.log('\nfonts: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
