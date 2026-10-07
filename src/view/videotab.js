/* The Video Editor tab. Like the 3D Mockup it is its own page (src/video/) in a
 * frame over the work area, loaded the first time the tab is opened.
 *
 * The Artwork/3D switch in mockup.js is a two-way toggle. Rather than rewrite it,
 * this file sits beside it: opening Video shows its frame on top and marks the
 * Video button, and either of the other two buttons hides it again. While Video
 * is showing, Mockup.active() reports true so the artwork ignores keys and paste,
 * and menu shortcuts are swallowed so they cannot act on the artwork behind.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var frame, on = false;

  function set(v) {
    on = v;
    document.body.classList.toggle('mode-video', on);
    $('mode-video').classList.toggle('on', on);
    $('mode-video').setAttribute('aria-selected', String(on));
    if (on) {
      ['mode-art', 'mode-3d'].forEach(function (id) { $(id).classList.remove('on'); $(id).setAttribute('aria-selected', 'false'); });
      if (!frame.getAttribute('src')) frame.setAttribute('src', 'src/video/index.html');
      frame.hidden = false; frame.focus();
    } else {
      frame.hidden = true;
    }
  }

  function boot() {
    frame = $('video');
    $('mode-video').addEventListener('click', function () { set(true); });
    ['mode-art', 'mode-3d'].forEach(function (id) { $(id).addEventListener('click', function () { if (on) set(false); }); });
    if (window.Mockup) {
      var active = window.Mockup.active, handle = window.Mockup.handle;
      window.Mockup.active = function () { return on || active(); };
      window.Mockup.handle = function (name) {
        if (!on) return handle(name);
        if (name.indexOf('tool:') === 0) { set(false); window.Mockup.show('art'); return false; }
        if (name === 'mockup') { set(false); window.Mockup.show('3d'); return true; }
        var ed = null; try { ed = frame.contentWindow && frame.contentWindow.videoEditor; } catch (e) {}
        if (ed) { if (name === 'undo') ed.undo(); else if (name === 'redo') ed.redo(); else if (name === 'save') ed.save(); }
        return true;
      };
    }
    if (window.desktop && window.desktop.onMenu) window.desktop.onMenu('video', function () { set(!on); if (!on && window.Mockup) window.Mockup.show('art'); });
    if (/[?&]video\b/.test(location.search)) set(true);
  }

  window.VideoTab = { active: function () { return on; }, show: set };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
