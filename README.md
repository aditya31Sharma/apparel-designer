# Warp

A browser tool for bending vector artwork. Paste any SVG, pick a deformation, drag the
four corners, export the result.

```sh
cd ~/Codes/warp-tool && python3 -m http.server 8900 --bind 127.0.0.1
```

Then <http://127.0.0.1:8900/>. No build step, no dependencies, no server logic.

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
