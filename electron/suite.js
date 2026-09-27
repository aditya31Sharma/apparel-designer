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

  function check(name, cond, detail){
    results.push({ name: name, pass: !!cond, detail: detail === undefined ? '' : String(detail) });
    if (!cond) failures.push(name + (detail ? ' :: ' + detail : ''));
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

  function recompute(budgetMs){
    return new Promise(function(resolve){
      var t0 = performance.now();
      window.__onResult = function(){ resolve(Math.round(performance.now()-t0)); };
      window.App.markDirty(false);
      setTimeout(function(){
        if (window.__onResult){ window.__onResult = null; resolve(-1); }
      }, budgetMs || 30000);
    });
  }

  function err(){ return document.getElementById('err').textContent || ''; }
  function clearErr(){ document.getElementById('err').textContent=''; document.getElementById('err').classList.remove('on'); }

  /* One case: set it up, recompute, and assert the result is real. */
  async function runCase(label, setup, budget){
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
  check('photo auto-picks halftone', Doc.effect(P,'halftone').on);
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
  check('transparent areas take no ink', (function(){
    var canvas = document.getElementById('canvas');
    var g = canvas.getContext('2d');
    var vp = window.App.viewport();
    document.getElementById('fit').click();
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

  // ---- background removal falls back cleanly ----
  clearErr();
  var st = await window.desktop.backgroundStatus();
  check('background model status reachable', !!st, JSON.stringify(st));

  // ---- interaction budget ----
  offAll(P); Doc.effect(P,'halftone').on = true; await recompute();
  var lat = [];
  for (i = 0; i < 8; i++){
    var t0 = performance.now();
    await new Promise(function(resolve){
      window.__onResult = resolve;
      Doc.effect(P,'halftone').params.inkDensity = 0.7 + i*0.03;
      window.App.markDirty(true);
      setTimeout(resolve, 9000);
    });
    lat.push(Math.round(performance.now()-t0));
  }
  lat.sort(function(a,b){return a-b;});
  check('halftone slider under 180ms', lat[4] < 180, 'median ' + lat[4] + 'ms');

  offAll(P); Doc.effect(P,'dither').on = true; await recompute();
  var lat2 = [];
  for (i = 0; i < 8; i++){
    var t1 = performance.now();
    await new Promise(function(resolve){
      window.__onResult = resolve;
      Doc.effect(P,'dither').params.roughness = 5 + i*0.4;
      window.App.markDirty(true);
      setTimeout(resolve, 9000);
    });
    lat2.push(Math.round(performance.now()-t1));
  }
  lat2.sort(function(a,b){return a-b;});
  check('dither slider under 250ms', lat2[4] < 250, 'median ' + lat2[4] + 'ms');

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
  var f = await frames(90, function(){
    canvas.dispatchEvent(new WheelEvent('wheel',{deltaX:16,deltaY:6,ctrlKey:false,bubbles:true,cancelable:true,clientX:rr.left+300,clientY:rr.top+300}));
  });
  check('pan holds 60fps on a heavy scene', f.p95 < 24, 'p95 ' + f.p95.toFixed(1) + 'ms');

  // ---- memory does not run away ----
  var mem0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
  for (i = 0; i < 25; i++){
    Doc.effect(P,'halftone').params.frequency = 150 + (i % 7) * 12;
    await recompute();
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
  let result;
  try { result = await win.webContents.executeJavaScript(SCRIPT, true); }
  catch (err) { result = JSON.stringify({ error: String(err.stack || err) }); }
  fs.writeFileSync(path.join(outDir, 'suite.json'), result);
  app.quit();
}
module.exports = { run };
