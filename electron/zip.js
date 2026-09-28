/* Reading a zip, enough to get a font out of one.
 *
 * Fonts arrive in Downloads as zips, and a zip's table of contents lives at
 * its end: the central directory, found from the end-of-central-directory
 * record. Each entry there says where its local header is; the data follows
 * that header, after a name and an extra field whose lengths only the local
 * header knows. Node has the inflater; the rest is forty lines of offsets.
 *
 * Plain Node, no dependency, no shelling out to unzip: an entry whose name is
 * not valid UTF-8 (one of the packs here has an accent in a legacy encoding)
 * cannot be asked for by name from a command line, and by offset it can.
 */
'use strict';

const zlib = require('zlib');

const EOCD = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;

function entries(buf) {
  // The record is at least 22 bytes from the end, before a comment of at
  // most 65535 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    // Bit 11 of the flags says the name is UTF-8; otherwise it is whatever
    // the zipper felt like. Decode as UTF-8 with replacement either way: the
    // name is a label to show, the offset is the key.
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    out.push({ name, method, csize, usize, offset, dir: name.endsWith('/') });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function extract(buf, entry) {
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOCAL) throw new Error('bad local header');
  const nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nlen + xlen;
  const data = buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return zlib.inflateRawSync(data);
  throw new Error('unsupported zip method ' + entry.method);
}

module.exports = { entries, extract };
