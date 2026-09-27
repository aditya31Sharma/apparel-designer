/* Timing harness, driving the real event path rather than poking the viewport.
 * A synthetic redraw loop skips the overlay rebuild and the HUD update that a
 * real wheel event triggers, which is exactly where a stall would hide. */
'use strict';
const fs = require('fs');
const path = require('path');

const SCRIPT = `(async function(){
  function wait(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
  var out = { cores: navigator.hardwareConcurrency, isolated: crossOriginIsolated, scenes: {} };
  var Doc = window.Doc;
  var canvas = document.getElementById('canvas');

  async function loadFile(name, type){
    var blob = await (await fetch(name)).blob();
    var f = new File([blob], name, {type:type});
    var dt = new DataTransfer(); dt.items.add(f);
    var input = document.getElementById('file');
    input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles:true}));
    await wait(2200);
    return window.App.selected();
  }

  function recompute(){
    return new Promise(function(resolve){
      window.__onResult = resolve;
      window.App.markDirty(false);
      setTimeout(function(){ if (window.__onResult){ window.__onResult=null; resolve(); } }, 25000);
    });
  }

  /* Fire real wheel events, the way a trackpad does, and watch the frame rate.
   * This is the path that also rebuilds the selection overlay and the HUD. */
  function wheelGesture(opts, count){
    return new Promise(function(resolve){
      var r = canvas.getBoundingClientRect();
      var cx = r.left + r.width/2, cy = r.top + r.height/2;
      var n = 0, prev = 0, deltas = [];
      function step(t){
        if (prev) deltas.push(t - prev);
        prev = t;
        if (n++ < count){
          // Trackpads deliver several events per displayed frame.
          for (var i=0;i<2;i++){
            canvas.dispatchEvent(new WheelEvent('wheel', Object.assign({
              bubbles:true, cancelable:true, clientX:cx, clientY:cy
            }, opts)));
          }
          requestAnimationFrame(step);
        } else {
          deltas.sort(function(a,b){return a-b});
          resolve({
            median: +deltas[(deltas.length/2)|0].toFixed(1),
            p95: +deltas[Math.floor(deltas.length*0.95)].toFixed(1),
            worst: +deltas[deltas.length-1].toFixed(1),
            fps: Math.round(1000/deltas[(deltas.length/2)|0])
          });
        }
      }
      requestAnimationFrame(step);
    });
  }

  async function measureScene(label, setup){
    var t0 = performance.now();
    setup();
    window.App.syncPanels();
    window.__timing = {};
    await recompute();
    var compute = Math.round(performance.now() - t0);
    document.getElementById('fit').click();
    await wait(700);

    var pan = await wheelGesture({deltaX:14, deltaY:5, ctrlKey:false}, 80);
    await wait(600);
    var zoom = await wheelGesture({deltaX:0, deltaY:-6, ctrlKey:true}, 60);
    await wait(600);

    /* The adversarial case: flick, pause long enough for the crisp re-render to
     * fire, flick again. That is what a person actually does, and it is the
     * only pattern that makes the cache rebuild show up in a frame time. */
    var stalls = [];
    for (var s = 0; s < 8; s++) {
      await wheelGesture({deltaX: 90, deltaY: 30, ctrlKey: false}, 8);
      var worst = 0, frames = 0;
      await new Promise(function (resolve) {
        var prev = 0;
        function watch(t) {
          if (prev) worst = Math.max(worst, t - prev);
          prev = t;
          if (++frames < 22) requestAnimationFrame(watch); else resolve();
        }
        requestAnimationFrame(watch);
      });
      stalls.push(Math.round(worst));
    }
    stalls.sort(function (a, b) { return a - b; });

    // A full cache rebuild is what happens every time a gesture leaves the
    // cached area or a zoom settles, so it is the stall a person would feel.
    var vp = window.App.viewport();
    var rt = [];
    for (var i = 0; i < 5; i++) {
      var t1 = performance.now();
      vp.render();
      vp.present();
      rt.push(performance.now() - t1);
    }
    rt.sort(function(a,b){return a-b});

    out.scenes[label] = {
      compute: compute,
      mainThread: window.__timing || null,
      cacheRebuild: Math.round(rt[2]),
      settleStall: { median: stalls[4], worst: stalls[stalls.length-1], all: stalls },
      dpr: window.devicePixelRatio,
      stats: document.getElementById('stats').textContent,
      pan: pan, zoom: zoom
    };
  }

  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200">' +
    '<path d="M20 40h160v120h-160z" fill="#ff3366"/>' +
    '<circle cx="300" cy="100" r="80" fill="#2244ff"/>' +
    '<path d="M430 30 L570 170 L430 170 Z" fill="#00cc88"/></svg>';
  window.App.loadMarkup(svg, 'shapes.svg');
  await wait(900);
  var L = window.App.selected();

  await measureScene('vector_halftone', function(){
    L.effects.forEach(function(e){ e.on = false; });
    Doc.effect(L,'halftone').on = true;
    Doc.effect(L,'halftone').params.frequency = 140;
  });

  var P = await loadFile('doom-test.jpg','image/jpeg');
  await measureScene('photo_halftone', function(){
    P.effects.forEach(function(e){ e.on = false; });
    Doc.effect(P,'halftone').on = true;
  });
  await measureScene('photo_halftone_fine', function(){
    P.effects.forEach(function(e){ e.on = false; });
    Doc.effect(P,'halftone').on = true;
    Doc.effect(P,'halftone').params.frequency = 320;
  });
  await measureScene('photo_dither_texture', function(){
    P.effects.forEach(function(e){ e.on = false; });
    Doc.effect(P,'dither').on = true;
    Object.assign(Doc.effect(P,'dither').params,
      {texture:'rough', textureAmount:0.4, roughness:7, spread:4});
  });

  out.finalError = document.getElementById('err').textContent || 'none';
  return JSON.stringify(out);
})()`;

async function run(win, app, outDir) {
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 800));
  let result;
  try { result = await win.webContents.executeJavaScript(SCRIPT, true); }
  catch (err) { result = JSON.stringify({ error: String(err.stack || err) }); }
  fs.writeFileSync(path.join(outDir, 'bench.json'), result);
  app.quit();
}
module.exports = { run };
