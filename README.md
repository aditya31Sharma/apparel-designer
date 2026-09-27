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
npm test           # 107 engine checks, no browser needed
npm run suite      # 370+ checks driving the real desktop build
npm run bench      # timings for every heavy path
```

macOS will warn on first launch because the build is not notarised. Right-click the
app, choose Open, agree once, and it never asks again.

## Halftone

A printing RIP, done as geometry:

1. Separate RGB into cyan, magenta, yellow and black, with adjustable black generation
2. Build a summed-area table per channel, so averaging a screen cell of any size is
   four array reads and the cost stops depending on how fine the screen is
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

**The screen is sized by dot pitch, in pixels, not by cells across the artwork.**
Cells-across is relative to the artwork, so a screen tuned on a 400px logo puts 76px
dots on a 2600px photo. Pitch is what "a five pixel dot" actually means and it holds
whatever you feed it. The cell count is derived from the frame at run time.

Dot shapes: round, square, ellipse, line, cross, diamond. Modes: CMYK, duotone, mono.

**Export** gives one compound path per ink inside a multiply group, so Illustrator
opens four objects rather than a hundred thousand. `Plates` writes each ink as its
own named group, unblended, which is what a printer asks for. The suite opens every
export back up again, because an export you cannot reopen is not an export.

The Save button carries the file size before you press it, and turns amber past
8MB. A fine screen over a large photo is half a million dots and thirteen
megabytes: a fair file for that much geometry, but finding out by pressing Save
is not fair.

**Mono and duotone work from perceptual tone, not from the black plate.** Black
generation is `1 - max(r,g,b)`, so a saturated colour contains no black at all
and a red logo came out of a one-colour screen as blank paper. Duotone gives the
colour the whole tone range and eases the dark ink in past an adjustable split,
so the two overprint in the shadows the way a risograph does, instead of being
mono with a tint.

## Background removal

BiRefNet-lite through `onnxruntime-node`, locally. MIT licensed, which matters
because BRIA's RMBG-2.0 scores a few points higher but ships under a licence needing
a paid agreement for commercial use.

The model is 213MB and is fetched once on first use into the app's data directory,
never bundled. Nothing is uploaded; the image does not leave the machine. About 7
seconds for a 1000px image.

Inference runs in a **separate Node process**. `onnxruntime-node` loads inside
Electron quite happily and then crashes the instant it runs, on every threading and
optimisation setting tried; in plain Node the same model and the same call work
fine. Running it outside also means a fault in native code cannot take the window
down. If the machine has no Node, or the download fails, the app says so and falls
back to a corner-colour cut rather than doing nothing.

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

Nothing builds path data as a string during interaction. Contours arrive as an x,y
`Float32Array` plus ring offsets, halftone dots arrive as `[cx, cy, r, phase]` quads,
and both get drawn under a matrix. The `d` string is built only on export.

While a slider is held the work runs at reduced quality: 42% sampling resolution and
a correspondingly coarser screen, because the dot count is what the outlines and the
drawing scale with and it does not fall when the sampling does. Full quality is armed
only once a preview has landed and nothing newer has come in; arming it on a timer
alongside the preview meant every preview was computed, superseded, and waited on
anyway.

The erosion's pixel pass splits across a pool of workers over shared memory. That
needs cross-origin isolation, which Chromium grants only to http origins, which is
why the desktop build serves itself from a loopback HTTP server rather than from
`file://` or a custom scheme.

### Three things that cost seconds, all found by measuring

- **`getImageData` after drawing is a GPU stall.** Rasterising a photo through a
  canvas and reading it back cost 190ms on every recompute. The pixels were already
  in hand; resampling them directly took it to 8ms.
- **`Path2D` is quadratic in subpath count.** One path holding 30,000 contours took
  9.5 seconds to build; a thousand took 11ms. Halftone plates hit the same wall on
  every dot shape except round, which uses `arc()` and takes a different route
  inside Chrome: 80,000 cross-shaped dots took 7.3 seconds. Both now split across
  paths of 250 shapes.
- **Resampling by scattering source pixels leaves holes.** Walking the source and
  writing into the destination is fine while downscaling and silently wrong the
  moment the working bitmap is larger: untouched destination pixels stayed black,
  which screened empty transparent space at about 50%.

Measured at Retina density on a 1080px photo:

| | |
|---|---|
| Halftone slider | 8ms |
| Dither slider | 77ms |
| Halftone, full quality | 63-90ms |
| Eroded photo, full quality | 530-600ms |
| Pan, 95th percentile frame | 17.7ms, which is vsync |
| Heap over 25 recomputes | flat |

A worker that stops answering is caught after twenty seconds: the app says so,
throws it away, starts a fresh one and retries, and falls back to the main
thread if that keeps happening. A frozen canvas with no explanation reads as the
whole app having hung, which is the worst way to fail.

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
electron/     main process, preload bridge, background removal, test harnesses
src/engine/   warp, grunge, halftone, raster, geom, importer, snap   (no DOM)
src/doc/      document model, effect registry, the three registrations
src/view/     viewport, overlay, control specs, panel builder, icons
src/workers/  the effect stack and the erosion pool, off the main thread
src/export/   geometry to SVG
test/         107 checks that need nothing but node
```

Adding a fourth effect means one registration in `src/doc/register-effects.js` and
one spec in `src/view/specs.js`. Nothing in the viewport, the exporter or the
transform code has to change.

## Test harnesses

| Command | What it does |
|---|---|
| `npm test` | Engine maths: halftone tone accuracy, document model, geometry, resampling |
| `npm run suite` | Drives the real desktop build. Every preset, texture, dot shape and ink mode, on vector artwork and on photos, asserting output, a clean export, a round trip and a time budget |
| `npm run bench` | Per-scene compute and frame timings |
| `electron . --sheet` | Renders every effect over the test images and writes the canvases out, so output is looked at rather than inferred |

## Samples

`LICENSE-SAMPLES.md` covers the bundled outlines.
