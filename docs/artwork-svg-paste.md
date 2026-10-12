# Figma SVG paste in Artwork

In Figma, select the frame or layer and choose **Copy/Paste as > Copy as SVG**. In Tenzen Studio, select **Artwork** and press **Cmd+V** (Ctrl+V on Windows). SVG markup and SVG clipboard files import as editable paths for Warp, Dither, Halftone and Selective half-tone. When both SVG and a PNG preview are present, Studio uses the SVG. Pasting into a text field keeps normal text editing.

Ordinary Figma Copy carries Figma-specific clipboard data. If no SVG is present, Studio asks for Copy as SVG instead of silently importing a PNG.

The **Tenzen outro preset** inside Dither now generates vector contours. Its grayscale tones, transparency and controls are retained. Saved SVGs contain paths rather than an embedded bitmap; later halftone effects reuse the processed pixels internally for speed.

Both **Dither** and **Halftone** have a **Colour exclusion** section directly below the effect heading. Enter a six-digit **Hex colour** or use **Pick from SVG**, then click the artwork. It works with every Dither style, including Tenzen outro, and one-, two- and four-ink Halftone. Halftone picking selects the ink of the clicked dot. Matching fills, outlines and ink plates are removed from the preview and saved SVG. Remaining vector geometry stays editable.

The exclusion is shared between both panels and uses the displayed artwork colours, including changes to the layer Ink. Picking ignores the canvas background and follows rotation, flipping and zoom. Press Escape to cancel. Turn **Remove colour** off, or Undo, to restore the excluded colour. **Save**, **Copy** and **Plates** all use the same exclusion.

Video Editor behavior is unchanged.

Validation: `npm test`. Browser and native Electron checks cover SVG-plus-PNG clipboard input, definition-only frame shapes, all four effect modes and an outro export containing paths without images.
