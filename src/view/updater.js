/* The update notice.
 *
 * Deliberately small and ignorable: a strip in the corner of the canvas, never
 * a modal, never something that interrupts work in progress. An update is
 * already downloaded by the time this appears, so the only decision left is
 * when to restart.
 *
 * It also carries the signal that says the app started. The main process holds
 * a marker from the moment it decides to run updated source, and only this
 * clears it, so source that crashes on the way up is thrown away next launch
 * instead of bricking the app.
 */
(function (root) {
  'use strict';

  var bar = null;

  function el() {
    if (!bar) bar = document.getElementById('update');
    return bar;
  }

  function hide() {
    var b = el();
    if (b) b.hidden = true;
  }

  function show(html) {
    var b = el();
    if (!b) return;
    b.innerHTML = html;
    b.hidden = false;
  }

  function button(label, kind, fn) {
    var btn = document.createElement('button');
    btn.textContent = label;
    if (kind) btn.className = kind;
    btn.onclick = fn;
    return btn;
  }

  function render(state) {
    var d = root.desktop;
    var b = el();
    if (!b || !d) return;

    if (state.state === 'ready') {
      show('');
      var line = document.createElement('span');
      line.className = 'msg';
      line.textContent = 'Version ' + state.version + ' is ready.';
      b.appendChild(line);
      if (state.notes) {
        var note = document.createElement('span');
        note.className = 'notes';
        note.textContent = state.notes;
        b.appendChild(note);
      }
      b.appendChild(button('Restart now', 'pri', function () { d.restart(); }));
      b.appendChild(button('Later', '', hide));
      return;
    }

    if (state.state === 'needs-download') {
      show('');
      var l2 = document.createElement('span');
      l2.className = 'msg';
      l2.textContent = 'Version ' + state.version + ' needs a fresh download.';
      b.appendChild(l2);
      b.appendChild(button('Get it', 'pri', function () { d.openReleases(); }));
      b.appendChild(button('Later', '', hide));
      return;
    }

    // Anything else is only worth saying when somebody actually asked.
    if (!state.asked) return hide();

    show('');
    var l3 = document.createElement('span');
    l3.className = 'msg';
    l3.textContent = state.state === 'offline'
      ? 'Could not reach GitHub. ' + (state.reason || '')
      : state.state === 'dev'
        ? 'Running from source, so updates are off.'
        : 'You have the newest version.';
    b.appendChild(l3);
    b.appendChild(button('OK', '', hide));
    setTimeout(hide, 6000);
  }

  function start() {
    var d = root.desktop;
    if (!d || !d.ready) return;     // the browser build has nothing to update
    d.ready();
    if (d.onUpdate) d.onUpdate(render);
  }

  root.Updater = { start: start, render: render };
})(typeof window !== 'undefined' ? window : this);
