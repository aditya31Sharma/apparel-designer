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
      requestAnimationFrame(function(){ requestAnimationFrame(r); });
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

  /* A short recommended group at the top of each panel, and nothing appearing
   * in both it and the full list below. */
  ['DITHER_PRESETS', 'HALFTONE_PRESETS'].forEach(function (table) {
    var t = window[table];
    var starred = Object.keys(t).filter(function (k) { return t[k].star; });
    check(table + ' has a recommended group', starred.length >= 2 && starred.length <= 4,
      starred.join(',') || 'none');
  });
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

  /* A fully transparent area is paper and must take no ink. Resampling used to
   * leave black gaps wherever the working bitmap was larger than the photo,
   * which screened the empty space at about fifty per cent. */
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
    return px[0] > 225 && px[1] > 225 && px[2] > 225;
  })(), JSON.stringify(window.__cornerPx));

  window.App.doc().layers = [P];
  window.App.doc().selection = P.id;

  // ---- background removal ----
  clearErr();
  var st = await window.desktop.backgroundStatus();
  check('background model status reachable', !!st, JSON.stringify(st));

  if (st && st.ready) {
    offAll(P);
    var tBg = performance.now();
    document.getElementById('removeBg').click();
    for (i = 0; i < 180; i++){ await wait(500); if (P.matte) break; }
    var bgMs = Math.round(performance.now() - tBg);
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
      P.matte = null;
      await recompute();
    }
  } else {
    check('background model absent, reported honestly', true, JSON.stringify(st));
  }

  /* Round trip. An export that cannot be opened again is not an export, and
   * the importer and the exporter are the two halves most likely to drift. */
  offAll(P);
  Doc.effect(P,'halftone').on = true;
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
    JSON.parse(JSON.stringify(window.DITHER_PRESETS.charcoal.params)));
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
    var light = 0, seen = 0;
    // A grid well inside the artwork. Filled solid, none of these is paper.
    for (var gy = 3; gy < 18; gy++){
      for (var gx = 3; gx < 18; gx++){
        var w = window.Doc.applyMatrix(m, b.x + b.width * gx / 20, b.y + b.height * gy / 20);
        var s2 = vp.toScreen(w);
        var px = g.getImageData(Math.round(s2.x * dpr), Math.round(s2.y * dpr), 1, 1).data;
        seen++;
        if (px[0] > 170 && px[1] > 170 && px[2] > 170) light++;
      }
    }
    window.__holePct = seen ? Math.round(light / seen * 100) : 0;
    return window.__holePct > 12;
  })(), window.__holePct + '% of the artwork is paper');

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
  function frames(n, mutate){
    return new Promise(function(resolve){
      var c=0, prev=0, d=[];
      function step(t){ if(prev) d.push(t-prev); prev=t;
        if(c++<n){ mutate(); requestAnimationFrame(step); }
        else { d.sort(function(a,b){return a-b;}); resolve({median:d[(d.length/2)|0], p95:d[Math.floor(d.length*0.95)]}); } }
      requestAnimationFrame(step);
    });
  }
  var rr = canvas.getBoundingClientRect();
  beat('pan frame rate');
  var f = await frames(90, function(){
    canvas.dispatchEvent(new WheelEvent('wheel',{deltaX:16,deltaY:6,ctrlKey:false,bubbles:true,cancelable:true,clientX:rr.left+300,clientY:rr.top+300}));
  });
  check('pan holds 60fps on a heavy scene', f.p95 < 24, 'p95 ' + f.p95.toFixed(1) + 'ms');

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
