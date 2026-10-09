(function (root) {
  'use strict';
  root.Effects.register({
    id: 'selective', label: 'Selective half-tone', icon: 'halftone',
    tip: 'Fade an edge from full print to transparent halftone dots',
    defaults: { fades: [], pitch: 8, angle: 45 },
    run: function (input, p) {
      var mask = root.SelectiveHalftone.build(input.bbox, p);
      if (!mask.fades) return null;
      return Object.assign({}, input, { clips: (input.clips || []).concat(mask.clips),
        stats: { fades: mask.fades, dots: mask.dots,
          bytes: mask.clips.reduce(function (n, clip) { return n + clip.d.length + 150; }, 0) } });
    }
  });
})(typeof module !== 'undefined' ? module.exports : self);
