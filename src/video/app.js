/* Tenzen Studio · Video Editor
 *
 * One project object (P) is the whole edit. The preview draws P on a canvas at
 * the output size; export sends P to the main process, which turns it into one
 * ffmpeg graph (electron/video.js). Text and image overlays are drawn here by
 * the same function for both, so what you see is what you export.
 *
 * Timeline rows: Video (clips back to back, magnetic), one row per overlay,
 * one row per effect, one row per audio item (music, SFX).
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var DESK = null;
  try { var HOST = window.parent !== window ? window.parent : window; DESK = HOST.desktop && HOST.desktop.video ? HOST.desktop.video : null; } catch (e) { DESK = null; }

  /* ---------------- project ---------------- */
  var uid = function () { return Math.random().toString(36).slice(2, 9); };
  var P = { name: 'Tenzen video', width: 1080, height: 1920, fps: 30, clips: [], overlays: [], effects: [], audio: [] };
  var sel = null;               // {kind:'clip'|'overlay'|'effect'|'audio', id}
  var t = 0, playing = false, looping = true, zoom = 1;
  var undoStack = [], redoStack = [];

  function snapshot() { return JSON.stringify(P); }
  function commit() {
    undoStack.push(lastState); if (undoStack.length > 120) undoStack.shift();
    redoStack = []; lastState = snapshot(); save(); renderTimeline(); inspector(); draw();
  }
  var lastState = snapshot();
  function restore(s) { P = JSON.parse(s); lastState = s; ensureMedia(); save(); renderTimeline(); inspector(); draw(); }
  function undo() { if (!undoStack.length) return; redoStack.push(lastState); restore(undoStack.pop()); }
  function redo() { if (!redoStack.length) return; undoStack.push(lastState); restore(redoStack.pop()); }
  var saveT = null;
  function save() { clearTimeout(saveT); saveT = setTimeout(function () { if (DESK) DESK.saveProject(JSON.stringify(P)); }, 400); }

  /* ---------------- clip timing ---------------- */
  function pieces(c) {
    var s0 = c.speed || 1, s1 = c.ramp ? (c.speedEnd || s0) : s0;
    if (!c.ramp || Math.abs(s1 - s0) < 1e-3) return [{ a: c.in, b: c.out, s: s0 }];
    var out = [], N = 8;
    for (var i = 0; i < N; i++) out.push({ a: c.in + (c.out - c.in) * i / N, b: c.in + (c.out - c.in) * (i + 1) / N, s: s0 + (s1 - s0) * (i + .5) / N });
    return out;
  }
  function clipDur(c) { return pieces(c).reduce(function (n, p) { return n + (p.b - p.a) / p.s; }, 0); }
  function layout() {
    var at = 0;
    return P.clips.map(function (c) { var d = clipDur(c), r = { c: c, start: at, end: at + d }; at += d; return r; });
  }
  function total() { var L = layout(); return L.length ? L[L.length - 1].end : 0; }
  function atTime(T) {
    var L = layout();
    for (var i = 0; i < L.length; i++) {
      if (T < L[i].end || i === L.length - 1) {
        var u = Math.max(0, T - L[i].start), ps = pieces(L[i].c), src = L[i].c.in, spd = ps[0].s;
        for (var j = 0; j < ps.length; j++) {
          var d = (ps[j].b - ps[j].a) / ps[j].s;
          if (u <= d || j === ps.length - 1) { src = ps[j].a + Math.min(u, d) * ps[j].s; spd = ps[j].s; break; }
          u -= d;
        }
        return { i: i, r: L[i], src: src, speed: spd };
      }
    }
    return null;
  }

  /* ---------------- media ---------------- */
  var vids = {};      // token -> <video>
  var imgs = {};      // token -> Image
  var bufs = {};      // token -> AudioBuffer
  var AC = new (window.AudioContext || window.webkitAudioContext)();
  function videoEl(c) {
    if (vids[c.token]) return vids[c.token];
    var v = document.createElement('video');
    v.crossOrigin = 'anonymous'; v.preload = 'auto'; v.playsInline = true; v.src = c.url;
    v.addEventListener('seeked', function () { if (!playing) draw(); });
    v.addEventListener('loadeddata', function () { draw(); });
    vids[c.token] = v; return v;
  }
  function imageEl(o) {
    if (imgs[o.token]) return imgs[o.token];
    var im = new Image(); im.crossOrigin = 'anonymous'; im.onload = function () { draw(); renderTimeline(); }; im.src = o.url;
    imgs[o.token] = im; return im;
  }
  function decode(item) {
    if (bufs[item.token]) return Promise.resolve(bufs[item.token]);
    return fetch(item.url).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return AC.decodeAudioData(b); })
      .then(function (buf) { bufs[item.token] = buf; renderTimeline(); return buf; }).catch(function () { return null; });
  }
  function ensureMedia() {
    P.clips.forEach(function (c) { videoEl(c); if (c.hasAudio) decode(c); });
    P.overlays.forEach(function (o) { if (o.kind === 'image') imageEl(o); });
    P.audio.forEach(decode);
  }

  /* ---------------- drawing ---------------- */
  var cv = $('cv'), ctx = cv.getContext('2d'), hold = document.createElement('canvas');   // last drawn picture, for the stutter effect
  var grainTiles = [];
  (function makeGrain() {
    for (var k = 0; k < 6; k++) {
      var c = document.createElement('canvas'); c.width = 270; c.height = 480;
      var g = c.getContext('2d'), id = g.createImageData(c.width, c.height);
      for (var i = 0; i < id.data.length; i += 4) { var n = 128 + (Math.random() + Math.random() + Math.random() - 1.5) * 90; id.data[i] = id.data[i + 1] = id.data[i + 2] = n; id.data[i + 3] = 255; }
      g.putImageData(id, 0, 0); grainTiles.push(c);
    }
  })();
  function sizeStage() {
    cv.width = P.width; cv.height = P.height;
    var view = $('view'), st = $('stage');
    var maxW = view.clientWidth - 28, maxH = view.clientHeight - 28, k = Math.min(maxW / P.width, maxH / P.height);
    st.style.width = Math.floor(P.width * k) + 'px'; st.style.height = Math.floor(P.height * k) + 'px';
  }
  function within(x, T) { return x.on !== false && T >= x.start && T < x.end; }
  function fadeAlpha(o, T) {
    var a = 1;
    if (o.fadeIn > 0) a = Math.min(a, (T - o.start) / o.fadeIn);
    if (o.fadeOut > 0) a = Math.min(a, (o.end - T) / o.fadeOut);
    return Math.max(0, Math.min(1, a));
  }
  function drawOverlay(g, o, alpha) {
    g.save(); g.globalAlpha = (o.opacity == null ? 1 : o.opacity) * alpha;
    g.translate(o.x, o.y); g.rotate((o.rotation || 0) * Math.PI / 180); g.scale(o.scale || 1, o.scale || 1);
    if (o.kind === 'text') {
      g.font = (o.italic ? 'italic ' : '') + (o.weight || 700) + ' ' + (o.size || 96) + 'px ' + (o.font || '"Helvetica Neue", Helvetica, Arial, sans-serif');
      g.fillStyle = o.color || '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      if ('letterSpacing' in g) g.letterSpacing = ((o.letter || 0) * (o.size || 96)) + 'px';
      if (o.shadow) { g.shadowColor = 'rgba(0,0,0,.55)'; g.shadowBlur = (o.size || 96) * .25; g.shadowOffsetY = (o.size || 96) * .06; }
      var lines = String(o.text || '').split('\n'), lh = (o.size || 96) * (o.lineHeight || 1.08);
      lines.forEach(function (ln, i) { g.fillText(ln, 0, (i - (lines.length - 1) / 2) * lh); });
    } else {
      var im = imageEl(o);
      if (im.complete && im.naturalWidth) {
        var w = o.width || Math.min(P.width * .6, im.naturalWidth), h = w * im.naturalHeight / im.naturalWidth;
        g.drawImage(im, -w / 2, -h / 2, w, h);
      }
    }
    g.restore();
  }
  function overlayBox(o) {
    var s = o.scale || 1;
    if (o.kind === 'text') {
      ctx.save(); ctx.font = (o.weight || 700) + ' ' + (o.size || 96) + 'px ' + (o.font || 'Helvetica Neue');
      var lines = String(o.text || '').split('\n'), w = Math.max.apply(null, lines.map(function (l) { return ctx.measureText(l).width; }));
      ctx.restore(); var h = lines.length * (o.size || 96) * (o.lineHeight || 1.08);
      return { x: o.x - w * s / 2, y: o.y - h * s / 2, w: w * s, h: h * s };
    }
    var im = imgs[o.token], w2 = o.width || 600, h2 = im && im.naturalWidth ? w2 * im.naturalHeight / im.naturalWidth : w2;
    return { x: o.x - w2 * s / 2, y: o.y - h2 * s / 2, w: w2 * s, h: h2 * s };
  }
  function draw() {
    var T = t, a = atTime(T);
    $('empty').hidden = !!P.clips.length;
    ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
    var f = [];
    if (a) {
      var c = a.r.c, gr = c.grade || {};
      if (gr.exposure || gr.contrast || gr.saturation) f.push('brightness(' + (1 + (gr.exposure || 0) * .5) + ') contrast(' + (1 + (gr.contrast || 0)) + ') saturate(' + (1 + (gr.saturation || 0)) + ')');
    }
    P.effects.forEach(function (fx) {
      if (!within(fx, T)) return;
      if (fx.type === 'bw') f.push('grayscale(1) contrast(' + (fx.amount || 2) + ')');
      if (fx.type === 'blur') f.push('blur(' + (fx.amount || 8) * (P.width / 1080) + 'px)');
      if (fx.type === 'grade') f.push('brightness(' + (1 + (fx.exposure || 0) * .5) + ') contrast(' + (1 + (fx.contrast || 0)) + ') saturate(' + (1 + (fx.saturation || 0)) + ')');
    });
    // stutter: hold the last drawn picture for N frames so playback looks laggy
    var st = P.effects.find(function (fx) { return fx.type === 'stutter' && fx.on !== false && within(fx, T); });
    if (st && hold.w && Math.round(T * P.fps) % Math.max(2, Math.round(st.amount || 4)) !== 0) {
      ctx.drawImage(hold, 0, 0); hold.skip = true;
    } else hold.skip = false;
    if (a && !hold.skip) {
      var v = videoEl(a.r.c);
      if (v.readyState >= 2) {
        ctx.filter = f.join(' ') || 'none';
        var vw = v.videoWidth, vh = v.videoHeight, k = Math.max(cv.width / vw, cv.height / vh);
        // motion: a slow push or pull across the clip, panned inside the spare picture
        var mc = a.r.c, mp = Math.max(0, Math.min(1, (T - a.r.start) / Math.max(1e-6, a.r.end - a.r.start)));
        var z = (mc.zoomFrom || 1) + ((mc.zoomTo || 1) - (mc.zoomFrom || 1)) * mp, dw = vw * k * z, dh = vh * k * z;
        var dx = (cv.width - dw) / 2 + (mc.panX || 0) * (dw - cv.width) / 2, dy = (cv.height - dh) / 2 + (mc.panY || 0) * (dh - cv.height) / 2;
        ctx.drawImage(v, dx, dy, dw, dh);
        ctx.filter = 'none';
        var rg = P.effects.find(function (fx) { return fx.type === 'rgb' && fx.on !== false && within(fx, T); });
        if (rg) {   // chromatic split preview: a red copy left, a blue copy right
          var px = (rg.amount || 8) * cv.width / 1080;
          ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = .35; ctx.filter = 'saturate(3)';
          ctx.drawImage(v, dx - px, dy, dw, dh); ctx.drawImage(v, dx + px, dy, dw, dh);
          ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; ctx.filter = 'none';
        }
        if (hold.w !== cv.width || hold.h !== cv.height) { hold.width = hold.w = cv.width; hold.height = hold.h = cv.height; }
        hold.getContext('2d').drawImage(cv, 0, 0);
      }
      var lt = T - a.r.start, ld = a.r.end - a.r.start, fade = 1;
      if (a.r.c.fadeIn > 0) fade = Math.min(fade, lt / a.r.c.fadeIn);
      if (a.r.c.fadeOut > 0) fade = Math.min(fade, (ld - lt) / a.r.c.fadeOut);
      if (fade < 1) { ctx.fillStyle = 'rgba(0,0,0,' + (1 - Math.max(0, fade)) + ')'; ctx.fillRect(0, 0, cv.width, cv.height); }
    }
    P.effects.forEach(function (fx) {
      if (!within(fx, T)) return;
      if (fx.type === 'grain') {
        var tile = grainTiles[Math.floor(T * 12) % grainTiles.length];
        ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = Math.min(1, (fx.amount || .5));
        ctx.drawImage(tile, 0, 0, cv.width, cv.height); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      }
      if (fx.type === 'fade' || fx.type === 'white') { ctx.fillStyle = (fx.type === 'white' ? 'rgba(255,255,255,' : 'rgba(0,0,0,') + (fx.amount == null ? 1 : fx.amount) + ')'; ctx.fillRect(0, 0, cv.width, cv.height); }
    });
    P.overlays.forEach(function (o) { if (within(o, T)) drawOverlay(ctx, o, fadeAlpha(o, T)); });
    if (sel && sel.kind === 'overlay') {
      var o = find(sel); if (o && within(o, T)) { var b = overlayBox(o); ctx.strokeStyle = '#0d99ff'; ctx.lineWidth = 3; ctx.setLineDash([12, 8]); ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.setLineDash([]); }
    }
    ctx.restore();
    $('tc').textContent = fmt(T) + ' / ' + fmt(total());
    drawPlayhead();
  }

  /* ---------------- playback ---------------- */
  var lastFrame = 0, audioNodes = [], current = null;
  function stopAudio() { audioNodes.forEach(function (n) { try { n.stop(); } catch (e) {} }); audioNodes = []; }
  var mfq = function (i) { return 20000 * Math.pow(300 / 20000, i); };
  function startAudio() {
    stopAudio(); AC.resume();
    P.audio.forEach(function (a) {
      if (a.on === false) return; var buf = bufs[a.token]; if (!buf) return;
      var len = Math.min(a.length, total() - a.at), end = a.at + len; if (end <= t) return;
      var lead = Math.max(0, a.at - t), into = Math.max(0, t - a.at);
      var s = AC.createBufferSource(), g = AC.createGain(); s.buffer = buf;
      var now = AC.currentTime, at = function (x) { return now + Math.max(0, x - t); };
      g.gain.setValueAtTime(a.volume, now);
      if (a.fadeIn > 0 && into < a.fadeIn) { g.gain.setValueAtTime(a.volume * into / a.fadeIn, at(a.at + into)); g.gain.linearRampToValueAtTime(a.volume, at(a.at + a.fadeIn)); }
      if (a.fadeOut > 0) { g.gain.setValueAtTime(a.volume, at(end - a.fadeOut)); g.gain.linearRampToValueAtTime(0.0001, at(end)); }
      var node = s, mu = a.muffle;
      if (mu && mu.on && mu.intensity > 0) {
        var lp = AC.createBiquadFilter(); lp.type = 'lowpass'; var F = mfq(mu.intensity), inside = t >= mu.start && t < mu.end;
        lp.frequency.setValueAtTime(inside ? F : 20000, now);
        if (t < mu.start) { lp.frequency.setValueAtTime(20000, at(mu.start)); lp.frequency.exponentialRampToValueAtTime(F, at(mu.start) + .15); }
        if (t < mu.end) { lp.frequency.setValueAtTime(F, at(mu.end)); lp.frequency.exponentialRampToValueAtTime(20000, at(mu.end) + .15); }
        node.connect(lp); node = lp;
      }
      node.connect(g).connect(AC.destination);
      s.start(now + lead, (a.from || 0) + into, len - into); audioNodes.push(s);
    });
  }
  function syncVideo() {
    var a = atTime(t); if (!a) return;
    Object.keys(vids).forEach(function (k) { if (k !== a.r.c.token) { vids[k].pause(); } });
    var v = videoEl(a.r.c);
    v.muted = !!a.r.c.muted; v.volume = Math.min(1, a.r.c.volume == null ? 1 : a.r.c.volume);
    // layout() rebuilds its rows every call, so the clip itself is the stable identity.
    // Re-seeking while a seek is still decoding leaves the video with no frame to draw.
    if (current !== a.r.c || (!v.seeking && Math.abs(v.currentTime - a.src) > .3)) { v.currentTime = a.src; current = a.r.c; }
    if (Math.abs(v.playbackRate - a.speed) > .01) v.playbackRate = a.speed;
    if (playing && v.paused) v.play().catch(function () {});
    if (!playing && !v.paused) v.pause();
  }
  function seek(T) {
    t = Math.max(0, Math.min(total(), T)); current = null;
    var a = atTime(t); if (a) { var v = videoEl(a.r.c); v.pause(); v.currentTime = a.src; }
    if (playing) startAudio(); draw();
  }
  function play() {
    if (!P.clips.length) return;
    if (t >= total() - 1e-3) t = 0;
    playing = true; $('play').textContent = 'Pause'; lastFrame = performance.now(); current = null; syncVideo(); startAudio();
    requestAnimationFrame(loop);
  }
  function pause() {
    playing = false; $('play').textContent = 'Play'; stopAudio(); Object.keys(vids).forEach(function (k) { vids[k].pause(); }); draw();
  }
  function loop(now) {
    if (!playing) return;
    t += (now - lastFrame) / 1000; lastFrame = now;
    if (t >= total()) { if (looping) { t = 0; current = null; startAudio(); } else { t = total(); pause(); return; } }
    syncVideo(); draw(); requestAnimationFrame(loop);
  }

  /* ---------------- adding things ---------------- */
  function toast(msg, err) {
    var el = $('toast'); el.textContent = msg; el.className = err ? 'err' : ''; el.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { el.hidden = true; }, err ? 6000 : 2500);
  }
  function need() { if (!DESK) { toast('Open this inside the Tenzen Studio app.', true); return false; } return true; }
  function addVideos() {
    if (!need()) return;
    DESK.pick('video').then(function (list) {
      list.forEach(function (m) {
        if (!m.hasVideo) return toast(m.name + ' has no video.', true);
        P.clips.push({ id: uid(), token: m.token, url: m.url, path: m.path, name: m.name, duration: m.duration, hasAudio: m.hasAudio,
          in: 0, out: m.duration, speed: 1, speedEnd: 1, ramp: false, volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
          grade: { exposure: 0, contrast: 0, saturation: 0 } });
      });
      if (list.length) { ensureMedia(); sel = { kind: 'clip', id: P.clips[P.clips.length - 1].id }; commit(); }
    });
  }
  function addAudioItem(m) {
    var at = t, len = Math.min(m.duration || 10, Math.max(.5, (total() || 10) - at));
    P.audio.push({ id: uid(), token: m.token, url: m.url, path: m.path, name: m.name.replace(/\.[^.]+$/, ''), duration: m.duration,
      at: at, from: 0, length: len, volume: 1, fadeIn: 0, fadeOut: 0, on: true, muffle: { on: false, intensity: .6, start: at, end: at + len } });
    ensureMedia(); sel = { kind: 'audio', id: P.audio[P.audio.length - 1].id }; commit();
  }
  function addAudio() { if (!need()) return; DESK.pick('audio').then(function (l) { l.forEach(addAudioItem); }); }
  function youtube() {
    if (!need()) return; var u = $('ytUrl').value.trim(); if (!u) return;
    $('ytGo').disabled = true; toast('Importing from YouTube, up to a minute…');
    DESK.youtube(u).then(function (m) { addAudioItem(m); $('ytUrl').value = ''; toast('Imported ' + m.name); })
      .catch(function (e) { toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); })
      .then(function () { $('ytGo').disabled = false; });
  }
  function span() { var T = total() || 5; var s = Math.min(t, Math.max(0, T - .5)); return { start: s, end: Math.min(T, s + Math.min(3, T - s)) }; }
  function addText() {
    var r = span();
    P.overlays.push({ id: uid(), kind: 'text', text: 'Your text', font: '"Helvetica Neue", Helvetica, Arial, sans-serif', weight: 700, size: Math.round(96 * P.width / 1080),
      color: '#ffffff', letter: -0.02, lineHeight: 1.08, shadow: false, x: P.width / 2, y: P.height / 2, scale: 1, rotation: 0, opacity: 1,
      fadeIn: 0, fadeOut: 0, start: r.start, end: r.end, on: true });
    sel = { kind: 'overlay', id: P.overlays[P.overlays.length - 1].id }; commit();
  }
  function addImage() {
    if (!need()) return;
    DESK.pick('image').then(function (list) {
      list.forEach(function (m) {
        var r = span();
        P.overlays.push({ id: uid(), kind: 'image', token: m.token, url: m.url, path: m.path, name: m.name, width: Math.round(P.width * .6),
          x: P.width / 2, y: P.height / 2, scale: 1, rotation: 0, opacity: 1, fadeIn: 0, fadeOut: 0, start: r.start, end: r.end, on: true });
      });
      if (list.length) { ensureMedia(); sel = { kind: 'overlay', id: P.overlays[P.overlays.length - 1].id }; commit(); }
    });
  }
  var FX = { bw: { name: 'Black & white', amount: 2 }, blur: { name: 'Blur', amount: 8 }, grain: { name: 'Grain', amount: .45 },
    grade: { name: 'Colour grade', exposure: 0, contrast: 0, saturation: 0 }, fade: { name: 'Fade to black', amount: 1 }, white: { name: 'Flash white', amount: 1 },
    stutter: { name: 'Stutter', amount: 4 }, rgb: { name: 'RGB split', amount: 8 } };
  function addFx(type) {
    var r = span(), fx = Object.assign({ id: uid(), type: type, on: true, start: r.start, end: r.end }, FX[type]);
    if (type === 'white') fx.end = Math.min(fx.end, fx.start + 2 / P.fps);   // a flash is two frames unless stretched
    P.effects.push(fx); sel = { kind: 'effect', id: fx.id }; commit();
  }
  /* The Tenzen outro: the lockup lands over the last stretch with a white flash and the
   * music muffles underneath it. Starts at the playhead when it sits inside the video,
   * otherwise 1.6 s before the end. */
  function addOutro() {
    if (!P.clips.length) return toast('Add a video clip first.', true);
    var T = total(), at = (t > .5 && t < T - .3) ? t : Math.max(0, T - 1.6), f = 1 / P.fps;
    P.overlays.push({ id: uid(), kind: 'image', token: '', url: 'assets/tenzen-lockup.png', path: '', name: 'Tenzen lockup', width: Math.round(P.width * .62),
      x: P.width / 2, y: P.height / 2, scale: 1, rotation: 0, opacity: 1, fadeIn: 0, fadeOut: 0, start: at, end: T, on: true });
    P.effects.push(Object.assign({ id: uid(), type: 'white', on: true, start: at, end: at + 2 * f }, FX.white));
    P.audio.forEach(function (a) { a.muffle = Object.assign(a.muffle || {}, { on: true, intensity: a.muffle && a.muffle.intensity ? a.muffle.intensity : .6, start: at, end: Math.max(T, a.at + a.length) }); });
    ensureMedia(); sel = { kind: 'overlay', id: P.overlays[P.overlays.length - 1].id }; commit(); seek(at);
  }

  /* ---------------- selection helpers ---------------- */
  function listFor(kind) { return kind === 'clip' ? P.clips : kind === 'overlay' ? P.overlays : kind === 'effect' ? P.effects : P.audio; }
  function find(s) { if (!s) return null; return listFor(s.kind).find(function (x) { return x.id === s.id; }) || null; }
  function del() {
    var x = find(sel); if (!x) return; var l = listFor(sel.kind); l.splice(l.indexOf(x), 1); sel = null; seek(Math.min(t, total())); commit();
  }
  function split() {
    var x = find(sel), T = t;
    if (sel && sel.kind === 'clip') {
      var L = layout(), r = L.find(function (q) { return q.c === x; }); if (!r || T <= r.start + .02 || T >= r.end - .02) return toast('Put the playhead inside the selected clip.', true);
      var src = atTime(T).src, b = JSON.parse(JSON.stringify(x)); b.id = uid(); x.out = src; b.in = src;
      if (x.ramp) { var mid = x.speed + (x.speedEnd - x.speed) * (T - r.start) / (r.end - r.start); b.speed = mid; x.speedEnd = mid; }
      x.fadeOut = 0; b.fadeIn = 0; P.clips.splice(P.clips.indexOf(x) + 1, 0, b); sel = { kind: 'clip', id: b.id }; commit(); return;
    }
    if (x && (sel.kind === 'overlay' || sel.kind === 'effect')) {
      if (T <= x.start || T >= x.end) return toast('Put the playhead inside the selection.', true);
      var y = JSON.parse(JSON.stringify(x)); y.id = uid(); x.end = T; y.start = T; listFor(sel.kind).push(y); sel = { kind: sel.kind, id: y.id }; commit(); return;
    }
    if (x && sel.kind === 'audio') {
      if (T <= x.at || T >= x.at + x.length) return toast('Put the playhead inside the selection.', true);
      var z = JSON.parse(JSON.stringify(x)); z.id = uid(); var cut = T - x.at; x.length = cut; z.at = T; z.from = x.from + cut; z.length -= cut;
      P.audio.push(z); sel = { kind: 'audio', id: z.id }; commit(); return;
    }
    toast('Select a clip first.', true);
  }

  /* ---------------- timeline ---------------- */
  var GUT = 132, inner = $('inner'), snapMode = 'grid';   // 'grid' | 'edges' | 'off'
  var T0 = 0;                   // timeline origin, below zero when audio starts before the video
  var live = [];                // [{el, range}] repositioned during drags without rebuilding the DOM
  var laneW = function () { var l = inner.querySelector('.lane'); return l ? l.clientWidth : 600; };
  var origin = function () { var m = 0; P.audio.forEach(function (a) { if (a.at < m) m = a.at; }); return Math.min(0, Math.floor(m)); };
  var span_ = function () { return Math.max(total(), 5) + 1; };
  var W = function () { return span_() - T0; };
  var x2t = function (x) { return x / laneW() * W(); };
  var pct = function (s) { return ((s - T0) / W() * 100) + '%'; };
  var pw = function (d) { return (d / W() * 100) + '%'; };
  function gridStep() { return zoom > 6 ? .1 : zoom > 2.5 ? .5 : 1; }
  function snapT(T, ev, skip) {
    hideSnap();
    if (snapMode === 'off' || (ev && ev.altKey)) return Math.round(T * P.fps) / P.fps;
    var pts = [0, total(), t];
    layout().forEach(function (r) { pts.push(r.start, r.end); });
    P.overlays.concat(P.effects).forEach(function (o) { if (o !== skip) pts.push(o.start, o.end); });
    P.audio.forEach(function (a) { if (a !== skip) pts.push(a.at, a.at + a.length); });
    var thr = x2t(8), best = T, bd = thr, hit = false;
    pts.forEach(function (p) { var d = Math.abs(p - T); if (d < bd) { bd = d; best = p; hit = true; } });
    if (!hit && snapMode === 'grid') { var g = gridStep(), q = Math.round(T / g) * g; if (Math.abs(q - T) < thr) { best = q; hit = true; } }
    if (hit) showSnap(best);
    return Math.round(best * P.fps) / P.fps;
  }
  function showSnap(p) { var s = $('snapline'); if (s) { s.style.left = (GUT + (p - T0) / W() * laneW()) + 'px'; s.style.display = 'block'; } }
  function hideSnap() { var s = $('snapline'); if (s) s.style.display = 'none'; }
  var COLORS = { clip: 'var(--c-video)', text: 'var(--c-text)', image: 'var(--c-image)', effect: 'var(--c-fx)', audio: 'var(--c-audio)' };
  function row(label, color, cls) {
    var r = document.createElement('div'); r.className = 'trk' + (cls ? ' ' + cls : '');
    r.innerHTML = '<div class="name"><i style="background:' + color + '"></i><span>' + label + '</span></div><div class="lane"></div>';
    inner.appendChild(r); return r.querySelector('.lane');
  }
  function place(el, a, b) { el.style.left = pct(a); el.style.width = 'calc(' + pw(b - a) + ' - 1px)'; }
  function relayout() { live.forEach(function (x) { var r = x.range(); if (r) place(x.el, r[0], r[1]); }); drawPlayhead(); }
  function clipEl(lane, key, range, label, color, isSel, off, handles) {
    var c = document.createElement('div'); c.className = 'clip' + (isSel ? ' sel' : '') + (off ? ' off' : ''); c.dataset.k = key;
    var r = range(); place(c, r[0], r[1]); c.style.background = color;
    c.innerHTML = '<canvas></canvas><span>' + label + '</span>' + (handles ? '<div class="h l"></div><div class="h r"></div>' : '');
    lane.appendChild(c); live.push({ el: c, range: range }); return c;
  }
  function wave(cvEl, buf, from, len) {
    if (!buf) return; var w = cvEl.width = Math.max(40, cvEl.clientWidth * 2), h = cvEl.height = 60, g = cvEl.getContext('2d');
    var d = buf.getChannelData(0), sr = buf.sampleRate, s0 = Math.floor(from * sr), n = Math.floor(len * sr), N = Math.floor(w / 3), st = Math.max(1, Math.floor(n / N));
    g.fillStyle = '#101010';
    for (var i = 0; i < N; i++) { var m = 0; for (var j = s0 + i * st; j < s0 + (i + 1) * st && j < d.length; j += 8) m = Math.max(m, Math.abs(d[j])); var ph = m * h * .9; g.fillRect(i * 3, (h - ph) / 2, 2, ph); }
  }
  function thumbs(cvEl, c) {
    var v = vids[c.token]; if (!v || v.readyState < 2) return;
    var w = cvEl.width = Math.max(40, cvEl.clientWidth * 2), h = cvEl.height = 80, g = cvEl.getContext('2d'), tw = h * v.videoWidth / v.videoHeight;
    for (var x = 0; x < w; x += tw) g.drawImage(v, x, 0, tw, h);
  }
  /* Drags never rebuild the timeline while the pointer is down: the element that holds the
   * pointer capture would be destroyed and the drag would stop. The model is updated, the
   * elements are repositioned in place, and the DOM is rebuilt once on release. If the origin
   * has to move (audio dragged before zero) the timeline is rebuilt and the capture is handed
   * to the new element for the same item. */
  function drag(el, key, onStart, onMove, onUp) {
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var mode = e.target.classList.contains('l') ? 'l' : e.target.classList.contains('r') ? 'r' : 'm';
      var x0 = e.clientX, st = onStart(mode), moved = false, cur = el, pid = e.pointerId;
      cur.setPointerCapture(pid);
      var mv = function (ev) {
        moved = true; onMove(x2t(ev.clientX - x0), mode, ev, st);
        if (origin() !== T0) {
          renderTimeline(); var n = inner.querySelector('[data-k="' + key + '"]');
          if (n) { cur.onpointermove = null; cur.onpointerup = null; cur = n; cur.setPointerCapture(pid); cur.onpointermove = mv; cur.onpointerup = up; x0 = ev.clientX; st = onStart(mode); }
        } else relayout();
        inspector(true); draw();
      };
      var up = function () { cur.onpointermove = null; cur.onpointerup = null; hideSnap(); onUp(moved); };
      cur.onpointermove = mv; cur.onpointerup = up;
      e.stopPropagation();
    });
  }
  function renderTimeline() {
    T0 = origin(); live = [];
    inner.style.width = (100 * zoom) + '%'; inner.innerHTML = '';
    var R = document.createElement('div'); R.className = 'ruler';
    var T = span_(), step = T > 40 ? 5 : T > 16 ? 2 : zoom > 2.5 ? .5 : 1, html = '<div class="gut"></div><div class="scale" id="scale">';
    for (var s = Math.ceil(T0 / step) * step; s <= T + 1e-6; s += step) {
      var z = Math.abs(s) < 1e-6;
      html += '<i style="left:' + pct(s) + (z ? ';height:100%;background:var(--ink2)' : '') + '"></i>' + (Math.abs(s % 1) < 1e-6 || step < 1 ? '<span style="left:' + pct(s) + '">' + (+s.toFixed(1)) + 's</span>' : '');
    }
    R.innerHTML = html + '</div>'; inner.appendChild(R);
    var sb = $('snap'); if (sb) { sb.textContent = snapMode === 'grid' ? 'Snap: ' + gridStep() + 's' : snapMode === 'edges' ? 'Snap: edges' : 'Snap: off'; sb.classList.toggle('on', snapMode !== 'off'); }

    var vl = row('Video', COLORS.clip, 'main');
    layout().forEach(function (r) {
      var c = r.c, isS = sel && sel.kind === 'clip' && sel.id === c.id;
      var lab = c.name + (c.ramp ? ' · ' + c.speed + '→' + c.speedEnd + 'x' : c.speed !== 1 ? ' · ' + c.speed + 'x' : '');
      var el = clipEl(vl, 'clip' + c.id, function () { var q = layout().find(function (z) { return z.c === c; }); return q ? [q.start, q.end] : null; }, lab, COLORS.clip, isS, false, true);
      thumbs(el.querySelector('canvas'), c);
      drag(el, 'clip' + c.id, function () { select({ kind: 'clip', id: c.id }); return { in: c.in, out: c.out }; }, function (dt, mode, ev, st) {
        var sp = c.speed || 1;
        if (mode === 'l') c.in = Math.max(0, Math.min(c.out - .1, st.in + dt * sp));
        else if (mode === 'r') c.out = Math.min(c.duration, Math.max(c.in + .1, st.out + dt * sp));
        else { // reorder by dragging over neighbours
          var L = layout(), q = L.find(function (z) { return z.c === c; }), mid = q.start + (q.end - q.start) / 2 + dt, to = L.findIndex(function (z) { return mid < z.end; }); if (to < 0) to = L.length - 1;
          var from = P.clips.indexOf(c); if (to !== from) { P.clips.splice(from, 1); P.clips.splice(to, 0, c); }
        }
        seek(t);
      }, function (moved) { if (moved) commit(); });
    });

    P.overlays.forEach(function (o) {
      var isS = sel && sel.kind === 'overlay' && sel.id === o.id, color = o.kind === 'text' ? COLORS.text : COLORS.image;
      var lane = row(o.kind === 'text' ? 'Text' : 'Image', color);
      var el = clipEl(lane, 'overlay' + o.id, function () { return [o.start, o.end]; }, o.kind === 'text' ? String(o.text).split('\n').join(' / ') : o.name, color, isS, o.on === false, true);
      rangeDrag(el, o, 'overlay');
    });
    P.effects.forEach(function (fx) {
      var isS = sel && sel.kind === 'effect' && sel.id === fx.id, lane = row(fx.name, COLORS.effect);
      var el = clipEl(lane, 'effect' + fx.id, function () { return [fx.start, fx.end]; }, fx.name + fxLabel(fx), COLORS.effect, isS, fx.on === false, true);
      rangeDrag(el, fx, 'effect');
    });
    P.audio.forEach(function (a) {
      var isS = sel && sel.kind === 'audio' && sel.id === a.id, lane = row(a.name, COLORS.audio);
      var el = clipEl(lane, 'audio' + a.id, function () { return [a.at, a.at + a.length]; }, a.name + (a.muffle && a.muffle.on ? ' · muffled' : ''), COLORS.audio, isS, a.on === false, true);
      wave(el.querySelector('canvas'), bufs[a.token], a.from, a.length);
      drag(el, 'audio' + a.id, function () { select({ kind: 'audio', id: a.id }); return { at: a.at, len: a.length, from: a.from }; }, function (dt, mode, ev, st) {
        var max = (a.duration || 1e9);
        if (mode === 'm') {   // free: the song may start before the video and get trimmed later
          var nat = snapT(Math.max(-st.len + .5, st.at + dt), ev, a), sh = nat - a.at; a.at = nat;
          if (a.muffle) { a.muffle.start += sh; a.muffle.end += sh; }
        } else if (mode === 'l') {
          var na = snapT(Math.max(st.at - st.from, Math.min(st.at + st.len - .05, st.at + dt)), ev, a), d = na - st.at;
          a.at = na; a.from = st.from + d; a.length = st.len - d;
        } else { var ne = snapT(Math.min(st.at + (max - st.from), Math.max(st.at + .05, st.at + st.len + dt)), ev, a); a.length = ne - a.at; }
      }, function (moved) { if (moved) commit(); });
    });

    var ph = document.createElement('div'); ph.className = 'ph'; ph.id = 'ph'; inner.appendChild(ph);
    var sl = document.createElement('div'); sl.className = 'snapline'; sl.id = 'snapline'; sl.style.display = 'none'; inner.appendChild(sl);
    var sc = $('scale');
    sc.addEventListener('pointerdown', function (e) {
      var go = function (ev) { var r = sc.getBoundingClientRect(); seek(snapT((ev.clientX - r.left) / r.width * W() + T0, ev)); };
      go(e); sc.setPointerCapture(e.pointerId); sc.onpointermove = go; sc.onpointerup = function () { sc.onpointermove = null; hideSnap(); };
    });
    drawPlayhead();
  }
  function fxLabel(fx) {
    if (fx.type === 'bw') return ' · contrast ' + Math.round(fx.amount * 100) + '%';
    if (fx.type === 'blur') return ' · ' + fx.amount + 'px';
    if (fx.type === 'grain') return ' · ' + Math.round(fx.amount * 100) + '%';
    return '';
  }
  function rangeDrag(el, o, kind) {
    drag(el, kind + o.id, function () { select({ kind: kind, id: o.id }); return { s: o.start, e: o.end }; }, function (dt, mode, ev, st) {
      var T = Math.max(total(), .1);
      if (mode === 'm') { var len = st.e - st.s, s = snapT(Math.max(0, Math.min(T - len, st.s + dt)), ev, o); o.start = s; o.end = s + len; }
      else if (mode === 'l') o.start = snapT(Math.max(0, Math.min(o.end - 1 / P.fps, st.s + dt)), ev, o);
      else o.end = snapT(Math.min(T, Math.max(o.start + 1 / P.fps, st.e + dt)), ev, o);
    }, function (moved) { if (moved) commit(); });
  }
  function drawPlayhead() {
    var ph = $('ph'), sc = $('scale'); if (!ph || !sc) return;
    ph.style.left = (GUT + (t - T0) / W() * sc.clientWidth) + 'px';
  }
  function select(s) {
    sel = s; var k = s ? s.kind + s.id : null;
    inner.querySelectorAll('.clip').forEach(function (n) { n.classList.toggle('sel', n.dataset.k === k); });
    inspector(); draw();
  }

  /* ---------------- inspector ---------------- */
  var I = $('insp');
  function slider(label, key, obj, min, max, step, fmtv, after) {
    var id = 'f' + uid(), val = key.split('.').reduce(function (o, k) { return o[k]; }, obj);
    var d = document.createElement('div'); d.className = 'row';
    d.innerHTML = '<span class="lbl">' + label + '</span><input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '"><span class="v">' + fmtv(val) + '</span>';
    var inp = d.querySelector('input'), out = d.querySelector('.v');
    var set = function (v) { var ks = key.split('.'), o = obj; for (var i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = v; };
    inp.oninput = function () { set(+inp.value); out.textContent = fmtv(+inp.value); if (after) after(); draw(); };
    inp.onchange = function () { commit(); };
    d.dataset.key = key; I.appendChild(d); return d;
  }
  function check(label, key, obj, after) {
    var d = document.createElement('label'); d.className = 'chk';
    var val = key.split('.').reduce(function (o, k) { return o[k]; }, obj);
    d.innerHTML = '<input type="checkbox"' + (val ? ' checked' : '') + '> ' + label; I.appendChild(d);
    d.querySelector('input').onchange = function (e) { var ks = key.split('.'), o = obj; for (var i = 0; i < ks.length - 1; i++) o = o[ks[i]]; o[ks[ks.length - 1]] = e.target.checked; if (after) after(); commit(); };
  }
  function head(txt) { var h = document.createElement('h2'); h.textContent = txt; I.appendChild(h); }
  function sec(txt) { var s = document.createElement('div'); s.className = 'sec'; I.appendChild(s); head(txt); }
  function btns(list) { var d = document.createElement('div'); d.className = 'btns'; list.forEach(function (b) { var x = document.createElement('button'); x.textContent = b[0]; x.onclick = b[1]; d.appendChild(x); }); I.appendChild(d); }
  var S = function (x) { return (+x).toFixed(2) + 's'; }, PC = function (x) { return Math.round(x * 100) + '%'; }, X = function (x) { return (+x).toFixed(2) + 'x'; }, PX = function (x) { return Math.round(x) + ''; };
  function inspector(soft) {
    var x = find(sel);
    if (soft && x && I.dataset.sel === sel.kind + sel.id) {   // live values only, keep focus
      I.querySelectorAll('.row').forEach(function (r) {
        var k = r.dataset.key; if (!k) return; var v = k.split('.').reduce(function (o, q) { return o && o[q]; }, x);
        if (v == null) return; var inp = r.querySelector('input'); inp.value = v; r.querySelector('.v').textContent = (k === 'at' || k === 'start' || k === 'end' || k === 'length' || k === 'from') ? S(v) : r.querySelector('.v').textContent;
      });
      return;
    }
    I.innerHTML = ''; I.dataset.sel = x ? sel.kind + sel.id : '';
    if (!x) {
      head('Project');
      var nm = document.createElement('div'); nm.className = 'row wide'; nm.innerHTML = '<span class="lbl">Name</span><input id="pname" value="">'; I.appendChild(nm);
      $('pname').value = P.name; $('pname').onchange = function (e) { P.name = e.target.value || 'Tenzen video'; commit(); };
      var p = document.createElement('p'); p.className = 'note';
      p.textContent = P.clips.length ? 'Select anything on the timeline to edit it here. Length ' + fmt(total()) + ', ' + P.width + '×' + P.height + ' at ' + P.fps + ' fps.' : 'Start with + Video. Add more clips and they play back to back.';
      I.appendChild(p); return;
    }
    if (sel.kind === 'clip') {
      head('Video clip'); var n = document.createElement('p'); n.className = 'note'; n.textContent = x.name; I.appendChild(n);
      sec('Trim');
      slider('In', 'in', x, 0, x.duration, .01, S, function () { if (x.in > x.out - .1) x.in = x.out - .1; renderTimeline(); seek(t); });
      slider('Out', 'out', x, 0, x.duration, .01, S, function () { if (x.out < x.in + .1) x.out = x.in + .1; renderTimeline(); seek(t); });
      sec('Speed');
      slider('Speed', 'speed', x, .25, 4, .05, X, function () { if (!x.ramp) x.speedEnd = x.speed; renderTimeline(); seek(t); });
      check('Speed ramp across the clip', 'ramp', x, function () { if (x.ramp && x.speedEnd === x.speed) x.speedEnd = Math.max(.25, x.speed / 2); });
      if (x.ramp) slider('Ends at', 'speedEnd', x, .25, 4, .05, X, function () { renderTimeline(); seek(t); });
      sec('Motion');
      if (x.zoomFrom == null) { x.zoomFrom = 1; x.zoomTo = 1; x.panX = 0; x.panY = 0; }
      slider('Zoom from', 'zoomFrom', x, 1, 2.5, .01, X); slider('Zoom to', 'zoomTo', x, 1, 2.5, .01, X);
      slider('Pan X', 'panX', x, -1, 1, .01, PC); slider('Pan Y', 'panY', x, -1, 1, .01, PC);
      btns([['Push in', function () { x.zoomFrom = 1; x.zoomTo = 1.25; commit(); }], ['Pull out', function () { x.zoomFrom = 1.25; x.zoomTo = 1; commit(); }], ['No motion', function () { x.zoomFrom = x.zoomTo = 1; x.panX = x.panY = 0; commit(); }]]);
      sec('Look');
      slider('Exposure', 'grade.exposure', x, -1, 1, .01, PC); slider('Contrast', 'grade.contrast', x, -.5, 1, .01, PC); slider('Saturation', 'grade.saturation', x, -1, 1, .01, PC);
      sec('Fades');
      slider('Fade in', 'fadeIn', x, 0, 3, .05, S); slider('Fade out', 'fadeOut', x, 0, 3, .05, S);
      sec('Sound');
      check('Mute this clip', 'muted', x); slider('Volume', 'volume', x, 0, 1.5, .01, PC);
      btns([['Split at playhead', split], ['Delete', del]]);
    } else if (sel.kind === 'overlay') {
      head(x.kind === 'text' ? 'Text' : 'Image');
      if (x.kind === 'text') {
        var ta = document.createElement('textarea'); ta.value = x.text; I.appendChild(ta);
        ta.oninput = function () { x.text = ta.value; draw(); }; ta.onchange = function () { commit(); };
        var fr = document.createElement('div'); fr.className = 'row wide';
        fr.innerHTML = '<span class="lbl">Font</span><select id="ffont"><option value=\'"Helvetica Neue", Helvetica, Arial, sans-serif\'>Helvetica Neue</option><option value="Inter, sans-serif">Inter</option><option value=\'"SF Pro Display", -apple-system, sans-serif\'>SF Pro</option><option value=\'Georgia, serif\'>Georgia</option><option value=\'"Times New Roman", serif\'>Times</option><option value=\'Menlo, monospace\'>Menlo</option><option value=\'"Futura", sans-serif\'>Futura</option><option value=\'"Avenir Next", sans-serif\'>Avenir Next</option></select>';
        I.appendChild(fr); var fs = $('ffont'); fs.value = x.font; if (fs.selectedIndex < 0) { var op = document.createElement('option'); op.value = x.font; op.textContent = x.font; fs.appendChild(op); fs.value = x.font; }
        fs.onchange = function () { x.font = fs.value; commit(); };
        var wr = document.createElement('div'); wr.className = 'row wide';
        wr.innerHTML = '<span class="lbl">Weight</span><select id="fweight"><option value="300">Light</option><option value="400">Regular</option><option value="500">Medium</option><option value="700">Bold</option><option value="900">Black</option></select>';
        I.appendChild(wr); $('fweight').value = String(x.weight); $('fweight').onchange = function (e) { x.weight = +e.target.value; commit(); };
        var cr = document.createElement('div'); cr.className = 'row wide'; cr.innerHTML = '<span class="lbl">Colour</span><input type="color" id="fcol">'; I.appendChild(cr);
        $('fcol').value = x.color; $('fcol').oninput = function (e) { x.color = e.target.value; draw(); }; $('fcol').onchange = commit;
        slider('Size', 'size', x, 12, 400, 1, PX); slider('Spacing', 'letter', x, -.1, .3, .005, PC); slider('Line height', 'lineHeight', x, .8, 2, .01, X);
        check('Italic', 'italic', x); check('Soft shadow', 'shadow', x);
      } else {
        slider('Width', 'width', x, 40, P.width * 1.5, 1, PX);
      }
      sec('Placement');
      slider('X', 'x', x, 0, P.width, 1, PX); slider('Y', 'y', x, 0, P.height, 1, PX);
      slider('Scale', 'scale', x, .2, 3, .01, PC); slider('Rotate', 'rotation', x, -180, 180, 1, function (v) { return Math.round(v) + '°'; }); slider('Opacity', 'opacity', x, 0, 1, .01, PC);
      btns([['Centre', function () { x.x = P.width / 2; x.y = P.height / 2; commit(); }]]);
      sec('Timing');
      slider('Starts', 'start', x, 0, total(), 1 / P.fps, S, function () { renderTimeline(); }); slider('Ends', 'end', x, 0, total(), 1 / P.fps, S, function () { renderTimeline(); });
      slider('Fade in', 'fadeIn', x, 0, 2, .05, S); slider('Fade out', 'fadeOut', x, 0, 2, .05, S);
      btns([['Start at playhead', function () { var L = x.end - x.start; x.start = t; x.end = Math.min(total(), t + L); commit(); }], ['Split', split], ['Delete', del]]);
    } else if (sel.kind === 'effect') {
      head(x.name);
      check('Enabled', 'on', x);
      if (x.type === 'bw') slider('Contrast', 'amount', x, 1, 3, .05, PC, renderTimeline);
      if (x.type === 'blur') slider('Amount', 'amount', x, 1, 40, 1, function (v) { return v + 'px'; }, renderTimeline);
      if (x.type === 'grain') slider('Amount', 'amount', x, .05, 1, .01, PC, renderTimeline);
      if (x.type === 'fade') slider('Darkness', 'amount', x, 0, 1, .01, PC);
      if (x.type === 'white') slider('Brightness', 'amount', x, 0, 1, .01, PC);
      if (x.type === 'stutter') slider('Hold frames', 'amount', x, 2, 12, 1, PX, renderTimeline);
      if (x.type === 'rgb') slider('Split', 'amount', x, 1, 40, 1, function (v) { return v + 'px'; }, renderTimeline);
      if (x.type === 'grade') { slider('Exposure', 'exposure', x, -1, 1, .01, PC); slider('Contrast', 'contrast', x, -.5, 1, .01, PC); slider('Saturation', 'saturation', x, -1, 1, .01, PC); }
      sec('Timing');
      slider('Starts', 'start', x, 0, total(), 1 / P.fps, S, renderTimeline); slider('Ends', 'end', x, 0, total(), 1 / P.fps, S, renderTimeline);
      btns([['Start at playhead', function () { var L = x.end - x.start; x.start = t; x.end = Math.min(total(), t + L); commit(); }], ['Split', split], ['Delete', del]]);
    } else if (sel.kind === 'audio') {
      head('Audio'); var an = document.createElement('p'); an.className = 'note'; an.textContent = x.name; I.appendChild(an);
      check('Enabled', 'on', x); slider('Volume', 'volume', x, 0, 1.5, .01, PC);
      sec('Placement');
      slider('Starts at', 'at', x, -Math.max(x.length - .5, 0), Math.max(total(), .1), 1 / P.fps, S, renderTimeline);
      slider('Length', 'length', x, .05, Math.min(x.duration || 60, Math.max(total(), 1)), .01, S, renderTimeline);
      slider('Song from', 'from', x, 0, Math.max(0, (x.duration || 0) - .05), .01, S, renderTimeline);
      slider('Fade in', 'fadeIn', x, 0, 3, .05, S); slider('Fade out', 'fadeOut', x, 0, 3, .05, S);
      sec('Muffle');
      check('Muffle this audio', 'muffle.on', x);
      slider('Intensity', 'muffle.intensity', x, 0, 1, .01, PC);
      slider('From', 'muffle.start', x, 0, Math.max(total(), .1), 1 / P.fps, S); slider('Until', 'muffle.end', x, 0, Math.max(total(), .1), 1 / P.fps, S);
      btns([['Muffle from playhead', function () { x.muffle.on = true; x.muffle.start = t; x.muffle.end = Math.max(t + .5, x.at + x.length); commit(); }]]);
      btns([['Move to playhead', function () { var sh = t - x.at; x.at = t; x.muffle.start += sh; x.muffle.end += sh; commit(); }], ['Split', split], ['Delete', del]]);
    }
    if (playing) startAudio();
  }

  /* ---------------- preview interaction: drag overlays ---------------- */
  cv.addEventListener('pointerdown', function (e) {
    var r = cv.getBoundingClientRect(), k = cv.width / r.width, px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
    var hit = null;
    P.overlays.slice().reverse().some(function (o) { if (!within(o, t)) return false; var b = overlayBox(o); if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) { hit = o; return true; } return false; });
    if (!hit) return;
    select({ kind: 'overlay', id: hit.id });
    var ox = hit.x, oy = hit.y; cv.setPointerCapture(e.pointerId); var moved = false;
    cv.onpointermove = function (ev) {
      moved = true; var nx = ox + (ev.clientX - e.clientX) * k, ny = oy + (ev.clientY - e.clientY) * k;
      if (!ev.altKey) { if (Math.abs(nx - P.width / 2) < 12 * k) nx = P.width / 2; if (Math.abs(ny - P.height / 2) < 12 * k) ny = P.height / 2; }
      hit.x = Math.round(nx); hit.y = Math.round(ny); draw(); inspector(true);
    };
    cv.onpointerup = function () { cv.onpointermove = null; if (moved) commit(); };
  });

  /* ---------------- export ---------------- */
  function overlayPNGs() {
    return Promise.all(P.overlays.filter(function (o) { return o.on !== false; }).map(function (o) {
      var c = document.createElement('canvas'); c.width = P.width; c.height = P.height;
      drawOverlay(c.getContext('2d'), o, 1);
      return new Promise(function (res) { c.toBlob(function (b) { var fr = new FileReader(); fr.onload = function () { res({ png: String(fr.result).split(',')[1], start: o.start, end: o.end, fadeIn: o.fadeIn, fadeOut: o.fadeOut }); }; fr.readAsDataURL(b); }, 'image/png'); });
    }));
  }
  function doExport() {
    if (!need() || !P.clips.length) return toast('Add a video clip first.', true);
    pause(); $('busy').hidden = false; $('busyP').style.width = '0'; $('busyT').textContent = 'Rendering ' + P.name;
    // audio placed before zero is trimmed to the video start for the render
    var Q = JSON.parse(JSON.stringify(P));
    Q.audio = Q.audio.filter(function (a) { if (a.at < 0) { var cut = -a.at; a.from += cut; a.length -= cut; a.at = 0; } return a.length > .05; });
    overlayPNGs().then(function (ovs) { return DESK.render(JSON.stringify(Q), JSON.stringify(ovs)); })
      .then(function (r) { $('busy').hidden = true; toast('Saved to Downloads: ' + r.name); DESK.reveal(r.path); })
      .catch(function (e) { $('busy').hidden = true; toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); });
  }

  /* ---------------- wiring ---------------- */
  function fmt(s) { s = Math.max(0, s || 0); return Math.floor(s / 60) + ':' + (s % 60).toFixed(2).padStart(5, '0'); }
  $('play').onclick = function () { playing ? pause() : play(); };
  $('prev').onclick = function () { pause(); seek(t - 1 / P.fps); };
  $('next').onclick = function () { pause(); seek(t + 1 / P.fps); };
  $('loop').onclick = function () { looping = !looping; $('loop').classList.toggle('on', looping); };
  $('undo').onclick = undo; $('redo').onclick = redo; $('split').onclick = split; $('del').onclick = del;
  $('zin').onclick = function () { zoom = Math.min(10, zoom * 1.5); renderTimeline(); };
  $('zout').onclick = function () { zoom = Math.max(1, zoom / 1.5); renderTimeline(); };
  $('snap').onclick = function () { snapMode = snapMode === 'grid' ? 'edges' : snapMode === 'edges' ? 'off' : 'grid'; renderTimeline(); };
  $('addVideo').onclick = addVideos; $('addAudio').onclick = addAudio; $('addImage').onclick = addImage; $('addText').onclick = addText;
  $('ytGo').onclick = youtube; $('ytUrl').onkeydown = function (e) { if (e.key === 'Enter') youtube(); };
  document.querySelectorAll('[data-fx]').forEach(function (b) { b.onclick = function () { addFx(b.dataset.fx); }; });
  $('outro').onclick = addOutro;
  $('format').onchange = function (e) { var wh = e.target.value.split('x').map(Number); P.width = wh[0]; P.height = wh[1]; sizeStage(); commit(); };
  $('fps').onchange = function (e) { P.fps = +e.target.value; commit(); };
  $('export').onclick = doExport;
  $('busyX').onclick = function () { if (DESK) DESK.cancel(); };
  if (DESK) DESK.onProgress(function (p) { $('busyP').style.width = Math.round(p * 100) + '%'; });
  document.addEventListener('keydown', function (e) {
    var tag = e.target.tagName; if ((tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') || tag === 'TEXTAREA' || tag === 'SELECT') return;
    var mod = e.metaKey || e.ctrlKey;
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
    else if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (e.code === 'KeyS' && !mod) { e.preventDefault(); split(); }
    else if (e.code === 'Backspace' || e.code === 'Delete') { e.preventDefault(); del(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); pause(); seek(t - (e.shiftKey ? 1 : 1 / P.fps)); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); pause(); seek(t + (e.shiftKey ? 1 : 1 / P.fps)); }
    else if (e.code === 'Escape') { select(null); }
  });
  window.addEventListener('resize', function () { sizeStage(); renderTimeline(); draw(); });

  /* the host page routes its menu shortcuts here while this tab shows */
  window.videoEditor = { undo: undo, redo: redo, save: function () { save(); toast('Saved'); }, play: function () { playing ? pause() : play(); },
    project: function () { return JSON.stringify(P); },
    load: function (json) { P = Object.assign(P, typeof json === 'string' ? JSON.parse(json) : json); lastState = snapshot(); ensureMedia(); sizeStage(); renderTimeline(); inspector(); draw(); },
    seek: function (T) { seek(T); }, select: function (kind, i) { var l = listFor(kind); select(l[i] ? { kind: kind, id: l[i].id } : null); } };

  function boot() {
    sizeStage(); renderTimeline(); inspector(); draw();
    if (!DESK) { $('status').textContent = 'Preview only: open inside Tenzen Studio to add media.'; return; }
    DESK.status().then(function (s) {
      var miss = []; if (!s.ffmpeg) miss.push('ffmpeg'); if (!s.ytdlp) miss.push('yt-dlp');
      $('status').textContent = miss.length ? 'Missing on this Mac: ' + miss.join(', ') + '. Install with Homebrew.' : '';
    });
    DESK.loadProject().then(function (saved) {
      if (saved && saved.clips) {
        P = Object.assign(P, saved); lastState = snapshot();
        $('format').value = P.width + 'x' + P.height; $('fps').value = String(P.fps);
        ensureMedia(); sizeStage(); renderTimeline(); inspector(); draw();
      }
    });
  }
  boot();
})();
