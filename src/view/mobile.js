/* The phone shape of the same tool.
 *
 * Nothing here touches the document, the engine or the exporter. It rearranges
 * the same DOM the desktop uses, because two interfaces over one engine is two
 * things to keep in step, and the panels are generated from specs anyway: the
 * rows that appear down the right on a desktop are the rows that appear in the
 * sheet on a phone, built by the same code from the same spec.
 *
 * What it does change is the three things a finger needs and a mouse does not:
 * the panel comes up from the bottom where a thumb reaches, the tool tabs move
 * into the sheet so switching tool and changing its settings are in one place,
 * and saving goes through the share sheet, because a phone has no Downloads
 * folder to put a file in.
 */
(function (root) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* Coarse pointer, not narrow window: a small window on a desktop still has a
   * mouse and should keep the interface built for one. The width test is there
   * for the tablet case, where a side panel still fits and is still better. */
  function isPhone() {
    // A way to see the phone interface on a desktop, for screenshots and for
    // driving it from a test harness. Nothing reads it but those two.
    if (root.location && /[?&]phone\b/.test(root.location.search)) return true;
    return root.matchMedia &&
      root.matchMedia('(pointer: coarse)').matches &&
      root.matchMedia('(max-width: 900px)').matches;
  }

  /* ---------- the sheet ---------- */

  var STATES = ['peek', 'half', 'full'];
  var sheet = null, parts = null, state = 'peek';

  function setState(next) {
    state = next;
    sheet.classList.remove('half', 'full');
    if (next !== 'peek') sheet.classList.add(next);
  }

  /* How much of the sheet stays on screen at rest is whatever its head turns
   * out to be once the fonts have settled, not a number guessed in the
   * stylesheet that stops being true the moment a button grows a line. The
   * measurement goes back into --peek, which is what positions the sheet and
   * what keeps the canvas clear of it. */
  function measure() {
    if (!parts || !parts.head) return;
    document.body.style.setProperty('--peek', parts.head.offsetHeight + 'px');
  }

  function peekHeight() {
    return parts && parts.head ? parts.head.offsetHeight : 150;
  }

  function offsetFor(name) {
    var h = sheet.offsetHeight;
    if (name === 'full') return 0;
    if (name === 'half') return Math.max(0, h - Math.min(root.innerHeight * 0.46, 420));
    return Math.max(0, h - peekHeight());
  }

  function buildSheet() {
    var aside = document.querySelector('aside');
    if (!aside) return null;

    var head = document.createElement('div');
    head.className = 'sheet-head';

    var grip = document.createElement('div');
    grip.className = 'grip';
    head.appendChild(grip);

    // The tool tabs belong with the settings they change, not in a bar at the
    // other end of the screen.
    var tools = document.querySelector('header .tools');
    if (tools) head.appendChild(tools);

    // The save buttons come up here too. They live at the foot of the panel on
    // a desktop, which on a sheet means below the fold: reachable only after
    // dragging the sheet open, for the action people came to perform.
    var foot = document.querySelector('aside .foot');
    if (foot) head.appendChild(foot);

    aside.insertBefore(head, aside.firstChild);
    return { aside: aside, head: head };
  }

  function wireDrag(parts) {
    var head = parts.head;
    var startY = 0, startOffset = 0, moved = false, dragging = false;

    head.addEventListener('pointerdown', function (e) {
      // Let the tool buttons be buttons.
      if (e.target.closest('.tool')) return;
      dragging = true; moved = false;
      startY = e.clientY;
      startOffset = offsetFor(state);
      sheet.classList.add('dragging');
      head.setPointerCapture(e.pointerId);
    });

    head.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      var dy = e.clientY - startY;
      if (Math.abs(dy) > 4) moved = true;
      var max = offsetFor('peek');
      // A little give past the ends, so the sheet feels attached to the finger
      // rather than stuck.
      var y = Math.max(-24, Math.min(max + 40, startOffset + dy));
      sheet.style.transform = 'translateY(' + y + 'px)';
    });

    function release(e) {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('dragging');
      sheet.style.transform = '';

      if (!moved) {                       // a tap on the grip
        setState(state === 'peek' ? 'half' : 'peek');
        return;
      }
      // Land on whichever stop the sheet ended up nearest.
      var y = Math.max(0, startOffset + (e.clientY - startY));
      var best = 'peek', bestGap = Infinity;
      STATES.forEach(function (name) {
        var gap = Math.abs(offsetFor(name) - y);
        if (gap < bestGap) { bestGap = gap; best = name; }
      });
      setState(best);
    }

    head.addEventListener('pointerup', release);
    head.addEventListener('pointercancel', release);
  }

  /* ---------- saving, through the share sheet ---------- */

  /* A phone has nowhere to download a file to. navigator.share hands it to the
   * system instead, which is how it reaches Files, AirDrop, or an app. */
  function shareFile(name, body, type) {
    var file;
    try {
      file = new File([body], name, { type: type });
    } catch (e) {
      return Promise.resolve(false);
    }
    if (!root.navigator.canShare || !navigator.canShare({ files: [file] })) {
      return Promise.resolve(false);
    }
    return navigator.share({ files: [file], title: name })
      .then(function () { return true; })
      // Dismissing the sheet is a decision, not a failure to be retried.
      .catch(function (err) { return err && err.name === 'AbortError'; });
  }

  function baseName() {
    var L = root.App && root.App.selected();
    return ((L && L.name) || 'artwork').replace(/\.(svg|png|jpe?g|webp|avif)$/i, '');
  }

  /* SVG is what this tool makes, but an SVG on a phone is a file you cannot
   * look at, let alone post. So the same artwork also goes out as a PNG,
   * rasterised from that very SVG so the two cannot disagree. */
  var PNG_MAX = 2048;

  function svgToPng(text) {
    return new Promise(function (resolve, reject) {
      var blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || 1000, h = img.naturalHeight || 1000;
        var k = Math.min(1, PNG_MAX / Math.max(w, h));
        var c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k));
        c.height = Math.max(1, Math.round(h * k));
        var g = c.getContext('2d');
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (out) {
          if (out) resolve(out); else reject(new Error('could not draw the PNG'));
        }, 'image/png');
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('could not read the artwork back as an image'));
      };
      img.src = url;
    });
  }

  function say(msg) {
    var err = $('err');
    if (!err) return;
    err.textContent = msg;
    err.classList.add('on');
    setTimeout(function () { err.classList.remove('on'); }, 4000);
  }

  function wireSaving() {
    var save = $('download'), plates = $('separations'), copy = $('copy');

    save.onclick = function () {
      var text = root.App.svgText(false);
      shareFile(baseName() + '-apparel.svg', text, 'image/svg+xml').then(function (ok) {
        if (!ok) say('Sharing was refused. Open this on a desktop to save the file.');
      });
    };

    plates.onclick = function () {
      var text = root.App.svgText(true);
      shareFile(baseName() + '-separations.svg', text, 'image/svg+xml').then(function (ok) {
        if (!ok) say('Sharing was refused. Open this on a desktop to save the file.');
      });
    };

    // Copy is a desktop idea. On a phone the useful second export is a picture
    // you can actually look at and post, so the button becomes that.
    copy.innerHTML = '';
    copy.dataset.icon = 'image';
    copy.dataset.iconDone = '';
    var label = document.createElement('span');
    label.textContent = 'PNG';
    copy.appendChild(label);
    copy.removeAttribute('data-tip');
    copy.onclick = function () {
      copy.disabled = true;
      svgToPng(root.App.svgText(false))
        .then(function (blob) {
          return shareFile(baseName() + '.png', blob, 'image/png');
        })
        .then(function (ok) {
          if (!ok) say('Sharing was refused.');
        })
        .catch(function (e) { say(e.message); })
        .then(function () { copy.disabled = false; });
    };
  }

  /* ---------- the rest ---------- */

  function fixHints() {
    var hint = document.querySelector('#empty .hint');
    if (hint) {
      hint.innerHTML =
        '<span><b>Drag</b> to pan</span>' +
        '<span><b>Pinch</b> to zoom</span>' +
        '<span><b>Double tap</b> to fit</span>';
    }
    var p = document.querySelector('#empty p');
    if (p) p.textContent = 'Open a photo or an SVG. Photos get screened.';
    var drop = $('drop');
    if (drop) drop.remove();      // nothing is dragged onto a phone
  }

  function start() {
    if (!isPhone()) return false;
    document.body.classList.add('mobile');

    parts = buildSheet();
    if (!parts) return false;
    sheet = parts.aside;
    measure();
    setState('peek');
    wireDrag(parts);
    wireSaving();
    fixHints();

    // Opening something is the moment the settings become worth seeing.
    var file = $('file');
    if (file) {
      file.addEventListener('change', function () {
        setTimeout(function () { if (state === 'peek') setState('half'); }, 400);
      });
    }

    // A rotation changes every one of the measurements above.
    root.addEventListener('orientationchange', function () {
      setTimeout(function () { measure(); setState(state); }, 250);
    });
    // The buttons carry an export size that appears once something is loaded,
    // which is a line of text the head did not have when it was measured.
    if (root.ResizeObserver) new ResizeObserver(measure).observe(parts.head);

    return true;
  }

  root.Mobile = { start: start, isPhone: isPhone, svgToPng: svgToPng };
})(typeof window !== 'undefined' ? window : this);
