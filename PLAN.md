# Warp v2 — complete build plan

Approved 2026-09-27. Supersedes the design doc at
`~/.gstack/projects/Codes/2026-09-27-design-warp-desktop-halftone.md`.

---

## 0. What Warp v2 is

A local desktop design tool for one job: take a piece of artwork and put a print
effect through it, as real vectors, at production quality.

Three effects, each independent, each toggleable, none applied by default:

- **Warp** — 18 deformation presets plus four free corner handles
- **Dither** — SDF ink erosion, spread, nine grunge textures, melt
- **Halftone** — CMYK screen with real dot shapes, angles, and paper simulation

Around them, a proper document: a layer that owns its position, size, rotation,
opacity, fill and stroke, and keeps all of it no matter which effects are on.

Everything exports as SVG. Everything stays vector.

---

## 1. The hard requirement: Photoshop-smooth

This is the requirement that dictates the architecture, so it comes first.

### Why the current build stutters

| Cause | Cost today |
|---|---|
| Result is an SVG `<path>` with a `d` string up to 780KB. Chrome re-parses it on every change | 30-80ms |
| Building that `d` string in JS is 100k+ string concatenations | 20-40ms |
| The pixel grid is rebuilt as hundreds of SVG `<line>` nodes on every draw | 5-15ms |
| Dither and halftone run synchronously on the main thread, so the UI is frozen while they run | 40-400ms |

Add those up on a slider drag and it is 100-500ms per frame. That is the stutter.
It is not the browser. Electron would run exactly the same code at exactly the
same speed.

### The fix: three-tier rendering

**Tier 1, geometry changed.** A worker computes the effect and transfers back
typed arrays: `Float32Array` of points plus an `Int32Array` of ring offsets. No
strings. The main thread turns those into `Path2D` objects with `moveTo` and
`lineTo`, which is roughly 10x faster than parsing a `d` string. Then it renders
once into an offscreen canvas at device resolution.

**Tier 2, pan.** Blit the cached bitmap at an offset. No path filling, no
geometry, no layout. Sub-millisecond, so panning is locked at 60fps no matter how
many contours the artwork has.

**Tier 3, zoom.** Scale the cached bitmap during the gesture. It goes slightly
soft mid-pinch, exactly like Photoshop does, then re-renders crisp 80ms after the
gesture stops.

The `d` string is built only on export, when nobody is watching a frame counter.

### Progressive quality

While a slider is held down, the worker runs at 40% resolution with double the
simplification tolerance. That is roughly 6x cheaper and reads as identical at
screen size. On release it runs at full quality. In-flight jobs are cancelled by
generation counter, so dragging a slider fast never queues up work.

### Viewport

Canvas 2D for the artwork and grid. A thin SVG overlay, about nine nodes, for
handles and snap guides, so hit-testing and crisp 1px lines stay easy. This is the
same hybrid Figma and Illustrator use.

### Trackpad, done properly

macOS sends a two-finger swipe as `wheel` with `ctrlKey:false`, and a pinch as
`wheel` with `ctrlKey:true`. Today every wheel event zooms, which is the bug.

| Gesture | Result |
|---|---|
| Two-finger swipe | Pan, following the fingers, both axes |
| Pinch | Zoom about the cursor |
| Shift + scroll | Pan horizontally (mouse convention) |
| Cmd + scroll | Zoom (mouse convention) |
| Space + drag | Pan, like Figma |
| Middle-drag | Pan |

### Target numbers

Measured on the 421x128 sample at 5,000 contours, and again on a 3000x3000 photo
at halftone frequency 200:

| Interaction | Budget |
|---|---|
| Pan | under 2ms per frame |
| Pinch zoom | under 4ms per frame |
| Slider drag, preview quality | under 40ms, off the main thread |
| Slider release, full quality | under 400ms, UI stays live throughout |
| Import to first paint | under 300ms |

These get asserted in a benchmark script, not eyeballed.

---

## 2. Document model

```
Document
  layers:    [Layer]
  selection: layerId | null

Layer
  id, name
  source:    { kind: 'svg'|'image', items: [{d, fill, stroke, strokeWidth}] | bitmap }
  transform: { x, y, width, height, rotation, flipX, flipY }
  paint:     { fill, fillOn, stroke, strokeWidth, opacity, blend, useSourceColours }
  effects:   [ { type, on, params } ]     // ordered, empty on a fresh document
  matte:     { mask: Uint8Array, w, h } | null   // from background removal
```

Effects are a registry, not a switch statement:

```js
Effects.register('halftone', {
  label: 'Halftone',
  defaults: { ... },
  worker: 'halftone-worker.js',
  // geometry in, geometry out. Never sees the transform.
  apply(input, params, ctx) -> { paths: [{points, rings, fill, blend}], stats }
});
```

Render order, every frame:

```
source -> effect stack (in order, skipping on:false) -> paint -> transform -> canvas
```

Because the transform is applied last and effects never see it, position, size,
rotation and opacity survive every effect change. That is request 7, and it comes
free from the ordering rather than from special-casing.

An empty effect stack on boot is request 3. A per-effect `on` boolean is request 5.

---

## 3. Halftone engine (`halftone.js`, no DOM, node-testable)

### Pipeline

1. **Separate.** RGB to CMYK with under-colour removal.
   `K = 1 - max(r,g,b)`, then `C = (1-r-K)/(1-K)`, same for M and Y, with a
   black-generation curve so shadows do not go muddy. GCR amount is a dial.
2. **Summed-area table** per channel. Averaging a cell of any size becomes four
   array reads, so cost stays flat as frequency rises. This is the difference
   between a responsive frequency slider and a frozen one.
3. **Screen.** Per channel, walk a grid rotated to that channel's angle.
   Traditional is C 15, M 75, Y 0, K 45. The reference uses C 15, M -15, Y 0,
   K 45, the same 30-degree separation. Both ship as presets; every angle is a dial.
4. **Dot area.** `r = (spacing/2) * sqrt(coverage * inkDensity) * shapeFactor`.
   Area-proportional, not radius-proportional, because printed tone is dot *area*.
   Radius-proportional is the classic amateur mistake and it makes midtones wrong.
5. **Modulate.** Each of these maps to one control in the reference:
   - *Roughness* — seeded jitter on cell centre and radius
   - *Fuzziness* — the dot becomes an n-gon with noise-perturbed vertices
   - *Paper fibre* — low-frequency noise subtracting ink pickup, reusing `grunge.js` fbm
   - *Ink texture* — a second noise field mottling each dot
   - *Ink density* — global multiplier on dot area
6. **Emit.** One compound path per channel, built from arc pairs for round dots and
   line segments for the rest. Four nodes, not 74,000.
7. **Composite.** `mix-blend-mode: multiply` per channel group. Illustrator honours it.

### Controls

| Group | Controls |
|---|---|
| Screen | Pattern (round, square, ellipse, line, cross, diamond), Frequency, Angle per channel |
| Ink | Ink density, Ink texture, Dot gain curve |
| Paper | Roughness, Fuzziness, Paper fibre |
| Channels | Cyan, Magenta, Yellow, Black on/off |
| Mode | CMYK, Duotone, Mono (K only) |
| Presets | Newsprint, Comic, Risograph, Fine art, Coarse poster, Photocopy |

Mono and duotone matter more than CMYK for most Tenzen work, so they are modes,
not afterthoughts.

### Cost honesty

A live dot counter next to the frequency slider, the same as the dither's contour
counter. Frequency 136 on a square image is 18,496 cells per channel, 74k dots.
Frequency 300 is 360k. The counter says so before you hit export.

---

## 4. Background removal (`bgremove.js`, main process)

`onnxruntime-node` running **BiRefNet-lite**, MIT licensed. This is the
architecture BRIA's RMBG-2.0 is built on; RMBG-2.0 scores a few points higher but
ships under a licence needing a paid agreement for commercial use.

- Model, about 180MB, downloaded once into `app.getPath('userData')` on first use.
  Never bundled, so the app download stays small.
- Roughly 1-3s per image on Apple silicon CPU.
- Returns an alpha matte stored on the layer.
- The matte feeds the halftone's ink coverage and the dither's raster trace, so
  removing the background actually removes it from the vector output rather than
  just hiding it behind something.
- Offline or model missing: falls back to the luminance threshold already in
  `grunge.js`, and says so.
- Controls: Remove, Restore, Edge feather, Matte threshold, and a view toggle to
  inspect the matte itself.

---

## 5. Transform and colour panel

Always visible, above the effect tabs, Figma-shaped:

```
X  [      ]   Y  [      ]        Fill     [swatch] [#hex]
W  [      ]   H  [      ] [lock] Stroke   [swatch] [weight]
Rotation [    ]  Flip [H] [V]    Opacity  [    ] %
                                 Blend    [Normal          v]
```

On canvas: eight resize handles, a rotate handle outside each corner, arrow-key
nudge at 1px, shift for 10px, proportional resize with the lock or by holding
shift, and all the pixel and alignment snapping already in `snap.js`.

These values are never derived from the effect output. They are the layer's own,
which is why they survive everything.

---

## 6. Standalone or web

**Standalone wins.** Four concrete reasons, not preference:

1. **Workers, without needing a server running.** A page opened straight off
   disk cannot start a Web Worker at all, so the heavy compute would be stuck on
   the main thread. The desktop build serves itself over its own `app://` scheme,
   which gets the worker running with nothing for you to start first.

   *Correction to what I said before the build:* I claimed SharedArrayBuffer was
   the decisive reason, because it needs COOP and COEP headers that GitHub Pages
   cannot set. Half right. Those headers can be set here, and are, but Chromium
   only grants cross-origin isolation to http and https origins, so a custom
   scheme does not get SharedArrayBuffer either. It turned out not to matter:
   worker results go back as transferable ArrayBuffers, which hand over ownership
   without copying, so the hot path never copied anything in the first place.
2. **Memory.** A 4000px image at halftone frequency 200 needs four Float32
   summed-area tables, about 256MB, plus source and output. A browser tab gets
   killed. An Electron process does not.
3. **Local background removal.** `onnxruntime-node` loads the model from disk once.
   The browser equivalent pulls 180MB into cache and re-initialises per cold load.
4. **Real files.** Native open and save dialogs, actual file paths, recent files,
   drag from Finder, and saving over the file you opened. Downloads folder blobs
   are not a workflow.

**What it costs:** about 120MB per build, a `npm run build` step, and macOS
Gatekeeper will warn on first open unless the app is notarised, which needs a paid
Apple Developer account. Right-click, Open, once, and it never asks again.

**What we keep anyway:** the renderer stays plain HTML, CSS and JS files. `serve.py`
still serves it as a web page for a quick look, and the GitHub Pages build keeps
working with background removal and very large images unavailable. One codebase,
two targets, near-zero extra cost, because an Electron renderer *is* a web page.

---

## 7. File layout

```
warp-tool/
  package.json
  electron/
    main.js            window, menus, native dialogs, headers
    preload.js         the only bridge, contextIsolation on
    bgremove.js        onnxruntime-node + BiRefNet
  src/
    engine/
      warp.js          unchanged
      grunge.js        unchanged
      halftone.js      new
      importer.js      unchanged
      snap.js          unchanged
    doc/
      model.js         Document, Layer, undo stack
      effects.js       registry
    view/
      viewport.js      canvas, three-tier render, gestures
      overlay.js       handles, guides, rotation
      panels.js        transform, paint, per-effect panels
      chrome.js        icons, tooltips, switches
    workers/
      dither.worker.js
      halftone.worker.js
    export/
      svg.js           geometry to SVG, separations, transform baked
  index.html
  serve.py             still works, for the web target
```

Engines move but do not change. `app.js` is replaced, not patched.

---

## 8. Build order

Each step ends working and verifiable. Nothing is left half-wired.

| # | Step | Proof it works |
|---|---|---|
| 1 | `halftone.js` engine + node test harness | Dot counts, angles and ink coverage asserted numerically, no UI |
| 2 | Document model + effect registry | Warp, Dither, Halftone all run as stack entries; empty stack on boot |
| 3 | Canvas viewport, three-tier render, gestures | Pan under 2ms, pinch zooms, swipe pans, benchmark script asserts it |
| 4 | Transform + paint panel, canvas handles, rotation | Values survive toggling every effect on and off |
| 5 | Workers + progressive preview | UI stays live during a 400ms halftone; generation counter cancels stale jobs |
| 6 | Electron shell, native open and save, menus | Opens a file from Finder, saves over it |
| 7 | Background removal | Matte feeds halftone coverage; offline fallback path tested |
| 8 | SVG export across all three effects + transform + separations | Round-trips into Illustrator with dot pitch intact |
| 9 | Sample chips removed, drag-and-drop kept | Fresh launch shows an empty canvas and no effect applied |

---

## 9. Out of scope

Named so it is a decision rather than a surprise:

- Multiple layers in one document. The model supports it; the UI ships single-layer.
- Undo across effect params. Undo covers transform, paint and stack changes first.
- Windows and Linux builds. macOS only until asked.
- Code signing and notarisation. Right-click-Open until it is worth the developer account.
- Text tool. Explicitly dropped earlier.

---

## 10. The assignment

Take one real Tenzen print file through the whole chain the day it lands: import
the SVG, remove the background, set the halftone to the frequency your printer
actually runs, export, and open it in Illustrator. The maths will be fine. The
thing that will break is whether the exported dot pitch survives the trip to a
real RIP. Find that out on a file you intend to print.
