/* Boot the real window, drive the real app, write the result to disk and quit.
 * Proves the desktop build works without anyone having to watch a window. */
'use strict';
const fs = require('fs');
const path = require('path');

const SCRIPT = `(async function(){
  function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }
  var out = { steps: [] };
  function step(name, val){ out.steps.push(name + ': ' + val); }

  try {
    step('crossOriginIsolated', String(window.crossOriginIsolated));
    step('SharedArrayBuffer', typeof SharedArrayBuffer);
    step('desktopBridge', window.desktop ? 'present' : 'MISSING');
    step('modules', ['Warp','Grunge','Halftone','Raster','Doc','Effects','SvgOut','Viewport','Overlay','App']
      .filter(function(m){ return !window[m]; }).join(',') || 'all present');

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120">' +
      '<path d="M20 20h80v80h-80z" fill="#ff3366"/>' +
      '<circle cx="180" cy="60" r="45" fill="#2244ff"/>' +
      '<path d="M250 20 L290 100 L210 100 Z" fill="none" stroke="#00cc88" stroke-width="6"/></svg>';
    window.App.loadMarkup(svg, 'selftest.svg');
    await wait(900);

    var L = window.App.selected();
    step('layerLoaded', L ? L.name : 'NONE');
    step('nothingAppliedByDefault',
      L.effects.every(function(e){ return !e.on; }) ? 'yes' : 'NO');

    L.transform.x = 90; L.transform.y = 40;
    L.transform.width = 480; L.transform.height = 200;
    L.transform.rotation = 9;
    L.paint.opacity = 0.85;
    var before = JSON.stringify([L.transform, L.paint]);

    window.Doc.effect(L,'warp').on = true;
    window.Doc.effect(L,'dither').on = true;
    window.Doc.effect(L,'halftone').on = true;
    window.App.syncPanels();
    window.App.markDirty(false);
    await wait(3500);

    step('workerRan', document.getElementById('stats').textContent || 'NO STATS');
    step('transformSurvived', before === JSON.stringify([L.transform, L.paint]) ? 'yes' : 'NO');
    step('error', document.getElementById('err').textContent || 'none');

    var file = window.App.svgText(false);
    step('svgBytes', String(file.length));
    step('svgPaths', String((file.match(/<path /g)||[]).length));
    step('svgClean', /NaN|undefined/.test(file) ? 'HAS NaN' : 'clean');

    // gestures
    var canvas = document.getElementById('canvas');
    var vp = window.App.viewport();
    var k0 = vp.view.k, x0 = vp.view.x;
    canvas.dispatchEvent(new WheelEvent('wheel',
      {deltaX:100, deltaY:40, ctrlKey:false, bubbles:true, cancelable:true, clientX:400, clientY:300}));
    step('twoFingerSwipePans', (vp.view.x !== x0 && vp.view.k === k0) ? 'yes' : 'NO');
    var k1 = vp.view.k;
    canvas.dispatchEvent(new WheelEvent('wheel',
      {deltaX:0, deltaY:-50, ctrlKey:true, bubbles:true, cancelable:true, clientX:400, clientY:300}));
    step('pinchZooms', vp.view.k > k1 ? 'yes' : 'NO');

    document.getElementById('tool-halftone').click();
    document.getElementById('fit').click();
    await wait(600);

    step('unlabelledControls', String([].slice.call(document.querySelectorAll('.pr'))
      .filter(function(r){ return r.querySelector('input,select,button') && !r.querySelector('.lbl,.lbl2'); }).length));
    step('tiles', String(document.querySelectorAll('.tiles .preset').length));

    var st = await window.desktop.backgroundStatus();
    step('bgModel', JSON.stringify(st));
  } catch (err) {
    step('EXCEPTION', (err && err.stack) || String(err));
  }
  return JSON.stringify(out);
})()`;

async function run(win, app, outDir) {
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 700));
  let result;
  try {
    result = await win.webContents.executeJavaScript(SCRIPT, true);
  } catch (err) {
    result = JSON.stringify({ steps: ['HARNESS ERROR: ' + (err.stack || err)] });
  }
  fs.writeFileSync(path.join(outDir, 'selftest.json'), result);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'selftest.png'), img.toPNG());
  app.quit();
}

module.exports = { run };
