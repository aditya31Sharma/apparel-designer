/* Acid wash: a layer over any fabric, not a fabric of its own, so a fleece hoodie
 * or a crew tee can be washed and keep its own knit.
 *
 * The mottle is fabrics/acid_mask.jpg (grey; mid grey is the dyed colour).
 * Bleaching lifts a blotch's lightness toward white and keeps its hue, which is
 * what the store's acid washes do: an Acid Blue blotch is a lighter blue, not a
 * greyer one. Each preset is one live product's wash, fitted to its store
 * texture sampled over the garment's surface (mean, spread and tails of each
 * channel): the base colour, and how far the wash moves it. */

export const ACID_MASK = 'fabrics/acid_mask.jpg';
export const ACID_REPEAT = 1 / 16;   // mask repeats per fabric tile, on a garment of ACID_CM_REF cm per unit
export const ACID_CM_REF = 40;
export const ACID_DEFAULT = 0.15;    // Acid Black's strength, for a colour picked by hand

export const ACID_PRESETS = [
  { name: 'Acid Black', hex: '#262626', amount: 0.15, from: 'Crew Oversized Tee, Angels Motor Club Layered Tee' },
  { name: 'Acid Blue', hex: '#364583', amount: 0.25, from: 'Crew Oversized Tee' },
  { name: 'Acid Red', hex: '#a73b43', amount: 0.215, from: 'Crew Oversized Tee' },
  { name: 'Acid Black, hoodie', hex: '#2c2c2c', amount: 0.295, from: 'Stand Unshaken Oversized Hoodie' },
  { name: 'Acid Grey, waffle', hex: '#4d4e53', amount: 0.11, from: 'Absolute Cinema Oversized Waffle Tee' },
];

// the store's acid crew tees are less glossy than their solid ones
export const ACID_CREW_SHEEN = {
  body: { roughness: 0.72, specular: 0.65 },
  collar: { roughness: 0.70, specular: 0.65 },
};

/* Recolours mask pixels in place. data is an ImageData's RGBA bytes with the
 * mask in the red channel. */
export function acidPixels(data, hex, amount) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const L = Math.max((c[0] + c[1] + c[2]) / 3, 0.5);
  for (let i = 0; i < data.length; i += 4) {
    const k = (data[i] / 255 - 0.5) * 2 * amount;
    const s = (k >= 0 ? L + (255 - L) * Math.min(k, 1) : L * (1 + Math.max(k, -1))) / L;
    data[i] = c[0] * s;
    data[i + 1] = c[1] * s;
    data[i + 2] = c[2] * s;
  }
}

/* A swatch for a preset: a corner of the mask shrunk until its blotches show at
 * swatch size, with the wash doubled so it still reads there. */
export function acidSwatch(img, preset, size = 32) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, img.width / 4, img.height / 4, 0, 0, size, size);
  const d = g.getImageData(0, 0, size, size);
  acidPixels(d.data, preset.hex, Math.min(1, preset.amount * 2.5));
  g.putImageData(d, 0, 0);
  return cv.toDataURL();
}
