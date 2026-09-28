/* The fonts on this machine, from the renderer's side.
 *
 * The shell walks the folders and reads the names; this keeps that list,
 * fetches one font's bytes when it is chosen and parses them once. In the
 * plain web build there is no shell and no list, only fonts dropped onto the
 * page, which are parsed here and held for the session.
 */
(function (root) {
  'use strict';

  var index = [];          // the last list from the shell
  var added = [];          // web build: fonts parsed from dropped files
  var parsed = {};         // id -> opentype Font
  var pending = {};        // id -> Promise
  var listeners = [];

  var SOURCES = [
    ['adobe', 'Adobe Fonts'], ['downloads', 'Downloads'], ['added', 'Added'],
    ['user', 'Yours'], ['system', 'System']
  ];

  function desktop() {
    return root.desktop && root.desktop.listFonts ? root.desktop : null;
  }

  function sourceLabel(source) {
    for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i][0] === source) return SOURCES[i][1];
    return source || 'Other';
  }

  function sorted(list) {
    var rank = {};
    SOURCES.forEach(function (s, i) { rank[s[0]] = i; });
    return list.slice().sort(function (a, b) {
      var ra = rank[a.source] === undefined ? 9 : rank[a.source];
      var rb = rank[b.source] === undefined ? 9 : rank[b.source];
      if (ra !== rb) return ra - rb;
      return (a.full || '').localeCompare(b.full || '');
    });
  }

  function list(force) {
    var d = desktop();
    if (!d) return Promise.resolve(index);
    return d.listFonts(!!force).then(function (res) {
      if (!res || res.error) throw new Error((res && res.error) || 'no font list');
      index = sorted((res.fonts || []).concat(added));
      listeners.forEach(function (fn) { fn(index); });
      return index;
    });
  }

  function entries() { return index; }
  function onChange(fn) { listeners.push(fn); }
  function get(id) { return parsed[id] || null; }

  function parseBytes(bytes) {
    var ab = bytes instanceof ArrayBuffer ? bytes
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return root.opentype.parse(ab);
  }

  function load(id) {
    if (parsed[id]) return Promise.resolve(parsed[id]);
    if (pending[id]) return pending[id];
    var d = desktop();
    if (!d) return Promise.reject(new Error('no font ' + id));
    pending[id] = d.readFont(id).then(function (res) {
      if (!res || res.error) throw new Error((res && res.error) || 'could not read the font');
      var f = parseBytes(res.bytes);
      parsed[id] = f;
      delete pending[id];
      return f;
    }).catch(function (e) { delete pending[id]; throw e; });
    return pending[id];
  }

  /* opentype keeps names per platform in one version and flat in another. */
  function nameOf(font, key) {
    var n = font.names || {};
    var table = n.windows || n.macintosh || n.unicode || n;
    var v = table[key] || (n[key]);
    if (!v) return '';
    if (typeof v === 'string') return v;
    return v.en || v[Object.keys(v)[0]] || '';
  }

  /* A font file handed straight to the page. On the desktop it goes to the
   * shell to keep; in a browser it lives for the session. */
  function addFile(file) {
    return file.arrayBuffer().then(function (bytes) {
      var d = desktop();
      if (d && d.addFont) {
        return d.addFont(file.name, bytes).then(function (res) {
          if (!res || res.error) throw new Error((res && res.error) || 'could not add the font');
          return list(false).then(function () { return (res.fonts || [])[0] || null; });
        });
      }
      var f = parseBytes(bytes);
      var entry = {
        id: 'mem:' + (added.length + 1) + ':' + file.name,
        family: nameOf(f, 'fontFamily') || file.name, style: nameOf(f, 'fontSubfamily') || 'Regular',
        full: nameOf(f, 'fullName') || file.name, source: 'added', path: file.name
      };
      parsed[entry.id] = f;
      added.push(entry);
      index = sorted(index.concat([entry]));
      listeners.forEach(function (fn) { fn(index); });
      return entry;
    });
  }

  /* Something to start typing in: a plain sans everyone has, or failing that
   * whatever is first. */
  function pickDefault(list) {
    var want = /^(Helvetica Neue|Helvetica|Arial|Inter|SF Pro)$/i;
    var best = null;
    (list || []).forEach(function (e) {
      if (want.test(e.family) && /^(Regular|Bold)$/i.test(e.style) && (!best || e.style === 'Regular')) best = e;
    });
    return best || (list && list[0]) || null;
  }

  root.FontLib = {
    list: list, entries: entries, onChange: onChange, get: get, load: load,
    addFile: addFile, pickDefault: pickDefault, sourceLabel: sourceLabel, SOURCES: SOURCES
  };
})(window);
