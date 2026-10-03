/* The 3D Mockup tab: put a design on a garment and save a Shopify-ready GLB.
 *
 * The mockup lives in its own page (src/studio/) because it is a different kind
 * of program: three.js, ES modules and WebGL rather than this page's 2D canvas.
 * It runs in a frame that fills the window under the toolbar, loaded the first
 * time the tab is opened so the Artwork side starts exactly as fast as before.
 *
 * The menu bar belongs to this page, so while the mockup is showing the shared
 * shortcuts (Cmd Z, Cmd S, Cmd O, Cmd 0, Cmd B) are routed into the frame
 * instead of acting on the artwork behind it.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var frame = null;
  var active = false;

  function studio() {
    try { return frame && frame.contentWindow && frame.contentWindow.studio; } catch (e) { return null; }
  }

  function show(mode) {
    active = mode === '3d';
    document.body.classList.toggle('mode-3d', active);
    $('mode-art').classList.toggle('on', !active);
    $('mode-3d').classList.toggle('on', active);
    $('mode-art').setAttribute('aria-selected', String(!active));
    $('mode-3d').setAttribute('aria-selected', String(active));
    if (active) {
      if (!frame.getAttribute('src')) frame.setAttribute('src', 'src/studio/index.html');
      frame.hidden = false;
      frame.focus();
    } else {
      frame.hidden = true;
    }
  }

  /* Menu shortcuts while the mockup shows. true means "handled here, the
   * artwork must not react". A tool from the Tool menu brings Artwork back. */
  function handle(name) {
    if (!active) return false;
    if (name.indexOf('tool:') === 0) { show('art'); return false; }
    var s = studio();
    if (!s) return true;
    if (name === 'undo') s.undo();
    else if (name === 'redo') s.redo();
    else if (name === 'save') s.save();
    else if (name === 'open') s.addAnywhere();
    else if (name === 'fit') s.fit();
    else if (name === 'bg') s.cycleBackdrop();
    return true;
  }

  function boot() {
    frame = $('mockup');
    $('mode-art').onclick = function () { show('art'); };
    $('mode-3d').onclick = function () { show('3d'); };
    if (window.desktop && window.desktop.onMenu) {
      window.desktop.onMenu('mockup', function () { show(active ? 'art' : '3d'); });
    }
    // ?mockup opens straight onto the 3D tab (harnesses and screenshots)
    if (/[?&]mockup\b/.test(location.search)) show('3d');
  }

  /* The frame's bytes are copied into this page before they cross to the main
   * process, so the bridge only ever sees a buffer from its own world. */
  function saveBinary(name, buffer) {
    if (!window.desktop || !window.desktop.saveBinary) return Promise.resolve(null);
    return window.desktop.saveBinary(name, new Uint8Array(buffer).slice().buffer);
  }

  window.Mockup = {
    active: function () { return active; },
    show: show,
    handle: handle,
    studio: studio,
    saveBinary: saveBinary
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
