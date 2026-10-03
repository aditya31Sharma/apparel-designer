/* The live Crew Oversized Tee's fabric, measured from its store models.
 *
 * Its "lines" are the knit normal map (fabrics/jersey_normal.jpg is the same
 * image) at strength 2 and 2.5 repeats per UV unit of master-tee. On the
 * studio's tee base that is 0.1168 repeats per fabric tile, so the same number
 * of lines runs down the body; the collar uses the map at 4 repeats, strength
 * 1.6. On other garments the repeat follows their real size (cmPerUnit), so a
 * line is as wide on a cap as it is on the tee.
 *
 * Roughness and specular were tuned per colour on the store. A colour picked
 * here blends the values of the nearest live colours. */

// flipV: the tee's UVs run top to bottom, the studio's bottom to top. The knit is not
// symmetric, so upside down it lights differently (finer, doubled lines).
export const CREW_FABRICS = {
  crew: { label: 'Crew tee lines', normal: 'fabrics/jersey_normal.jpg', repeat: 0.1168, strength: 2.0, cmRef: 40, sheen: 'body', flipV: true },
  crewCollar: { label: 'Crew tee collar', normal: 'fabrics/jersey_normal.jpg', repeat: 0.1837, strength: 1.6, cmRef: 40, sheen: 'collar', flipV: true },
};

// fabric colour (the store texture averaged over the garment's surface, prints left out),
// body roughness, collar roughness, specular
const LIVE = [
  ['#101015', 0.82, 0.75, 1.10],   // Black
  ['#fbfbf9', 0.62, 0.60, 0.95],   // White
  ['#1e2b4f', 0.93, 0.91, 0.25],   // Navy
  ['#990407', 0.92, 0.90, 0.30],   // Red
  ['#9d8c75', 0.85, 0.83, 0.45],   // Beige
  ['#df6983', 0.86, 0.84, 0.40],   // Pink
].map(([hex, body, collar, spec]) => ({ lab: oklab(hex), body, collar, spec }));

function oklab(hex) {
  const lin = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

export function crewSheen(hex, part) {
  const p = oklab(hex);
  let wsum = 0, rough = 0, spec = 0;
  for (const c of LIVE) {
    const d = Math.hypot(p[0] - c.lab[0], p[1] - c.lab[1], p[2] - c.lab[2]);
    const r = part === 'collar' ? c.collar : c.body;
    if (d < 1e-4) return { roughness: r, specular: c.spec };
    const w = 1 / d ** 3;
    wsum += w; rough += w * r; spec += w * c.spec;
  }
  return { roughness: rough / wsum, specular: spec / wsum };
}
