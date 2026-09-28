/* The Install fonts button.
 *
 * One press: every font in Adobe Fonts and Downloads that is not installed
 * yet goes into ~/Library/Fonts, where every app on the Mac can use it. The
 * work is the shell's; this only says what happened.
 */
(function (root) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var timer = null;

  function show(msg, notes, kind, sticky) {
    var box = $('toast');
    if (!box) return;
    clearTimeout(timer);
    box.innerHTML = '';
    box.className = kind || '';
    var line = document.createElement('span');
    line.className = 'msg';
    line.textContent = msg;
    box.appendChild(line);
    if (notes) {
      var n = document.createElement('span');
      n.className = 'notes';
      n.textContent = notes;
      box.appendChild(n);
    }
    if (!sticky) {
      var ok = document.createElement('button');
      ok.textContent = 'OK';
      ok.onclick = function () { box.hidden = true; };
      box.appendChild(ok);
      timer = setTimeout(function () { box.hidden = true; }, 12000);
    }
    box.hidden = false;
  }

  function list(items) {
    var names = items.map(function (f) { return f.font; });
    return names.length > 12
      ? names.slice(0, 12).join(', ') + ' and ' + (names.length - 12) + ' more'
      : names.join(', ');
  }

  function run() {
    var d = root.desktop, btn = $('installFonts');
    if (!d || !d.installFonts || !btn || btn.disabled) return Promise.resolve(null);
    btn.disabled = true;
    btn.classList.add('busy');
    show('Looking through Adobe Fonts and Downloads…', null, '', true);
    return d.installFonts({}).then(function (res) {
      btn.disabled = false;
      btn.classList.remove('busy');
      if (!res || res.error) {
        show('Could not install fonts', (res && res.error) || 'no answer from the app', 'failed');
        return res;
      }
      var n = res.installed.length;
      if (!n && !res.failed.length) {
        show('Every font is installed already',
          res.found + ' found in Adobe Fonts and Downloads, all of them already in your Fonts folder.');
      } else if (n) {
        show('Installed ' + n + ' font' + (n === 1 ? '' : 's') + '. Every app can use them now',
          list(res.installed) + (res.failed.length ? '. Could not install: ' + list(res.failed) : ''));
      } else {
        show('Could not install ' + res.failed.length + ' font' + (res.failed.length === 1 ? '' : 's'),
          list(res.failed) + ': ' + res.failed[0].error, 'failed');
      }
      return res;
    });
  }

  function start() {
    var btn = $('installFonts');
    if (!btn) return;
    // The browser build cannot write into a font folder.
    if (!root.desktop || !root.desktop.installFonts) { btn.hidden = true; return; }
    btn.onclick = function () { run(); };
  }

  root.FontSync = { start: start, run: run };
})(window);
