# Warp

A browser tool for bending vector artwork. Paste any SVG, pick a deformation, drag the
four corners, export the result.

**→ [aditya31sharma.github.io/warp](https://aditya31sharma.github.io/warp/)**

Everything runs in the browser. Nothing is uploaded, and there is no server. To run it
locally instead:

```sh
python3 -m http.server 8900 --bind 127.0.0.1
```

## The interface

Two tools, switched from the toolbar: **Warp** bends the artwork, **Dither** erodes it
into ink spatter. Each has its own property panel on the right.

Controls are icons. Hover any of them for a name and a sentence on what it does. The
readout at the bottom left of the canvas shows zoom, warped size, grid step, path and
contour counts, and the selected corner's coordinates.

## Getting artwork in

| | |
|---|---|
| Paste | <kbd>⌘V</kbd> anywhere with SVG markup on the clipboard |
| Drop | An `.svg` file onto the canvas |
| Open | The file picker |
| Samples | Built-in, including real type outlines |

Imports handle `path`, `rect`, `circle`, `ellipse`, `line`, `polyline` and `polygon`,
bake in every nested transform and the root `viewBox`, and skip anything hidden. Each
element keeps its own fill and stroke, so a stroked icon stays a stroked icon rather
than becoming a filled blob. **Use source colours** toggles between the artwork's own
paint and the panel's fill and stroke.

## The pixel grid

One SVG user unit is one pixel at 100%. The grid is drawn from real coordinates, not a
decorative texture: it steps 1, 2, 5, 10, 20, 50 so lines never crowd, every tenth line
is brighter, and the x and y axes are tinted. The readout at the bottom left shows zoom,
warped size in pixels, the current grid step, the subpath count and the selected
corner's coordinates.

Scroll to zoom at the pointer, drag the empty canvas to pan, **Fit** and **100%** to
reset.

## Snapping

| | |
|---|---|
| Pixel grid | Rounds to whole pixels, or whatever **Step** says |
| Corners and edges | Aligns with the other three corners, and with the source edges and centre |
| <kbd>⌘</kbd> while dragging | Ignores snapping entirely |

Alignment beats the pixel grid on any axis where both apply, otherwise rounding would
pull the handle straight back off the guide. A pink line marks each live snap.

## Corners

The four corners are live on **every** preset, not just Free. The preset bends the
shape and the corner quad transforms the result, so you can arch a lockup and slant it
at once.

| | |
|---|---|
| Drag | Move a corner |
| Click | Select one |
| <kbd>←↑↓→</kbd> | Nudge 1px |
| <kbd>⇧</kbd> + arrows | Nudge 10px |
| <kbd>⌫</kbd> | Reset that corner |
| <kbd>Esc</kbd> | Deselect |

Nudges are real pixels because the tool works in real pixel space.

## Presets

Free, Arc, Peak, Arch Top, Arch Base, Bulge, Squeeze, Flag, Wave, Rise, Slant, Shear,
Taper Top, Taper Base, Perspective, Fisheye, Twist, Fish. Strength runs -100 to 100;
negative bends the other way. **Smooth curves** refits the deformed outline to beziers,
off gives faceted polygons.

Each preset's icon is drawn by running the real engine on a sample mark, so the icon
always matches what the preset does.

## Dither

Erodes the outline into ink spatter. It is a real geometry operation, not a raster
filter or a texture overlay: the result is vector paths you can scale.

How it works, which is the vector equivalent of the stacked spatter-and-texture
technique used in Photoshop:

1. The artwork is rasterised to a coverage mask.
2. An exact signed distance field is built from that mask, using Felzenszwalb and
   Huttenlocher's linear-time transform (two 1D passes over lower envelopes of
   parabolas).
3. Fractal noise is **added to the distance**, so the outline wanders in and out.
   Because the noise is added to a distance rather than to a colour, the effect
   naturally fades out away from the edge: deep inside the stroke the distance is
   far larger than the noise, so the core stays solid, while within a band of roughly
   the noise amplitude the outline breaks into speckle.
4. A second, much slower noise field modulates the amplitude, so some regions erode
   hard and others survive. That patchiness is what stops it looking like a filter.
5. The result is re-thresholded at zero and traced back to contours with marching
   squares, simplified, and emitted as paths. Holes are wound against their shell so
   counters stay hollow.

| Control | What it does |
|---|---|
| Grain | Size of the noise cell in mask pixels. Small is fine spatter, large is chunky tearing. |
| Erosion | How far the outline is allowed to wander, in mask pixels. This is the main dial. |
| Weight | Pushes the whole outline in or out: negative eats the shape away, positive fattens it. |
| Patchy | How much the slow field varies erosion across the artwork. Zero is uniform, which looks mechanical. |
| Spatter | Loose specks thrown clear of the edge, thinning with distance. |
| Pits | Holes opened inside the strokes. |
| Detail | Mask resolution. Higher resolves finer grain and costs more paths. |
| Simplify | Contour simplification tolerance. Raise it to cut the path count. |

**New seed** re-rolls the noise. Everything is seeded, so the same settings and seed
always give the same result.

The readout under the controls shows shapes, points and milliseconds. Fine grain with
high erosion can produce thousands of contours; that is the honest cost of spatter in
vectors rather than pixels. Raise Simplify or lower Detail to bring it down.

Dither runs **after** the warp, on the deformed outline, so the erosion follows the bend.

## Images

Drop or paste a PNG, JPEG or WebP and it is traced to vectors: luminance is thresholded
into **Tones** bands, each band traced to contours and filled with a grey step. **Cutoff**
moves the threshold. One tone gives a hard black-and-white stamp, which is what suits
the dither treatment; up to four gives a posterised version.

## Export

**Copy SVG** puts the markup on the clipboard. **Download** saves it. Output is one
`<path>` per source element, carrying whichever paint is active.

## Files

| | |
|---|---|
| `warp.js` | Engine: path parsing, presets, simplify, curve fitting. Runs in node too |
| `importer.js` | SVG to flat absolute paths, transforms baked in |
| `snap.js` | Alignment and pixel snapping |
| `app.js` | Canvas, grid, handles, export |

Test the engine without a browser:

```sh
node -e "const W=require('./warp.js');
  console.log(W.Warp.warp(['M0 0H400V120H0Z'],{x:0,y:0,width:400,height:120},
    {preset:'arc',strength:60,smooth:true}))"
```

## Notes

- Straight segments are subdivided before warping. Without it a rectangle's edge stays
  a single line and a curved warp cannot bend it.
- Letter counters stay hollow because each source element is warped as a unit and keeps
  its fill rule.
- Gradients, patterns, clip paths, masks and text elements are not supported. Convert
  text to outlines first.
- The built-in type samples are outlined from Geist Mono under the SIL Open Font
  License. See `LICENSE-SAMPLES.md`.
