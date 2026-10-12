# Figma SVG paste in Artwork

In Figma, select the frame or layer and choose **Copy/Paste as > Copy as SVG**. In Tenzen Studio, select **Artwork** and press **Cmd+V** (Ctrl+V on Windows). SVG markup and SVG clipboard files import as editable paths for Warp, Dither, Halftone and Selective half-tone. When both SVG and a PNG preview are present, Studio uses the SVG. Pasting into a text field keeps normal text editing.

Ordinary Figma Copy carries Figma-specific clipboard data. If no SVG is present, Studio asks for Copy as SVG instead of silently importing a PNG.

The **Tenzen outro preset** inside Dither now generates vector contours. Its grayscale tones, transparency and controls are retained. Saved SVGs contain paths rather than an embedded bitmap; later halftone effects reuse the processed pixels internally for speed.

Under **Dither > Tenzen outro preset**, enter a six-digit **Hex colour** or use **Pick from SVG**, then click a colour in the artwork. Every exact match becomes transparent in both the preview and saved SVG, including partially transparent shapes of that colour. Other tones remain unchanged. Picking reads the vector fill, independent of the canvas background, rotation or zoom. Press Escape to cancel picking. Turn **Remove colour** off, or Undo, to restore the removed colour. Use **Save** or **Copy** for the resulting SVG.

Video Editor behavior is unchanged.

Validation: `npm test`. Browser and native Electron checks cover SVG-plus-PNG clipboard input, definition-only frame shapes, all four effect modes and an outro export containing paths without images.
