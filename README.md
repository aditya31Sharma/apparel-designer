# Apparel Designer

A local desktop tool for putting print effects through garment artwork. Vector in,
vector out, at production quality.

Three effects, independent, none applied until you switch one on:

| | |
|---|---|
| **Warp** | 18 deformation presets plus four live corner handles |
| **Dither** | SDF ink erosion, spread, nine grunge textures, melt |
| **Halftone** | CMYK dot screen with real shapes, angles and paper simulation |

Around them a proper document: the layer owns its position, size, rotation,
opacity, fill and stroke, and keeps every one of them no matter which effects run.

## Running it

```bash
npm install
npm start          # the desktop app
npm run web        # the same thing as a web page, on :8900
npm test           # 83 engine checks, no browser needed
```

macOS will warn on first launch because the build is not notarised. Right-click the
app, choose Open, agree once, and it never asks again.

## Halftone

A printing RIP, done as geometry:

1. Separate RGB into cyan, magenta, yellow and black, with adjustable black generation
2. Build a summed-area table per channel, so averaging a screen cell of any size is
   four array reads and the cost stops depending on frequency
3. Lay a square grid per channel, rotated to that channel's screen angle
4. Size each dot so the **ink that lands** matches the tone that was asked for
5. Emit one compound path per ink, composited with multiply

Step 4 is the one worth explaining. A round dot inscribed in its cell can only ever
cover pi/4 of it, so the obvious `r = half * sqrt(coverage)` prints every tone 21%
too light, and past about 70% the dots have to overlap their neighbours in a way no
tidy formula covers across six different dot shapes. So the relationship is measured
rather than derived: one cell of the periodic lattice is rasterised at a range of dot
sizes, and that curve is inverted. The tests assert tone accuracy across the range,
for every shape. It lands within 0.2%.

Dot shapes: round, square, ellipse, line, cross, diamond. Modes: CMYK, duotone, mono.

**Export** gives one compound path per ink inside a multiply group, so Illustrator
opens four objects rather than a hundred thousand. `Plates` writes each ink as its
own named group, unblended, which is what a printer asks for.

## Background removal

BiRefNet-lite through `onnxruntime-node`, locally. MIT licensed, which matters
because BRIA's RMBG-2.0 scores a few points higher but ships under a licence needing
a paid agreement for commercial use.

The model is about 180MB and is fetched once on first use into the app's data
directory, never bundled. Nothing is uploaded; the image does not leave the machine.
Without the model, or offline, it falls back to a corner-colour cut and says so.

The resulting matte feeds the halftone's ink coverage and the dither's trace, so
removing the background genuinely removes it from the vector output rather than
hiding it behind something.

## How it stays smooth

Three tiers, because a pan should not cost what a render costs:

| Tier | When | What happens |
|---|---|---|
| render | geometry changed | worker computes, main thread builds Path2D once, draws into an offscreen cache |
| present | pan | blit the cache at an offset. No paths touched |
| zoom | pinch | scale the cache during the gesture, re-render crisp 90ms after it stops |

Nothing builds path data as a string during interaction. Shapes arrive as Path2D,
halftone dots arrive as `Float32Array` quads of `[cx, cy, r, phase]`, and both get
drawn under a matrix. The `d` string is built only on export.

While a slider is held the worker runs at 42% resolution, which is roughly six times
cheaper and indistinguishable at screen size; full quality follows 130ms after you
let go. Every job carries a generation number, so results from a superseded job are
dropped rather than drawn.

Measured at 29,793 dots on screen: 60fps sustained while panning, zooming, and even
while re-rendering every frame.

## Trackpad

macOS reports a two-finger swipe as a wheel event with `ctrlKey` false and a pinch as
one with `ctrlKey` true. Treating both as zoom, which is the naive reading, makes a
trackpad unusable.

| Gesture | Result |
|---|---|
| Two-finger swipe | Pan, both axes |
| Pinch | Zoom about the cursor |
| Shift + scroll | Pan horizontally |
| Cmd + scroll | Zoom |
| Space + drag, or middle-drag | Pan |

## Layout

```
electron/     main process, preload bridge, background removal
src/engine/   warp, grunge, halftone, raster, importer, snap   (no DOM, node-testable)
src/doc/      document model, effect registry, the three registrations
src/view/     viewport, overlay, control specs, panel builder, icons
src/workers/  the effect stack, off the main thread
src/export/   geometry to SVG
test/         83 checks
```

Adding a fourth effect means one registration in `src/doc/register-effects.js` and
one spec in `src/view/specs.js`. Nothing in the viewport, the exporter or the
transform code has to change.

## Samples

`LICENSE-SAMPLES.md` covers the bundled outlines.
