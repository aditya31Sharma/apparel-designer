/* 16px line icons, stroke-based so they stay crisp and inherit colour. */
(function (root) {
  'use strict';
  var P = function (d, extra) {
    return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
      d + (extra || '') + '</svg>';
  };
  root.ICON = {
    open:    P('<path d="M2 4.5A1.5 1.5 0 013.5 3h2.6l1.2 1.6h5.2A1.5 1.5 0 0114 6.1v5.4A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5z"/>'),
    paste:   P('<path d="M6 2.5h4v2H6z"/><path d="M10 3.5h1.5A1.5 1.5 0 0113 5v7.5A1.5 1.5 0 0111.5 14h-7A1.5 1.5 0 013 12.5V5a1.5 1.5 0 011.5-1.5H6"/>'),
    image:   P('<rect x="2.5" y="3.5" width="11" height="9" rx="1.5"/><circle cx="6" cy="6.75" r="1"/><path d="M3 11l3-2.6 2.2 1.8L10.6 8l2.4 2.3"/>'),
    warp:    P('<path d="M2 5.5c3-2.6 9 2.6 12 0"/><path d="M2 10.5c3-2.6 9 2.6 12 0"/>'),
    dither:  P('<circle cx="4" cy="4" r="1.05" fill="currentColor" stroke="none"/><circle cx="8" cy="4" r=".75" fill="currentColor" stroke="none"/><circle cx="12" cy="4" r=".5" fill="currentColor" stroke="none"/><circle cx="4" cy="8" r=".75" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.05" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r=".4" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r=".5" fill="currentColor" stroke="none"/><circle cx="8" cy="12" r=".4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.05" fill="currentColor" stroke="none"/>'),
    strength:P('<path d="M2 12.5V9M6 12.5V6.5M10 12.5V4M14 12.5V7.5"/>'),
    smooth:  P('<path d="M2 11.5c2.5 0 3-7 6-7s3.5 7 6 7"/>'),
    fill:    P('<path d="M7 2.5l5 5-4.5 4.5a1.5 1.5 0 01-2.1 0L2.5 9.1a1.5 1.5 0 010-2.1z"/><path d="M12.8 10.2c.6.9.9 1.5.9 2a1 1 0 11-2 0c0-.5.3-1.1.9-2z" fill="currentColor" stroke="none"/>'),
    stroke:  P('<rect x="2.5" y="4.5" width="11" height="7" rx="1.5"/><path d="M2.5 8h11" opacity=".35"/>'),
    corners: P('<path d="M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3"/>'),
    spread:  P('<circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none"/><path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M4 4l1.1 1.1M10.9 10.9L12 12M12 4l-1.1 1.1M5.1 10.9L4 12"/>'),
    density: P('<circle cx="4" cy="4.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="4" r=".85" fill="currentColor" stroke="none"/><circle cx="12" cy="4.6" r=".45" fill="currentColor" stroke="none"/><circle cx="4" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".7" fill="currentColor" stroke="none"/><circle cx="12" cy="8" r=".35" fill="currentColor" stroke="none"/><circle cx="4" cy="11.6" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="12" r=".6" fill="currentColor" stroke="none"/><circle cx="12" cy="11.4" r=".3" fill="currentColor" stroke="none"/>'),
    texture: P('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.6 9.4c2-.1 2.6-2.6 4.6-2.6s2.4 2.7 4.4 2.7c.8 0 1.3-.4 1.9-.9M2.6 12.2c2-.1 2.6-2.2 4.6-2.2s2.4 2.3 4.4 2.3"/>'),
    texAmt:  P('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5 2.5L2.5 5M9 2.5L2.5 9M13 2.5L2.5 13M13.5 6L6 13.5M13.5 10.5L10.5 13.5"/>'),
    texScale:P('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M5.5 5.5h5v5h-5z"/><path d="M13 3l-2.2 2.2M3 13l2.2-2.2"/>'),
    invert:  P('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" stroke="none"/>'),
    melt:    P('<path d="M2.5 5.5h11"/><path d="M4 5.5c0 3 .6 4.2 1.6 4.2S7.2 8.4 7.2 6.4M9 5.5c0 4.6.8 6.4 1.9 6.4s1.6-1.5 1.6-3.6"/>'),
    cutoff:  P('<path d="M2.5 8h11"/><path d="M4.5 4.6l2-2 2 2M11.5 11.4l-2 2-2-2" opacity=".5"/><path d="M2.5 8h11" /><rect x="2.5" y="8" width="11" height="4.2" rx="1" fill="currentColor" stroke="none" opacity=".85"/>'),
    gscale:  P('<path d="M2.5 6V2.5H6M14 6V2.5h-3.5M2.5 10v3.5H6M14 10v3.5h-3.5"/><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none"/>'),
    styleLib:P('<rect x="2.5" y="2.5" width="5" height="5" rx="1"/><rect x="8.5" y="2.5" width="5" height="5" rx="1" fill="currentColor" stroke="none" opacity=".6"/><rect x="2.5" y="8.5" width="5" height="5" rx="1" fill="currentColor" stroke="none" opacity=".35"/><rect x="8.5" y="8.5" width="5" height="5" rx="1"/>'),
    none:    P('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M4.2 11.8L11.8 4.2"/>'),
    grain:   P('<circle cx="4" cy="5" r=".55" fill="currentColor" stroke="none"/><circle cx="8.5" cy="3.6" r=".45" fill="currentColor" stroke="none"/><circle cx="12" cy="5.6" r=".55" fill="currentColor" stroke="none"/><circle cx="6" cy="8.5" r=".5" fill="currentColor" stroke="none"/><circle cx="10.5" cy="9" r=".6" fill="currentColor" stroke="none"/><circle cx="3.6" cy="11.4" r=".45" fill="currentColor" stroke="none"/><circle cx="8" cy="12.2" r=".55" fill="currentColor" stroke="none"/><circle cx="12.4" cy="11.8" r=".45" fill="currentColor" stroke="none"/>'),
    erosion: P('<path d="M3 12.5V6.5l1.6 1 1.2-1.7 1.4 1.2 1.3-2 1.5 1.6L12 5.4l1 1.1v6z"/>'),
    weight:  P('<path d="M8 2.5v11M4.5 6L8 2.5 11.5 6M4.5 10L8 13.5 11.5 10"/>'),
    patchy:  P('<path d="M3 5.5c1.2-1.6 3-.6 4.2.2 1.4 1 2.8.3 4-.6"/><path d="M3 9c1.6 1.4 2.8.2 4.4-.4 1.3-.5 2.6.2 3.8 1.2"/><path d="M3.4 12.3c1.3-1.2 2.7-.3 4 .2 1.2.4 2.4 0 3.4-.8"/>'),
    spatter: P('<circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none"/><circle cx="3.2" cy="4.4" r=".6" fill="currentColor" stroke="none"/><circle cx="12.8" cy="4.8" r=".5" fill="currentColor" stroke="none"/><circle cx="3.6" cy="12" r=".5" fill="currentColor" stroke="none"/><circle cx="12.6" cy="11.6" r=".65" fill="currentColor" stroke="none"/><circle cx="8" cy="2.9" r=".4" fill="currentColor" stroke="none"/>'),
    pits:    P('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><circle cx="6" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="10.4" cy="9.6" r=".8" fill="currentColor" stroke="none"/><circle cx="6.4" cy="10.8" r=".55" fill="currentColor" stroke="none"/>'),
    detail:  P('<path d="M2.5 13.5L8 2.5l5.5 11z"/><path d="M5 9.5h6" opacity=".4"/>'),
    simplify:P('<path d="M2.5 11.5L6 6l3 3 4.5-6.5"/><circle cx="2.5" cy="11.5" r="1.1"/><circle cx="13.5" cy="2.5" r="1.1"/>'),
    seed:    P('<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><circle cx="5.6" cy="5.6" r=".9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="10.4" r=".9" fill="currentColor" stroke="none"/><circle cx="10.4" cy="5.6" r=".9" fill="currentColor" stroke="none"/>'),
    reset:   P('<path d="M13 8a5 5 0 11-1.6-3.7"/><path d="M13.3 2.6v3h-3"/>'),
    snapPix: P('<path d="M2.5 2.5h11v11h-11z" opacity=".45"/><path d="M6.1 2.5v11M9.9 2.5v11M2.5 6.1h11M2.5 9.9h11" opacity=".45"/><rect x="6.1" y="6.1" width="3.8" height="3.8" fill="currentColor" stroke="none"/>'),
    snapAln: P('<path d="M8 1.5v13" stroke-dasharray="2 1.6"/><rect x="2.5" y="5" width="5.5" height="6" rx="1"/><path d="M10 6.5h3.5M10 9.5h2.5" opacity=".55"/>'),
    step:    P('<path d="M2.5 12.5h3v-3h3v-3h3v-3h2"/>'),
    fit:     P('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
    oneOne:  P('<path d="M4 6.2L5.6 5v6M10.2 11h2.6M11.5 5v6M8 3v10" opacity=".5"/>'),
    gridIcon:P('<path d="M2.5 2.5h11v11h-11z"/><path d="M6.1 2.5v11M9.9 2.5v11M2.5 6.1h11M2.5 9.9h11"/>'),
    canvas:  P('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11" /><path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" stroke="none"/>'),
    copy:    P('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-1A1.5 1.5 0 009 3H4a1.5 1.5 0 00-1.5 1.5v5A1.5 1.5 0 004 11h1"/>'),
    download:P('<path d="M8 2.5v8M4.8 7.6L8 10.8l3.2-3.2M2.5 13h11"/>'),
    tone:    P('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" stroke="none"/>'),
    cutoff:  P('<path d="M2.5 8h11"/><circle cx="10" cy="8" r="2" fill="currentColor" stroke="none"/>')
  };
})(window);
