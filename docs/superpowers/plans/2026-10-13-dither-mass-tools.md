# Dither mass tools

- Keep edits in layer paint settings so existing undo restores them with the artwork.
- Reuse the contour tracer and Euclidean distance transform. Merge the visible ink into a silhouette, bridge small dither gaps and fill enclosed holes. Offset this silhouette once, rather than stroking each particle. The ring runs from gap to gap + width.
- Switch base subtracts the ink from the filled silhouette extended to the outline's inner edge. The outline remains independently adjustable.
- Record round brush strokes in artwork coordinates. Subtract them from all resulting paint, including the base and outline, and trace back to flat vector paths. Preserve the source for undo.
- Put controls in Dither using existing panel components. Cache derived geometry; preview, colour picking, Copy and Save use the same result and expanded bounds.
- Test geometry, transparency, transformed erasing, undo, colour exclusion, SVG-only clipboard and the installed native application. Preserve the user's current window and artwork during the local source update.

## Delivered and verified

- Controls: Artwork > Dither > Overall outline and Eraser. Offset is the gap to the ring's inner edge. Outline colour also paints Switch base.
- Escape finishes brushing. Undo restores one stroke; Restore erased areas removes all strokes and is itself undoable.
- Geometry runs after displayed-colour exclusion and before the shared viewport/export output. Added paint is also subject to exclusion. Clipping is baked into the ink silhouette before outlining. Erased Halftone retains named vector plates and existing overprint behavior.
- Six new geometry/export regressions plus the existing suite: 279 passing checks. Browser: 17 mass interactions, 19 existing colour interactions and 7 compound-hole/CMYK checks. Packaged native app: 20 checks including trusted brush input and real OS clipboard.
- Local source 3.0.3.4 installed with 15 hash-verified files. Actual updated desktop window verified against source and original document restored exactly. Previous window and source versions retained. No remote release.
- Real 154-path artwork: outline computation 189ms; first erase computation 2154ms. Brush gestures preview immediately and the vector subtraction commits on release. Results are cached for pan, zoom and export.
