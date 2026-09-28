/* The font installer: names read from real files, zips read in place, and
 * the install itself run against temporary folders, never the real ones. */
'use strict';

const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const path = require('path');
const F = require('../electron/fonts.js');
const Z = require('../electron/zip.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? ' :: ' + detail : '')); }
}

function utf16be(s) { return Buffer.from(s, 'utf16le').swap16(); }

function nameTable(records) {
  const head = Buffer.alloc(6 + records.length * 12);
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
  const n = F.parseNameTable(nameTable([
    { platform: 1, enc: 0, lang: 0, id: 1, text: Buffer.from('MacName', 'latin1') },
    { platform: 3, enc: 1, lang: 0x409, id: 1, text: utf16be('Tenzen Sans') },
    { platform: 3, enc: 1, lang: 0x409, id: 2, text: utf16be('Bold') },
    { platform: 3, enc: 1, lang: 0x409, id: 4, text: utf16be('Tenzen Sans Bold') },
    { platform: 3, enc: 1, lang: 0x409, id: 6, text: utf16be('TenzenSans-Bold') }
  ]));
  ok('windows english wins over mac roman', n && n.family === 'Tenzen Sans', JSON.stringify(n));
  ok('full and postscript names are read', n && n.full === 'Tenzen Sans Bold' && n.postscript === 'TenzenSans-Bold');
  ok('two fonts are the same font by postscript name', F.keyOf(n) === 'tenzensans-bold');
  ok('garbage is not a font', F.namesOf(Buffer.from('hello world, not a font at all')).length === 0);
})();

const ARIAL = '/System/Library/Fonts/Supplemental/Arial.ttf';
const ARIALB = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const HELV = '/System/Library/Fonts/Helvetica.ttc';

console.log('\nreal fonts');
(function () {
  if (fs.existsSync(ARIAL)) {
    const names = F.namesOf(fs.readFileSync(ARIAL));
    ok('a TrueType file names itself', names.length === 1 && names[0].family === 'Arial', JSON.stringify(names));
  }
  if (fs.existsSync(HELV)) {
    const names = F.namesOf(fs.readFileSync(HELV));
    ok('a collection lists every face', names.length >= 2, names.length);
  }
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
    lh.writeUInt16LE(name.length, 26);
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
  let threw = false;
  try { Z.entries(Buffer.from('not a zip at all, not even close, really not')); } catch (e) { threw = true; }
  ok('something that is not a zip says so', threw);
})();

/* ---------- the install, against temporary folders ---------- */

console.log('\ninstall');
(async function () {
  if (!fs.existsSync(ARIAL) || !fs.existsSync(ARIALB)) {
    console.log('  (skipped: no Arial on this machine)');
    return finish();
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-fonts-'));
  const env = {
    home: root,
    target: path.join(root, 'Library/Fonts'),
    downloads: path.join(root, 'Downloads'),
    adobe: path.join(root, 'livetype'),
    system: []                                   // nothing counts as installed but the target
  };
  const ud = path.join(root, 'userData');
  fs.mkdirSync(ud, { recursive: true });
  fs.mkdirSync(path.join(env.downloads, 'Packs'), { recursive: true });
  fs.mkdirSync(path.join(env.adobe, '.c'), { recursive: true });
  fs.mkdirSync(path.join(env.adobe, '.t'), { recursive: true });
  fs.mkdirSync(path.join(env.adobe, '.e'), { recursive: true });

  const arial = fs.readFileSync(ARIAL), bold = fs.readFileSync(ARIALB);
  // A pack with the same face twice, as .otf and .ttf, plus the junk a Mac zip carries.
  fs.writeFileSync(path.join(env.downloads, 'Packs', 'arial-pack.zip'), makeZip([
    { name: 'Arial/Arial.otf', data: arial, deflate: true },
    { name: 'Arial/Arial.ttf', data: arial, deflate: true },
    { name: '__MACOSX/Arial/._Arial.ttf', data: Buffer.from('resource fork') },
    { name: 'Arial/readme.txt', data: Buffer.from('thanks for buying') }
  ]));
  // Adobe Fonts: the manifest names the number, the file is hidden.
  fs.writeFileSync(path.join(env.adobe, '.c', 'entitlements.xml'),
    '<typekitSyncState><fonts type="array"><font><id>7</id><properties>' +
    '<fullName>Test Sans Bold</fullName><familyName>Test Sans</familyName>' +
    '</properties></font><font><id>8</id><properties><fullName>Not Synced</fullName>' +
    '</properties></font></fonts></typekitSyncState>');
  fs.writeFileSync(path.join(env.adobe, '.t', '.7.otf'), bold);
  fs.writeFileSync(path.join(env.adobe, '.e', '.7'), Buffer.from('wrapped, not a font'));
  // The same bold face loose in Downloads: one font, however many copies.
  fs.writeFileSync(path.join(env.downloads, 'Arial Bold.ttf'), bold);

  const dry = await F.install(ud, { env, dryRun: true });
  ok('a dry run writes nothing', dry.dryRun && !fs.existsSync(env.target), JSON.stringify(dry.installed));
  ok('a dry run says what it would install', dry.installed.length === 2, dry.installed.map((f) => f.file).join(', '));

  const first = await F.install(ud, { env });
  const files = fs.readdirSync(env.target).sort();
  ok('each font installs once, however many copies there are', first.installed.length === 2 && files.length === 2,
    files.join(', '));
  ok('an Adobe font gets its real name, not its hidden number',
    files.indexOf('Test Sans Bold.otf') >= 0 && files.every((f) => !f.startsWith('.')), files.join(', '));
  ok('the .otf of a pair is the one installed', files.indexOf('Arial.otf') >= 0 && files.indexOf('Arial.ttf') < 0,
    files.join(', '));
  ok('zip junk and the wrapped Adobe form are ignored', first.failed.length === 0 && first.found === 4,
    'found ' + first.found);
  ok('installed bytes are the font', fs.readFileSync(path.join(env.target, 'Arial.otf')).equals(arial));

  const second = await F.install(ud, { env });
  ok('pressing it again installs nothing', second.installed.length === 0 && second.already === 4,
    JSON.stringify({ installed: second.installed.length, already: second.already }));
  ok('and nothing was written twice', fs.readdirSync(env.target).length === 2);

  // A different font under a file name that is taken: kept apart, never overwritten.
  fs.writeFileSync(path.join(env.target, 'Clash.ttf'), bold);
  fs.writeFileSync(path.join(env.downloads, 'Clash.ttf'), arial);
  fs.unlinkSync(path.join(env.target, 'Arial.otf'));
  const third = await F.install(ud, { env });
  ok('a taken file name is never overwritten',
    fs.readFileSync(path.join(env.target, 'Clash.ttf')).equals(bold) &&
    third.installed.length === 1 && fs.existsSync(path.join(env.target, third.installed[0].file)),
    JSON.stringify(third.installed));

  const sys = F.places({ home: '/Users/x' });
  ok('the real target is the user Fonts folder', sys.target === '/Users/x/Library/Fonts');
  ok('Adobe Fonts are read from the hidden livetype folder', /CoreSync\/plugins\/livetype$/.test(sys.adobe));
  ok('system fonts count as installed', sys.system.indexOf('/System/Library/Fonts') >= 0);

  fs.rmSync(root, { recursive: true, force: true });
  finish();
})().catch((e) => { failed++; console.log('  FAIL install threw :: ' + (e.stack || e)); finish(); });

function finish() {
  console.log('\nfonts: ' + passed + ' passed, ' + failed + ' failed');
  if (failed) process.exitCode = 1;
}
