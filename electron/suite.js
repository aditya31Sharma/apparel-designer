/* The overnight suite.
 *
 * Drives the real app in the real desktop build: every effect, every preset,
 * every dot shape and texture, on both vector artwork and a photo. Each case
 * asserts that it produced geometry, that nothing errored, that the SVG it
 * exports is well formed, and that it came back inside a time budget.
 *
 * Writes build/suite.json and a one-line-per-case log.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SCRIPT = `(async function(){
  function wait(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
  var Doc = window.Doc, Effects = window.Effects;
  var results = [], failures = [];

  function beat(where){
    window.__suiteProgress = {
      at: where, done: results.length, failed: failures.length, t: Date.now(),
      // The names too, so a run that dies after a failure still says which.
      failures: failures.slice(-12),
      err: (document.getElementById('err').textContent || '').slice(0, 120),
      state: window.App.debug ? window.App.debug() : null
    };
  }

  /* Anything that takes longer than this has gone wrong, and a run that hangs
   * reports nothing at all, which is worse than a run that reports a stall.
   * Every await goes through here so the suite always produces a verdict. */
  /* The timer has to be cleared when the promise wins the race. Left running,
   * it fires later and reports a stall in a step that finished long ago, so a
   * suite that merely got slower reads as a suite full of hangs. */
  function withDeadline(promise, ms, label){
    var timer = null;
    return Promise.race([
      promise,
      new Promise(function (resolve) {
        timer = setTimeout(function () {
          timer = null;
          failures.push('STALLED at ' + label + ' after ' + ms + 'ms');
          results.push({ name: 'stall/' + label, pass: false, detail: ms + 'ms' });
          resolve('stalled');
        }, ms);
      })
    ]).then(function (v) {
      if (timer) clearTimeout(timer);
      return v;
    });
  }

  function check(name, cond, detail){
    results.push({ name: name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    if (!cond) failures.push(name + (detail ? ' :: ' + detail : ''));
    // Kept where the harness can read it, so a run that stalls says where it
    // stalled instead of just timing out with nothing.
    beat(name);
    return !!cond;
  }

  async function loadFile(name, type){
    var blob = await (await fetch(name)).blob();
    var f = new File([blob], name, {type:type});
    var dt = new DataTransfer(); dt.items.add(f);
    var input = document.getElementById('file');
    input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles:true}));
    await wait(2400);
    return window.App.selected();
  }

  /* Resolves once, on whichever comes first: a result or the budget.
   *
   * The earlier version gated its timeout on the shared window.__onResult still
   * being set. If a second wait overwrote that slot and then consumed it, the
   * first promise's timeout found nothing there and never resolved, so the run
   * hung on a promise nobody could settle. Own the flag locally instead. */
  function recompute(budgetMs){
    return new Promise(function(resolve){
      var t0 = performance.now(), settled = false;
      function finish(v){ if (settled) return; settled = true; resolve(v); }
      window.__onResult = function(){ finish(Math.round(performance.now() - t0)); };
      window.App.markDirty(false);
      setTimeout(function(){ finish(-1); }, budgetMs || 20000);
    });
  }

  /* The same recompute, asked for the way a held slider asks for it. */
  function recomputeLive(budgetMs){
    return new Promise(function(resolve){
      var t0 = performance.now(), settled = false;
      function finish(v){ if (settled) return; settled = true; resolve(v); }
      window.__onResult = function(){ finish(Math.round(performance.now() - t0)); };
      window.App.markDirty(true);
      setTimeout(function(){ finish(-1); }, budgetMs || 20000);
    });
  }

  /* A painted frame, not just a scheduled one: the canvas is drawn in an
   * animation frame after the result is accepted, so reading pixels any
   * earlier reads the frame before. */
  function frame(){
    return new Promise(function(r){
      var done = false;
      function fin(){ if (done) return; done = true; r(); }
      requestAnimationFrame(function(){ requestAnimationFrame(fin); });
      // A window nothing can see paints nothing, and its animation frames
      // never come. Fall through rather than wait forever: the pixel read
      // that follows will say what it saw, and the run reports instead of
      // hanging.
      setTimeout(fin, 600);
    });
  }

  function err(){ return document.getElementById('err').textContent || ''; }
  function clearErr(){ document.getElementById('err').textContent=''; document.getElementById('err').classList.remove('on'); }

  /* One case: set it up, recompute, and assert the result is real. */
  async function runCase(label, setup, budget){
    beat('running ' + label);
    clearErr();
    setup();
    window.App.syncPanels();
    var ms = await recompute();
    var e = err();
    var stats = document.getElementById('stats').textContent;
    var ok = check(label + ' completes', ms >= 0, ms + 'ms');
    if (!ok) return { ms: -1 };
    check(label + ' no error', !e, e);
    check(label + ' produced geometry', /[1-9]/.test(stats), stats);
    check(label + ' inside budget', ms <= budget, ms + 'ms > ' + budget + 'ms');
    return { ms: ms, stats: stats };
  }

  function exportChecks(label){
    var svg = window.App.svgText(false);
    check(label + ' export parses', (function(){
      var d = new DOMParser().parseFromString(svg, 'image/svg+xml');
      return !d.querySelector('parsererror');
    })(), svg.slice(0,120));
    check(label + ' export clean', !/NaN|undefined|Infinity/.test(svg));
    check(label + ' export has a path', /<path /.test(svg));
    return svg.length;
  }

  // The canvas colour is remembered between launches, and every pixel read
  // below assumes the dark default.
  window.App.setCanvas('#1e1e1e');

  // ================= vector artwork =================
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200">' +
    '<path d="M20 40h160v120h-160z" fill="#ff3366"/>' +
    '<circle cx="300" cy="100" r="80" fill="#2244ff"/>' +
    '<path d="M430 30 L570 170 L430 170 Z" fill="none" stroke="#00cc88" stroke-width="8"/></svg>';
  window.App.loadMarkup(svg, 'shapes.svg');
  await wait(1000);
  var L = window.App.selected();
  check('vector loads', !!L, L && L.name);
  check('nothing applied on import', L.effects.every(function(e){return !e.on;}));
  check('source items kept', L.source.items.length === 3, L.source.items.length);

  function offAll(layer){ layer.effects.forEach(function(e){ e.on = false; }); }

  // ---- warp: every preset ----
  var warpTimes = [];
  for (var i = 0; i < window.Warp.PRESETS.length; i++){
    var pr = window.Warp.PRESETS[i];
    var r = await runCase('warp/' + pr.id, (function(id){ return function(){
      offAll(L);
      Doc.effect(L,'warp').on = true;
      Doc.effect(L,'warp').params.preset = id;
      Doc.effect(L,'warp').params.strength = 60;
    };})(pr.id), 1500);
    if (r.ms >= 0) warpTimes.push(r.ms);
  }
  exportChecks('warp');

  // ---- dither: every style preset ----
  var ditherTimes = [];
  /* Every dither style has to decide how much of a photo becomes ink. Leaving
   * imageCut out of them meant all fifteen inherited one threshold, and on
   * anything with dark clothing that threshold filled the picture in: picking
   * a style changed the edge and not the thing that was actually wrong. */
  var dmissing = Object.keys(window.DITHER_PRESETS).filter(function (k) {
    return window.DITHER_PRESETS[k].params.imageCut === undefined;
  });
  check('every dither style sets the photo threshold', dmissing.length === 0, dmissing.join(',') || 'all set');

  /* Few styles, each a different thing. Fifteen that differed by a slider
   * were fifteen ways of not being able to tell, so the list is short and no
   * two entries share a texture or a screen kind. */
  check('dither offers a handful of styles', dnames0().length >= 4 && dnames0().length <= 7,
    dnames0().length + ' styles');
  check('every dither style is a different texture', (function(){
    var seen = {};
    return dnames0().every(function (k) {
      var t = window.DITHER_PRESETS[k].params.texture;
      if (seen[t]) return false; seen[t] = true; return true;
    });
  })(), dnames0().map(function (k) { return window.DITHER_PRESETS[k].params.texture; }).join(','));
  var hn0 = Object.keys(window.HALFTONE_PRESETS);
  check('halftone offers a handful of screens', hn0.length >= 3 && hn0.length <= 6, hn0.length + ' screens');
  check('every halftone screen differs in kind, not just size', (function(){
    var seen = {};
    return hn0.every(function (k) {
      var p = window.HALFTONE_PRESETS[k].params;
      var kind = p.mode + '/' + p.pattern + '/' + (p.grit >= 0.8 ? 'dirty' : 'clean');
      if (seen[kind]) return false; seen[kind] = true; return true;
    });
  })());
  /* A style is the five sliders on the panel plus the two choices, and nothing
   * hidden: what a style sets, you can see and move. */
  check('halftone styles only set what the panel shows', hn0.every(function (k) {
    return Object.keys(window.HALFTONE_PRESETS[k].params).every(function (key) {
      return ['mode','pattern','pitch','fill','gain','grit','minDot','angle','ink2','split','gcr','seed'].indexOf(key) >= 0;
    });
  }));
  function dnames0(){ return Object.keys(window.DITHER_PRESETS); }
  check('one colour is offered for both effects',
    !!window.DITHER_PRESETS.stencil && window.HALFTONE_PRESETS.onecolour &&
    window.HALFTONE_PRESETS.onecolour.params.mode === 'mono',
    window.HALFTONE_PRESETS.onecolour && window.HALFTONE_PRESETS.onecolour.params.mode);

  var dnames = Object.keys(window.DITHER_PRESETS);
  for (i = 0; i < dnames.length; i++){
    var r2 = await runCase('dither/' + dnames[i], (function(k){ return function(){
      offAll(L);
      Doc.effect(L,'dither').on = true;
      Object.assign(Doc.effect(L,'dither').params,
        JSON.parse(JSON.stringify(window.DITHER_PRESETS[k].params)));
    };})(dnames[i]), 4000);
    if (r2.ms >= 0) ditherTimes.push(r2.ms);
  }
  exportChecks('dither');

  // ---- dither: every texture ----
  var texNames = ['none'].concat(window.Grunge.TEXTURE_NAMES);
  for (i = 0; i < texNames.length; i++){
    await runCase('texture/' + texNames[i], (function(t){ return function(){
      offAll(L);
      Doc.effect(L,'dither').on = true;
      var p = Doc.effect(L,'dither').params;
      p.texture = t; p.textureAmount = t === 'none' ? 0 : 0.45; p.textureScale = 3;
    };})(texNames[i]), 4000);
  }

  // ---- halftone: every dot shape, every mode ----
  var shapes = ['round','square','ellipse','line','cross','diamond'];
  var modes = ['cmyk','duotone','mono'];
  for (i = 0; i < shapes.length; i++){
    for (var m = 0; m < modes.length; m++){
      await runCase('halftone/' + shapes[i] + '/' + modes[m], (function(sh,mo){ return function(){
        offAll(L);
        Doc.effect(L,'halftone').on = true;
        var p = Doc.effect(L,'halftone').params;
        p.pattern = sh; p.mode = mo; p.frequency = 120;
      };})(shapes[i], modes[m]), 3000);
    }
  }
  exportChecks('halftone');

  // ---- halftone: every style preset ----
  var hnames = Object.keys(window.HALFTONE_PRESETS);
  for (i = 0; i < hnames.length; i++){
    await runCase('halftonePreset/' + hnames[i], (function(k){ return function(){
      offAll(L);
      Doc.effect(L,'halftone').on = true;
      Object.assign(Doc.effect(L,'halftone').params,
        JSON.parse(JSON.stringify(window.HALFTONE_PRESETS[k].params)));
    };})(hnames[i]), 4000);
  }

  // ---- all three stacked ----
  var stacked = await runCase('stack/warp+dither+halftone', function(){
    offAll(L);
    L.effects.forEach(function(e){ e.on = true; });
  }, 8000);
  check('stack exports', exportChecks('stack') > 200);

  // ---- transform survives everything ----
  L.transform.x = 77; L.transform.y = 33;
  L.transform.width = 420; L.transform.height = 150;
  L.transform.rotation = 17;
  L.paint.opacity = 0.7;
  var before = JSON.stringify([L.transform, L.paint]);
  for (i = 0; i < 3; i++){
    offAll(L);
    L.effects[i].on = true;
    await recompute();
  }
  check('transform survives every effect', before === JSON.stringify([L.transform, L.paint]));
  L.transform.rotation = 0; L.paint.opacity = 1;

  // ---- undo and redo ----
  var hist = window.App.history;
  hist.clear();
  hist.push(window.App.doc());
  L.transform.x = 999;
  check('undo restores', hist.undo(window.App.doc()) && L.transform.x === 77, L.transform.x);
  check('redo reapplies', hist.redo(window.App.doc()) && L.transform.x === 999, L.transform.x);
  hist.undo(window.App.doc());

  // ================= fonts =================
  beat('fonts');
  var fbtn = document.getElementById('installFonts');
  check('the install fonts button is on the toolbar', !!fbtn && !fbtn.hidden);
  // window.Text is the browser's own text node type, always there; the
  // tool's traces are the button and the font list.
  check('there is no text tool', !document.getElementById('type') && !window.FontLib);
  /* A dry run only: the suite must never write into the real Fonts folder.
   * The install itself runs in the node tests, against temporary folders. */
  var dry = await withDeadline(window.desktop.installFonts({ dryRun: true }), 180000, 'font dry run');
  check('the font installer answers', !!dry && !dry.error && dry.dryRun === true,
    JSON.stringify(dry && (dry.error || { found: dry.found, would: dry.installed.length, already: dry.already })));
  if (dry && !dry.error) {
    check('nothing it would install is a hidden file',
      dry.installed.every(function (f) { return f.file && f.file.charAt(0) !== '.'; }));
    check('each font would be installed once',
      new Set(dry.installed.map(function (f) { return f.font; })).size === dry.installed.length,
      dry.installed.map(function (f) { return f.file; }).join(', '));
  }

  // ================= photo =================
  var P = await loadFile('doom.jpg','image/jpeg');
  check('photo loads', !!P && !!P.source.pixels, P && P.source.pixels && (P.source.pixels.w+'x'+P.source.pixels.h));
  /* An import applies nothing. A photo used to arrive already screened,
   * because a bare frame rectangle with pixels riding along draws as nothing;
   * the viewport draws the picture itself in that case now, so the first thing
   * that happens to your artwork can be the thing you asked for. */
  check('an imported photo has nothing applied',
    P.effects.every(function(e){ return !e.on; }),
    P.effects.filter(function(e){ return e.on; }).map(function(e){ return e.type; }).join(',') || 'none');
  check('an imported photo still draws', (function(){
    var canvas = document.getElementById('canvas');
    var g = canvas.getContext('2d');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var mid = window.Doc.applyMatrix(window.Doc.layerMatrix(P),
      P.source.bbox.width / 2, P.source.bbox.height / 2);
    var s2 = window.App.viewport().toScreen(mid);
    var px = g.getImageData(Math.round(s2.x * dpr), Math.round(s2.y * dpr), 1, 1).data;
    window.__midPx = [px[0], px[1], px[2]];
    // Anything but the canvas colour behind it. An unscreened photo used to
    // come out as nothing at all.
    return Math.abs(px[0] - 30) > 8 || Math.abs(px[1] - 30) > 8 || Math.abs(px[2] - 30) > 8;
  })(), JSON.stringify(window.__midPx));
  check('an imported photo exports as the picture', (function(){
    var svg = window.App.svgText(false);
    return svg.indexOf('<image') > 0 && svg.indexOf('data:image/png') > 0;
  })(), 'svg ' + window.App.svgText(false).length + ' bytes');
  check('halftone is sized by dot pitch, not cells across',
    Doc.effect(P,'halftone').params.pitch > 0 &&
    Doc.effect(P,'halftone').params.frequency === undefined,
    JSON.stringify({pitch: Doc.effect(P,'halftone').params.pitch}));

  var photoHt = await runCase('photo/halftone', function(){
    offAll(P); Doc.effect(P,'halftone').on = true;
  }, 3000);
  check('photo halftone is not a solid block',
    /[0-9],[0-9]/.test(photoHt.stats || ''), photoHt.stats);
  exportChecks('photoHalftone');

  for (i = 0; i < shapes.length; i++){
    await runCase('photoShape/' + shapes[i], (function(sh){ return function(){
      offAll(P);
      Doc.effect(P,'halftone').on = true;
      Doc.effect(P,'halftone').params.pattern = sh;
    };})(shapes[i]), 4000);
  }

  /* Warping a photo used to do nothing: the layer carries a placeholder
   * rectangle rather than an outline, so the bend landed on the frame and the
   * next effect went back to the pixels and lost it. */
  var photoWarp = await runCase('photo/warp', function(){
    offAll(P);
    Doc.effect(P,'warp').on = true;
    Doc.effect(P,'warp').params.preset = 'arc';
    Doc.effect(P,'warp').params.strength = 70;
  }, 6000);
  /* One shape is correct here: tracing a photo gives a single silhouette. What
   * matters is that the outline is the picture and not the frame, so compare
   * its point count against what a four-corner rectangle would have. */
  check('warp on a photo bends the picture, not the frame', (function(){
    var r = window.App.debug();
    var svg = window.App.svgText(false);
    var pts = (svg.match(/[ML]/g) || []).length;
    window.__warpPts = pts;
    return pts > 200;
  })(), (window.__warpPts || 0) + ' path commands');

  await runCase('photo/warp+halftone', function(){
    offAll(P);
    Doc.effect(P,'warp').on = true;
    Doc.effect(P,'halftone').on = true;
    Doc.effect(P,'halftone').params.pitch = 8;
  }, 9000);

  var photoDither = await runCase('photo/dither', function(){
    offAll(P);
    Doc.effect(P,'dither').on = true;
    Object.assign(Doc.effect(P,'dither').params, {texture:'rough', textureAmount:0.4, roughness:7});
  }, 5000);
  check('photo dither traces the picture, not its box',
    /contours/.test(photoDither.stats || '') &&
    parseInt((photoDither.stats||'').replace(/,/g,'').match(/(\\d+) contours/)[1],10) > 50,
    photoDither.stats);
  exportChecks('photoDither');

  await runCase('photo/dither+halftone', function(){
    offAll(P);
    Doc.effect(P,'dither').on = true;
    Doc.effect(P,'halftone').on = true;
  }, 9000);

  /* Pitch has to mean the same thing on artwork of any size. Setting an
   * absolute cell count was what put 76px dots on a large image from a preset
   * tuned on a small one. */
  // Read the number the engine reported rather than scraping formatted text.
  function pitchOf(){
    return window.__lastHT && window.__lastHT.pitch ? window.__lastHT.pitch : -1;
  }
  offAll(P);
  Doc.effect(P,'halftone').on = true;
  Doc.effect(P,'halftone').params.pitch = 7;
  await recompute();
  var pitchBig = pitchOf();
  P.transform.width = P.transform.width / 3;
  P.transform.height = P.transform.height / 3;
  await recompute();
  var pitchSmall = pitchOf();
  P.transform.width = P.transform.width * 3;
  P.transform.height = P.transform.height * 3;
  check('dot pitch holds when the artwork is resized',
    Math.abs(pitchBig - 7) < 0.6 && Math.abs(pitchSmall - 7) < 0.6,
    pitchBig + ' then ' + pitchSmall);
  await recompute();

  for (i = 0; i < hnames.length; i++){
    offAll(P);
    Doc.effect(P,'halftone').on = true;
    Object.assign(Doc.effect(P,'halftone').params,
      JSON.parse(JSON.stringify(window.HALFTONE_PRESETS[hnames[i]].params)));
    await recompute();
    var want = window.HALFTONE_PRESETS[hnames[i]].params.pitch;
    check('preset ' + hnames[i] + ' keeps its pitch on a photo',
      Math.abs(pitchOf() - want) < Math.max(0.6, want * 0.08),
      'wanted ' + want + ' got ' + pitchOf());
  }

  /* A fully transparent area is the ground and must take no ink, so the canvas
   * shows through it. Resampling used to leave black gaps wherever the working
   * bitmap was larger than the photo, which screened the empty space at about
   * fifty per cent. */
  var A = await loadFile('alpha.png','image/png');
  offAll(A);
  Doc.effect(A,'halftone').on = true;
  Doc.effect(A,'halftone').params.pitch = 5;
  await recompute();
  /* Framed and painted before anything is read back. The canvas is drawn in an
   * animation frame after the result is accepted, so clicking fit and sampling
   * in the same breath reads the frame before the one being asked about. */
  document.getElementById('fit').click();
  await wait(300);
  await frame();
  check('transparent areas take no ink', (function(){
    var canvas = document.getElementById('canvas');
    var g = canvas.getContext('2d');
    var vp = window.App.viewport();
    // sample just inside the top-left of the artwork frame, which is transparent
    var corner = window.Doc.applyMatrix(window.Doc.layerMatrix(A), 12, 12);
    var s = vp.toScreen(corner);
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var px = g.getImageData(Math.round(s.x * dpr), Math.round(s.y * dpr), 1, 1).data;
    window.__cornerPx = [px[0], px[1], px[2]];
    // The canvas, not paper: nothing is put under the artwork any more.
    return Math.abs(px[0] - 30) < 10 && Math.abs(px[1] - 30) < 10 && Math.abs(px[2] - 30) < 10;
  })(), JSON.stringify(window.__cornerPx) + ' against a 30,30,30 canvas');

  window.App.doc().layers = [P];
  window.App.doc().selection = P.id;

  /* ---- a cut-out shows before anything is applied ----
   *
   * The matte reaches the effects, which is what the checks below cover. It
   * also has to reach the canvas when no effect is running, because since an
   * import applies nothing that is the state people press the button in. It
   * did not: the cut was computed, stored and correct, and the canvas carried
   * on drawing the photo it came from, so removing the background looked like
   * it had done nothing at all.
   *
   * Driven with a matte made here rather than by running the model, which
   * takes seven seconds and is not what this is asking about. */
  beat('cut-out on an untouched photo');
  offAll(P);
  await withDeadline(recompute(), 30000, 'untouched before matte');
  document.getElementById('fit').click();
  await wait(400); window.App.viewport().invalidate(); await frame();

  var canvasEl = document.getElementById('canvas');
  var gEl = canvasEl.getContext('2d');
  var dprEl = Math.min(2, window.devicePixelRatio || 1);
  function samplePhoto(fx, fy){
    var m = window.Doc.layerMatrix(P), b = P.source.bbox;
    var s2 = window.App.viewport().toScreen(
      window.Doc.applyMatrix(m, b.x + b.width * fx, b.y + b.height * fy));
    return gEl.getImageData(Math.round(s2.x * dprEl), Math.round(s2.y * dprEl), 1, 1).data;
  }
  var before = samplePhoto(0.5, 0.5);

  // Everything knocked out but a strip down the middle.
  var mw = 64, mh = 64, mask = new Uint8Array(mw * mh);
  for (var my = 0; my < mh; my++){
    for (var mx = 0; mx < mw; mx++) mask[my * mw + mx] = (mx > 26 && mx < 38) ? 255 : 0;
  }
  P.matte = { mask: mask, w: mw, h: mh, source: 'test' };
  await withDeadline(recompute(), 30000, 'untouched after matte');
  await wait(400); window.App.viewport().invalidate(); await frame();
  var cut = samplePhoto(0.12, 0.5);
  var kept = samplePhoto(0.5, 0.5);

  check('a cut-out shows on a photo with nothing applied',
    Math.abs(cut[0] - 30) < 12 && Math.abs(cut[1] - 30) < 12 && Math.abs(cut[2] - 30) < 12,
    'knocked-out area reads ' + [cut[0], cut[1], cut[2]].join(',') + ' against a 30,30,30 canvas');
  check('the kept part of a cut-out is still the photo',
    Math.abs(kept[0] - before[0]) < 14 && Math.abs(kept[1] - before[1]) < 14,
    [kept[0], kept[1], kept[2]].join(',') + ' vs ' + [before[0], before[1], before[2]].join(','));
  check('a cut-out photo exports cut out', (function(){
    var svg = window.App.svgText(false);
    return svg.indexOf('<image') > 0 && svg.indexOf('data:image/png') > 0;
  })(), 'svg carries the matted picture');
  P.matte = null;
  await withDeadline(recompute(), 30000, 'clear matte');

  /* ---- one ink, one canvas, no paper ----
   *
   * The layer's ink is the colour of everything: a traced photo, a bent
   * logo, and a one or two colour screen. It is applied when the plates are
   * painted, so changing it never runs the screen again. And nothing puts
   * paper under the artwork any more: what is on the canvas is the file. */
  beat('ink and canvas');
  offAll(P);
  P.paint.fill = '#ff0000';
  Doc.effect(P,'halftone').on = true;
  Object.assign(Doc.effect(P,'halftone').params, JSON.parse(JSON.stringify(window.HALFTONE_PRESETS.onecolour.params)));
  Doc.effect(P,'halftone').params.pitch = 14;
  await withDeadline(recompute(), 30000, 'ink halftone');
  var inkSvg = window.App.svgText(false);
  check('a one colour halftone prints in the layer ink', /<path [^>]*fill="#ff0000"/.test(inkSvg));
  check('no paper under a halftone', !/<rect /.test(inkSvg));
  check('spot inks are not blended', !/mix-blend-mode/.test(inkSvg));
  check('the ink plate is named as ink, not as black', /data-ink="Ink"/.test(inkSvg));
  P.paint.fill = '#00ff00';
  var gen0 = window.App.debug().generation;
  var inkSvg2 = window.App.svgText(false);
  check('changing the ink recolours without a recompute',
    /fill="#00ff00"/.test(inkSvg2) && !/#ff0000/.test(inkSvg2) && window.App.debug().generation === gen0);

  Doc.effect(P,'halftone').params.mode = 'duotone';
  Doc.effect(P,'halftone').params.ink2 = '#1234ab';
  await withDeadline(recompute(), 30000, 'two ink halftone');
  var duoSvg = window.App.svgText(false);
  check('two inks: the layer ink and the second', /fill="#00ff00"/.test(duoSvg) && /fill="#1234ab"/.test(duoSvg));
  check('two inks are named as inks', /data-ink="Ink 1"/.test(duoSvg) && /data-ink="Ink 2"/.test(duoSvg));

  Doc.effect(P,'halftone').params.mode = 'cmyk';
  await withDeadline(recompute(), 30000, 'four ink halftone');
  var cmykSvg = window.App.svgText(false);
  check('four colour keeps its process inks and multiplies',
    /fill="#00AEEF"/.test(cmykSvg) && /mix-blend-mode:multiply/.test(cmykSvg) && !/<rect /.test(cmykSvg));

  // A traced photo prints in the ink too, with nothing under it.
  offAll(P);
  P.paint.fill = '#ffffff';
  Doc.effect(P,'dither').on = true;
  Object.assign(Doc.effect(P,'dither').params, JSON.parse(JSON.stringify(window.DITHER_PRESETS.stencil.params)));
  Doc.effect(P,'dither').params.imageCut = P.source.autoCut;
  await withDeadline(recompute(), 30000, 'ink dither');
  var ditSvg = window.App.svgText(false);
  check('a traced photo prints in the layer ink with no paper',
    /<path [^>]*fill="#ffffff"/.test(ditSvg) && !/<rect /.test(ditSvg));
  document.getElementById('fit').click();
  await wait(400); window.App.viewport().invalidate(); await frame();
  // The picture is dark line art on white; its top-left corner is white
  // paper, which traces to nothing, so the canvas shows through it.
  var corner2 = samplePhoto(0.03, 0.03);
  check('where the photo was paper, the canvas shows through',
    Math.abs(corner2[0] - 30) < 12 && Math.abs(corner2[1] - 30) < 12,
    [corner2[0], corner2[1], corner2[2]].join(',') + ' against 30,30,30');

  // The canvas is any colour, and the grid follows it.
  window.App.setCanvas('#f2f2f2');
  await wait(300); window.App.viewport().invalidate(); await frame();
  var corner3 = samplePhoto(0.03, 0.03);
  check('the canvas takes any colour', corner3[0] > 225 && corner3[1] > 225 && corner3[2] > 225,
    [corner3[0], corner3[1], corner3[2]].join(','));
  window.App.setCanvas('#1e1e1e');
  await wait(300); window.App.viewport().invalidate(); await frame();

  /* ---- invert: a light ink on a dark garment prints the light parts ---- */
  var posSvg = ditSvg;
  check('both thresholds were measured from the picture',
    typeof P.source.autoCut === 'number' && typeof P.source.autoCutInv === 'number',
    P.source.autoCut + ' / ' + P.source.autoCutInv);
  P.invert = true;
  Doc.effect(P,'dither').params.imageCut = P.source.autoCutInv;
  await withDeadline(recompute(), 30000, 'inverted dither');
  var negSvg = window.App.svgText(false);
  check('inverted dither traces something', /<path /.test(negSvg));
  check('inverted dither is a different picture', negSvg.length !== posSvg.length || negSvg !== posSvg);
  await wait(300); window.App.viewport().invalidate(); await frame();
  // Probe a spot that is pure white in the picture itself, found by looking
  // rather than assumed: the corner of a scanned drawing is often a grey
  // vignette, which is light enough to trace as nothing and not light enough
  // to trace as ink once the tone is turned round.
  var white = (function(){
    var px = P.source.pixels, step = Math.max(4, (px.w / 40) | 0);
    for (var y = (px.h * 0.1) | 0; y < px.h * 0.9; y += step){
      for (var x = (px.w * 0.1) | 0; x < px.w * 0.9; x += step){
        var i = (y * px.w + x) * 4;
        if (px.data[i] > 250 && px.data[i + 1] > 250 && px.data[i + 2] > 250) return { fx: x / px.w, fy: y / px.h };
      }
    }
    return null;
  })();
  var corner4 = white ? samplePhoto(white.fx, white.fy) : [0, 0, 0];
  check('inverted, the paper of the photo becomes ink',
    !!white && corner4[0] > 200 && corner4[1] > 200 && corner4[2] > 200,
    (white ? [corner4[0], corner4[1], corner4[2]].join(',') + ' at ' + white.fx.toFixed(2) + ',' + white.fy.toFixed(2) : 'no white found'));
  P.invert = false;
  Doc.effect(P,'dither').params.imageCut = P.source.autoCut;
  offAll(P);
  await withDeadline(recompute(), 30000, 'invert off');

  // ---- background removal ----
  clearErr();
  var st = await window.desktop.backgroundStatus();
  check('background model status reachable', !!st, JSON.stringify(st));

  if (st && st.ready) {
    offAll(P);
    check('the document is on the photo before removal',
      window.App.debug().selectedName === 'doom.jpg' && window.App.doc().layers.length === 1,
      JSON.stringify(window.App.debug()) + ' text=' + JSON.stringify(P.source.text || null));
    var tBg = performance.now();
    document.getElementById('removeBg').click();
    /* While it runs the panel has to say so, with a bar and a time, because a
     * seven second wait with nothing moving reads as a hang. */
    await wait(700);
    var mid = JSON.parse(JSON.stringify(window.App.bgState()));
    check('background removal shows it is running', mid.busy === true && /background|model|subject/i.test(mid.text), JSON.stringify(mid));
    check('background removal says how long is left', /left|nearly|%/.test(mid.eta || ''), mid.eta);
    check('background removal moves a bar', mid.pct > 0 && mid.pct < 1, mid.pct);
    check('the button is disabled while it runs', (function(){
      var b = document.querySelector('[data-tip^="Remove background"] button, .pr button:disabled');
      return !!document.querySelector('#panel-layer .pr button:disabled');
    })());
    for (i = 0; i < 180; i++){ await wait(500); if (P.matte) break; }
    var bgMs = Math.round(performance.now() - tBg);
    var after = window.App.bgState();
    check('the document is still on the photo after removal',
      window.App.debug().selectedName === 'doom.jpg' && window.App.doc().layers.length === 1,
      window.App.doc().layers.map(function (l) { return l.name + '/' + l.id; }).join(',') +
      ' sel=' + window.App.doc().selection + ' P=' + P.id + ' text=' + JSON.stringify(P.source.text || null) +
      ' bitmap=' + !!P.source.bitmap);
    check('background removal reports how long it took', !after.busy && /removed in [0-9.]+s/.test(after.text), after.text);
    check('the next estimate comes from this run', (function(){
      try { return parseInt(localStorage.getItem('ad.bgMs'), 10) > 500; } catch (e) { return false; }
    })());
    check('the button now offers to put the background back',
      /Restore background/.test(document.getElementById('panel-layer').textContent));
    if (check('background removal produces a matte', !!P.matte, bgMs + 'ms')) {
      var mm = P.matte, lit = 0;
      for (i = 0; i < mm.mask.length; i++) if (mm.mask[i] > 128) lit++;
      var cornerAvg = (mm.mask[0] + mm.mask[mm.w-1] +
                       mm.mask[(mm.h-1)*mm.w] + mm.mask[mm.w*mm.h-1]) / 4;
      check('matte keeps the subject', lit / mm.mask.length > 0.15 && lit / mm.mask.length < 0.95,
        (lit/mm.mask.length*100).toFixed(1) + '%');
      check('matte drops the corners', cornerAvg < 40, cornerAvg.toFixed(1));
      check('matte centre is opaque', mm.mask[((mm.h>>1)*mm.w)+(mm.w>>1)] > 180,
        mm.mask[((mm.h>>1)*mm.w)+(mm.w>>1)]);
      check('background removal under 30s', bgMs < 30000, bgMs + 'ms');
      check('background removal used the model', mm.source === 'model', mm.source);

      // and the matte has to actually reach the ink
      Doc.effect(P,'halftone').on = true;
      await recompute();
      check('halftone still runs with a matte', /dots/.test(document.getElementById('stats').textContent),
        document.getElementById('stats').textContent);
      window.App.toggleBackground();
      check('the same button puts the background back', !P.matte);
      await recompute();
    }
  } else {
    check('background model absent, reported honestly', true, JSON.stringify(st));
  }

  /* Round trip. An export that cannot be opened again is not an export, and
   * the importer and the exporter are the two halves most likely to drift. */
  offAll(P);
  Doc.effect(P,'halftone').on = true;
  // From the defaults, since the checks above left the screen in four colour
  // with grit on it, and the sizes below are calibrated for clean arcs.
  Object.assign(Doc.effect(P,'halftone').params, window.Effects.defaultsFor('halftone'));
  // Coarse on purpose: re-importing expands every arc into a polyline, so a
  // fine screen turns a 1MB export into tens of megabytes of points. The
  // round trip is what is being checked here, not the throughput.
  Doc.effect(P,'halftone').params.pitch = 22;
  await recompute();
  var beforeSvg = window.App.svgText(false);
  var beforeDots = window.__lastHT ? window.__lastHT.dots : 0;
  check('halftone export is not empty', beforeSvg.length > 1000, beforeSvg.length + ' bytes');

  /* The size shown before you press Save has to be close, and never low: a file
   * that turns out bigger than advertised is the surprise worth avoiding. */
  (function(){
    var shown = document.getElementById('exportSize').textContent.replace('~','');
    var est = /MB/.test(shown) ? parseFloat(shown) * 1048576 : parseFloat(shown) * 1024;
    // The readout exists to stop a big export being a surprise, so the rule is
    // never low, and close where closeness matters. A coarse screen is a small
    // file and a generous figure there costs nobody anything.
    var slack = beforeSvg.length > 4 * 1048576 ? 1.15 : 1.6;
    check('export estimate is never low, and close on a large file',
      est >= beforeSvg.length * 0.98 && est < beforeSvg.length * slack,
      shown + ' shown for ' + Math.round(beforeSvg.length / 1024) + 'KB');
  })();
  check('halftone export size is sane for the dot count',
    beforeSvg.length < beforeDots * 140,
    Math.round(beforeSvg.length/1024) + 'KB for ' + beforeDots + ' dots');

  /* Grit turns every dot into a polygon and the file three or four times
   * over. The size shown has to know that, and still never be low. */
  Doc.effect(P,'halftone').params.grit = 0.5;
  await recompute();
  (function(){
    var real = window.App.svgText(false).length;
    var shown = document.getElementById('exportSize').textContent.replace('~','');
    var est = /MB/.test(shown) ? parseFloat(shown) * 1048576 : parseFloat(shown) * 1024;
    check('the size shown knows about grit', est >= real * 0.98 && est < real * 1.6,
      shown + ' shown for ' + Math.round(real / 1024) + 'KB');
  })();
  Doc.effect(P,'halftone').params.grit = 0;
  await recompute();

  /* Fill closes the gap between dots: the same screen, more ink per cell,
   * until neighbours touch and fuse. Measured as ink on the page. */
  Doc.effect(P,'halftone').params.fill = 0.6;
  await recompute();
  var inkLow = window.__lastHT ? window.__lastHT.ink : 0;
  Doc.effect(P,'halftone').params.fill = 1.6;
  await recompute();
  var inkHigh = window.__lastHT ? window.__lastHT.ink : 0;
  check('fill closes the gap between dots', inkHigh > inkLow * 1.5 && inkLow > 0,
    (inkLow * 100).toFixed(1) + '% ink at 60%, ' + (inkHigh * 100).toFixed(1) + '% at 160%');
  Doc.effect(P,'halftone').params.fill = 1;
  await recompute();

  /* The controls that matter less often are folded, not gone. */
  check('each effect panel folds its extra controls', (function(){
    return document.querySelectorAll('#panel-halftone .sec.fold').length === 1 &&
           document.querySelectorAll('#panel-dither .sec.fold').length === 1;
  })());
  check('a folded section opens on a click and closes again', (function(){
    var sec = document.querySelector('#panel-dither .sec.fold');
    if (!sec) return false;
    var h = sec.querySelector('h2');
    if (!sec.classList.contains('closed')) h.click();     // start closed whatever was remembered
    var rows = sec.querySelector('.pr');
    var hiddenBefore = getComputedStyle(rows).display === 'none';
    h.click();
    var shown = getComputedStyle(rows).display !== 'none';
    h.click();
    var hiddenAfter = getComputedStyle(rows).display === 'none';
    return hiddenBefore && shown && hiddenAfter;
  })());
  check('the dither texture is a choice again', (function(){
    var sel = document.querySelector('#panel-dither select.sel');
    return !!sel && sel.options.length >= 10;
  })(), document.querySelector('#panel-dither select.sel') ? document.querySelector('#panel-dither select.sel').options.length + ' options' : 'no select');

  window.App.loadMarkup(beforeSvg, 'roundtrip.svg');
  await wait(1200);
  var R = window.App.selected();
  check('an exported halftone can be opened again', !!R && R.source.items.length > 0,
    R ? R.source.items.length + ' items' : 'nothing');
  if (R) {
    var rb = R.source.bbox;
    check('round trip keeps its proportions',
      Math.abs((rb.width / rb.height) - 1) < 0.08,
      (rb.width / rb.height).toFixed(3));
    await recompute();
    check('round trip renders without error', !err(), err());
  }

  // the dither's outlines have to survive the same trip
  window.App.doc().layers = [P];
  window.App.doc().selection = P.id;
  offAll(P);
  Doc.effect(P,'dither').on = true;
  Object.assign(Doc.effect(P,'dither').params,
    JSON.parse(JSON.stringify(window.DITHER_PRESETS.distressed.params)));
  await recompute();
  var dSvg = window.App.svgText(false);
  window.App.loadMarkup(dSvg, 'roundtrip2.svg');
  await wait(1200);
  var R2 = window.App.selected();
  check('an exported dither can be opened again', !!R2 && R2.source.items.length > 0,
    R2 ? R2.source.items.length + ' items' : 'nothing');

  window.App.doc().layers = [P];
  window.App.doc().selection = P.id;
  await withDeadline(recompute(), 25000, 'restore after round trip');

  /* ---- a shape keeps its holes however many contours it has ----
   *
   * Outlines reach the canvas in chunks of 250, because a hundred thousand
   * subpaths in one Path2D is quadratic to build. Filled chunk by chunk, every
   * hole that landed in a later chunk was drawn as a solid island instead of
   * punched, so anything past 250 contours filled in solid and the artwork
   * disappeared. Under 250 it never showed, which is why it survived this
   * long. The exporter writes every ring into one path and was always right,
   * so the canvas was disagreeing with the file it was previewing. */
  beat('holes survive chunking');
  offAll(P);
  Doc.effect(P,'dither').on = true;
  Object.assign(Doc.effect(P,'dither').params,
    JSON.parse(JSON.stringify(window.DITHER_PRESETS.screenprint.params)));
  await withDeadline(recompute(), 30000, 'chunked holes');
  document.getElementById('fit').click();
  await wait(400);
  await frame();
  check('a shape past one chunk keeps its holes', (function(){
    var canvas = document.getElementById('canvas');
    var g = canvas.getContext('2d');
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var vp = window.App.viewport();
    var m = window.Doc.layerMatrix(P), b = P.source.bbox;
    var holes = 0, seen = 0;
    // A grid well inside the artwork. Filled solid, none of these would show
    // the canvas; a hole is wherever the canvas shows through the ink.
    for (var gy = 3; gy < 18; gy++){
      for (var gx = 3; gx < 18; gx++){
        var w = window.Doc.applyMatrix(m, b.x + b.width * gx / 20, b.y + b.height * gy / 20);
        var s2 = vp.toScreen(w);
        var px = g.getImageData(Math.round(s2.x * dpr), Math.round(s2.y * dpr), 1, 1).data;
        seen++;
        if (Math.abs(px[0] - 30) < 14 && Math.abs(px[1] - 30) < 14 && Math.abs(px[2] - 30) < 14) holes++;
      }
    }
    window.__holePct = seen ? Math.round(holes / seen * 100) : 0;
    return window.__holePct > 12;
  })(), window.__holePct + '% of the artwork shows the canvas');

  /* ---- the preview is the result ----
   *
   * A held slider used to compute something cheaper and different: a coarser
   * screen, and an erosion grid that made the grain more than twice the size.
   * You aimed at one picture and got another the moment you let go. These
   * compare the frame drawn while dragging against the frame after the drag,
   * pixel for pixel, on the paths where the two used to diverge. */
  async function framesMatch(name, setup){
    offAll(P);
    setup();
    await withDeadline(recompute(), 30000, name + ' settle');
    document.getElementById('fit').click();
    await wait(600);
    await frame();

    var canvas = document.getElementById('canvas');
    function snap(){
      return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    }
    /* Both frames forced to a full render before they are read. The viewport
     * keeps a cache and will happily blit or scale it, and a settle timer can
     * land between the two snapshots and redraw one of them at a sub-pixel
     * offset. That is a difference in how a frame reached the screen, not in
     * what was computed, and it is not what this is asking about. */
    var vp = window.App.viewport();
    await withDeadline(recomputeLive(), 30000, name + ' drag');
    await wait(400); vp.invalidate(); await frame();
    var dragging = snap();
    await withDeadline(recompute(), 30000, name + ' commit');
    await wait(400); vp.invalidate(); await frame();
    var settled = snap();

    var differing = 0;
    if (dragging.length !== settled.length) differing = -1;
    else for (var q = 0; q < dragging.length; q += 4){
      if (dragging[q] !== settled[q] || dragging[q+1] !== settled[q+1] ||
          dragging[q+2] !== settled[q+2]) differing++;
    }
    check('preview matches the result: ' + name, differing === 0,
          differing + ' of ' + (dragging.length / 4) + ' pixels differ');
  }

  beat('preview fidelity');
  await framesMatch('halftone', function(){ Doc.effect(P,'halftone').on = true; });
  await framesMatch('halftone, cross dots', function(){
    Doc.effect(P,'halftone').on = true;
    Doc.effect(P,'halftone').params.pattern = 'cross';
  });
  Doc.effect(P,'halftone').params.pattern = 'round';
  await framesMatch('dither', function(){ Doc.effect(P,'dither').on = true; });
  await framesMatch('warp and halftone together', function(){
    Doc.effect(P,'warp').on = true;
    Doc.effect(P,'halftone').on = true;
  });

  // ---- interaction budget ----
  beat('halftone settle');
  offAll(P);
  Doc.effect(P,'halftone').on = true;
  await withDeadline(recompute(), 25000, 'halftone settle');
  var lat = [];
  for (i = 0; i < 8; i++){
    beat('halftone slider ' + i);
    var t0 = performance.now();
    await withDeadline(new Promise(function(resolve){
      var settled = false;
      function finish(){ if (settled) return; settled = true; resolve(); }
      window.__onResult = finish;
      Doc.effect(P,'halftone').params.inkDensity = 0.7 + i*0.03;
      window.App.markDirty(true);
      setTimeout(finish, 9000);
    }), 12000, 'halftone slider ' + i);
    lat.push(Math.round(performance.now()-t0));
  }
  lat.sort(function(a,b){return a-b;});
  check('halftone slider under 180ms', lat[4] < 180, 'median ' + lat[4] + 'ms');

  beat('dither settle');
  offAll(P);
  Doc.effect(P,'dither').on = true;
  await withDeadline(recompute(), 25000, 'dither settle');
  var lat2 = [];
  for (i = 0; i < 8; i++){
    beat('dither slider ' + i);
    var t1 = performance.now();
    await withDeadline(new Promise(function(resolve){
      var settled = false;
      function finish(){ if (settled) return; settled = true; resolve(); }
      window.__onResult = finish;
      Doc.effect(P,'dither').params.roughness = 5 + i*0.4;
      window.App.markDirty(true);
      setTimeout(finish, 9000);
    }), 12000, 'dither slider ' + i);
    lat2.push(Math.round(performance.now()-t1));
  }
  lat2.sort(function(a,b){return a-b;});
  /* 300 rather than 250. Filling a traced photo correctly means compositing
   * its contours through a layer once they pass a chunk, which the old number
   * was set without: it was measured while holes were being filled in solid. */
  check('dither slider under 300ms', lat2[4] < 300, 'median ' + lat2[4] + 'ms');

  // ---- gestures ----
  var canvas = document.getElementById('canvas');
  var vp = window.App.viewport();
  var r0 = canvas.getBoundingClientRect();
  var k0 = vp.view.k, x0 = vp.view.x, y0 = vp.view.y;
  canvas.dispatchEvent(new WheelEvent('wheel',{deltaX:120,deltaY:60,ctrlKey:false,bubbles:true,cancelable:true,clientX:r0.left+200,clientY:r0.top+200}));
  check('two-finger swipe pans', vp.view.x !== x0 && vp.view.y !== y0);
  check('two-finger swipe does not zoom', vp.view.k === k0);
  var k1 = vp.view.k;
  canvas.dispatchEvent(new WheelEvent('wheel',{deltaX:0,deltaY:-40,ctrlKey:true,bubbles:true,cancelable:true,clientX:r0.left+200,clientY:r0.top+200}));
  check('pinch zooms', vp.view.k > k1);

  // frame rate while panning a heavy scene
  /* A hidden window paints no frames, and this used to wait for them with no
   * end: a run with the window covered sat here until the twenty minute
   * limit. Now it gives up after fifteen seconds and reports what it saw,
   * which fails the check instead of hanging the run. */
  function frames(n, mutate){
    return new Promise(function(resolve){
      var c=0, prev=0, d=[], done=false;
      function finish(){
        if (done) return; done = true;
        d.sort(function(a,b){return a-b;});
        resolve(d.length ? {median:d[(d.length/2)|0], p95:d[Math.floor(d.length*0.95)]}
                         : {median:Infinity, p95:Infinity, hidden:true});
      }
      function step(t){ if(done) return; if(prev) d.push(t-prev); prev=t;
        if(c++<n){ mutate(); requestAnimationFrame(step); } else finish(); }
      requestAnimationFrame(step);
      setTimeout(finish, 15000);
    });
  }
  var rr = canvas.getBoundingClientRect();
  beat('pan frame rate');
  var f = await frames(90, function(){
    canvas.dispatchEvent(new WheelEvent('wheel',{deltaX:16,deltaY:6,ctrlKey:false,bubbles:true,cancelable:true,clientX:rr.left+300,clientY:rr.top+300}));
  });
  check('pan holds 60fps on a heavy scene', f.p95 < 24,
    f.hidden ? 'no frames at all: the window was hidden' : 'p95 ' + f.p95.toFixed(1) + 'ms');

  // ---- memory does not run away ----
  var mem0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  for (i = 0; i < 25; i++){
    beat('heap loop ' + i);
    if (i % 5 === 0) await wait(0);
    Doc.effect(P,'halftone').params.pitch = 4 + (i % 7);
    await withDeadline(recompute(), 20000, 'heap loop ' + i);
  }
  var mem1 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  var grewMb = Math.round((mem1-mem0)/1048576);
  check('heap stable over 25 recomputes', !mem0 || grewMb < 400, grewMb + 'MB growth');

  // ---- every panel control still has a name ----
  check('no unlabelled controls', [].slice.call(document.querySelectorAll('.pr'))
    .filter(function(row){ return row.querySelector('input,select,button') && !row.querySelector('.lbl,.lbl2'); }).length === 0);
  check('all tiles captioned',
    document.querySelectorAll('.tiles .preset').length ===
    document.querySelectorAll('.tiles .preset .cap').length);

  return JSON.stringify({
    total: results.length,
    passed: results.filter(function(x){return x.pass;}).length,
    failed: failures.length,
    failures: failures,
    timings: {
      warpMedian: warpTimes.sort(function(a,b){return a-b;})[(warpTimes.length/2)|0],
      ditherMedian: ditherTimes.sort(function(a,b){return a-b;})[(ditherTimes.length/2)|0],
      stack: stacked.ms,
      photoHalftone: photoHt.ms,
      photoDither: photoDither.ms,
      halftoneSlider: lat[4],
      ditherSlider: lat2[4],
      panP95: +f.p95.toFixed(1),
      heapGrowthMb: grewMb
    },
    results: results
  });
})()`;

async function run(win, app, outDir) {
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 900));
  // Half the checks read pixels off the canvas, and the canvas is painted in
  // animation frames, which stop the moment another window covers this one.
  // A run that stalled for ten minutes turned out to be sitting behind the
  // installed copy of the app.
  win.setAlwaysOnTop(true);
  win.show();
  win.focus();

  // If the page never comes back, say where it got to rather than leaving a
  // window open with nothing written.
  const HARD_LIMIT = 20 * 60 * 1000;
  const giveUp = new Promise((resolve) => setTimeout(async () => {
    let at = 'unknown';
    try {
      at = await win.webContents.executeJavaScript('JSON.stringify(window.__suiteProgress||null)');
    } catch (e) { /* window gone */ }
    resolve(JSON.stringify({ error: 'suite did not finish within ' +
      (HARD_LIMIT / 60000) + ' minutes', lastProgress: at }));
  }, HARD_LIMIT));

  let result;
  try {
    result = await Promise.race([win.webContents.executeJavaScript(SCRIPT, true), giveUp]);
  } catch (err) {
    result = JSON.stringify({ error: String(err.stack || err) });
  }
  fs.writeFileSync(path.join(outDir, 'suite.json'), result);
  app.quit();
}
module.exports = { run };
