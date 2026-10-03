/* Store preview: the Shopify file, shown exactly as tenzen.in shows it.
 *
 * The GLB is the one Download saves, built by the same code. It is rendered by
 * model-viewer 3.5.0 (vendor/model-viewer.min.js is byte for byte the build the
 * store loads) with the attributes of the live product page (theme section
 * v-pdp): neutral environment, exposure 1.05, shadow 0.4 / softness 1,
 * auto-rotate, the vertical angle locked at 90 degrees. Three frames, as a
 * customer meets them: the desktop product page (a 300 px square on white), the
 * phone (a 3:4 stage on its grey gradient, model at 80 %) and the magnified view
 * the magnify button opens (full white, zoom allowed). */

const MV_URL = new URL('./vendor/model-viewer.min.js', import.meta.url).href;
const DRACO_DIR = new URL('./vendor/addons/libs/draco/', import.meta.url).href;

const LIGHT = { 'shadow-intensity': '0.4', 'shadow-softness': '1', 'environment-image': 'neutral', exposure: '1.05' };
const PAGE_ATTRS = {
  'auto-rotate': '', 'auto-rotate-delay': '0', 'rotation-per-second': '25deg', 'camera-controls': '',
  'disable-zoom': '', 'disable-pan': '', 'touch-action': 'pan-y',
  'min-camera-orbit': 'auto 90deg auto', 'max-camera-orbit': 'auto 90deg auto',
  'interaction-prompt': 'none', loading: 'eager', reveal: 'auto', ...LIGHT,
};
const ZOOM_ATTRS = {
  'auto-rotate': '', 'auto-rotate-delay': '0', 'rotation-per-second': '18deg', 'camera-controls': '',
  'touch-action': 'pan-y', 'min-camera-orbit': 'auto 90deg 30%', 'max-camera-orbit': 'auto 90deg 100%',
  'interaction-prompt': 'none', reveal: 'auto', ...LIGHT,
};
const ORBIT = { front: '0deg', back: '180deg', left: '90deg', right: '-90deg', top: '0deg' };

const ICON_MAGNIFY = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 10l7-7M21 3v5M21 3h-5"/><path d="M10 14l-7 7M3 21v-5M3 21h5"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>';
const ICON_SWIPE = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 8 4 4-4 4"/><path d="m6 8-4 4 4 4"/><path d="M8 12h.01"/><path d="M12 12h.01"/><path d="M16 12h.01"/></svg>';

let viewerReady = null;
function loadViewer() {
  if (!viewerReady) {
    // read by model-viewer when it first loads: decode Draco from the app, not gstatic
    self.ModelViewerElement = Object.assign(self.ModelViewerElement || {}, { dracoDecoderLocation: DRACO_DIR });
    viewerReady = import(MV_URL).then(() => customElements.whenDefined('model-viewer'));
  }
  return viewerReady;
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(2) + ' MB'; }

export function describe(report, extra = {}) {
  // prints are the colour textures with transparency (WebP, or PNG where the browser
  // cannot write WebP); a JPEG colour texture is a fabric mask (acid wash, heather)
  const prints = report.textures.filter((t) => t.slot === 'color' && t.mime !== 'image/jpeg');
  const biggest = prints.reduce((m, t) => Math.max(m, t.width, t.height), 0);
  const kind = prints.every((t) => t.mime === 'image/webp') ? 'WebP' : 'PNG';
  const parts = [`${report.triangles.toLocaleString()} triangles`];
  if (prints.length) parts.push(`${prints.length} print${prints.length > 1 ? 's' : ''} as ${kind} up to ${biggest} px`);
  const others = report.textures.length - prints.length;
  if (others) parts.push(`${others} fabric texture${others > 1 ? 's' : ''}`);
  if (extra.heightCm) parts.push(`real size ${Math.round(extra.heightCm)} cm tall`);
  return {
    size: mb(report.bytes),
    was: mb(report.rawBytes),
    line: parts.join(' · '),
  };
}

export class StorePreview {
  /* host: the stage element. build(): resolves { glb: Uint8Array, report, res }.
   * download(built): saves that exact file. onMode(mode): the page reacts
   * ('edit' hands the stage back to the editor). */
  constructor(host, { build, download, onMode, limit }) {
    this.host = host;
    this.build = build;
    this.download = download;
    this.onMode = onMode;
    this.limit = limit;
    this.mode = 'edit';
    this.rev = 0;            // bumped on every edit
    this.built = null;       // { glb, report, res, rev, url }
    this.building = null;
    this.spin = true;
    this.el = document.createElement('div');
    this.el.className = 'pv';
    this.el.hidden = true;
    this.el.innerHTML = `
      <div class="pv-area" data-frame="page">
        <div class="pv-frame pv-page">
          <div class="pv-stage"><button class="pv-magnify" type="button" aria-label="Magnify 3D model" title="Open the magnified view">${ICON_MAGNIFY}</button></div>
          <p class="pv-cap">Desktop product page, actual size</p>
        </div>
        <div class="pv-frame pv-phone">
          <div class="pv-stage"><span class="pv-hint">${ICON_SWIPE}<span>Swipe to rotate</span></span></div>
          <p class="pv-cap">Phone product page, 390 px wide</p>
        </div>
        <div class="pv-frame pv-zoom">
          <button class="pv-close" type="button" aria-label="Close" title="Back to the product page">${ICON_CLOSE}</button>
        </div>
        <div class="pv-busy" hidden>Building the Shopify file…</div>
      </div>
      <div class="pv-report">
        <div class="pv-facts"><div><strong class="pv-size"></strong> <span class="pv-sum"></span></div><div class="pv-line"></div></div>
        <label class="toggle pv-spin" title="The store always spins it. Pause to study one angle."><input type="checkbox" checked> Spin</label>
        <button class="primary pv-dl" type="button">Download this file</button>
      </div>`;
    host.appendChild(this.el);
    this.area = this.el.querySelector('.pv-area');
    // as on the store, a tap on either stage (not a drag to turn it) opens the magnified view
    for (const st of this.el.querySelectorAll('.pv-page .pv-stage, .pv-phone .pv-stage')) {
      st.addEventListener('click', () => { if (!this.dragged) this.setMode('zoom'); });
    }
    this.el.querySelector('.pv-close').addEventListener('click', () => this.setMode(this.lastStage || 'page'));
    this.el.querySelector('.pv-dl').addEventListener('click', () => this.built && this.download(this.built));
    this.el.querySelector('.pv-spin input').addEventListener('change', (ev) => {
      this.spin = ev.target.checked;
      if (this.viewer) this.viewer.autoRotate = this.spin;
    });
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && this.mode !== 'edit') { ev.stopImmediatePropagation(); this.setMode(this.mode === 'zoom' ? (this.lastStage || 'page') : 'edit'); } }, true);
    new ResizeObserver(() => this.fit()).observe(this.area);
  }

  get visible() { return this.mode !== 'edit'; }

  /* Something in the design changed. The preview rebuilds a moment later if it is
   * showing, otherwise next time it opens. */
  stale() {
    this.rev++;
    if (!this.visible) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 450);
  }

  fresh() { return this.built && this.built.rev === this.rev ? this.built : null; }

  async setMode(mode) {
    if (mode === this.mode) return;
    const was = this.mode;
    this.mode = mode;
    if (mode === 'page' || mode === 'phone') this.lastStage = mode;
    this.onMode(mode, was);
    this.el.hidden = mode === 'edit';
    if (mode === 'edit') { this.dropViewer(); return; }
    this.area.dataset.frame = mode;
    await loadViewer();
    if (this.mode !== mode) return;
    this.mountViewer();
    if (!this.fresh()) await this.refresh();
  }

  mountViewer() {
    this.dropViewer();
    const mv = document.createElement('model-viewer');
    const attrs = this.mode === 'zoom' ? ZOOM_ATTRS : PAGE_ATTRS;
    for (const [k, v] of Object.entries(attrs)) mv.setAttribute(k, v);
    mv.setAttribute('alt', 'Store preview of the garment');
    mv.className = 'pv-mv';
    if (!this.spin) mv.removeAttribute('auto-rotate');
    mv.addEventListener('pointerdown', (ev) => { this.dragged = false; this.down = [ev.clientX, ev.clientY]; });
    mv.addEventListener('pointermove', (ev) => { if (this.down && Math.hypot(ev.clientX - this.down[0], ev.clientY - this.down[1]) > 4) this.dragged = true; });
    mv.addEventListener('pointerup', () => { this.down = null; });
    mv.addEventListener('load', () => this.loaded(mv));
    mv.addEventListener('error', (ev) => this.failed(ev));
    const slot = this.mode === 'zoom' ? this.el.querySelector('.pv-zoom') : this.el.querySelector(`.pv-${this.mode} .pv-stage`);
    slot.appendChild(mv);
    this.viewer = mv;
    if (this.built) mv.src = this.built.url;
    this.fit();
  }

  dropViewer() {
    if (this.viewer) { this.viewer.remove(); this.viewer = null; }
  }

  /* the phone frame is 390 x 520 like the real stage; shrink it to fit a short window */
  fit() {
    const r = this.area.getBoundingClientRect();
    const k = Math.min(1, (r.height - 70) / 520, (r.width - 40) / 390);
    this.el.querySelector('.pv-phone').style.setProperty('--k', Math.max(0.4, k).toFixed(3));
  }

  orbit(view) {
    if (!this.viewer || !ORBIT[view]) return;
    this.viewer.cameraOrbit = `${ORBIT[view]} 90deg auto`;
    this.viewer.jumpCameraToGoal?.();
  }

  async refresh() {
    if (this.building) { this.again = true; return this.building; }
    const busy = this.el.querySelector('.pv-busy');
    busy.hidden = !!this.built;   // first build: say so; later ones keep the old model up
    this.el.querySelector('.pv-report').classList.add('updating');
    const rev = this.rev;
    this.building = (async () => {
      try {
        const out = await this.build();
        const url = URL.createObjectURL(new Blob([out.glb], { type: 'model/gltf-binary' }));
        const prev = this.built;
        this.built = { ...out, rev, url };
        if (this.viewer) this.viewer.src = url;
        if (prev) setTimeout(() => URL.revokeObjectURL(prev.url), 4000);
        this.showReport();
      } catch (e) {
        console.error(e);
        this.showError(`Could not build the file: ${e.message}`);
      } finally {
        busy.hidden = true;
        this.el.querySelector('.pv-report').classList.remove('updating');
        this.building = null;
        if (this.again || this.rev !== rev) { this.again = false; if (this.visible) this.refresh(); }
      }
    })();
    return this.building;
  }

  showReport() {
    const b = this.built;
    const d = describe(b.report, b);
    const over = b.report.bytes > this.limit;
    const rep = this.el.querySelector('.pv-report');
    rep.classList.toggle('warn', over);
    this.el.querySelector('.pv-size').textContent = `${d.size} Shopify file`;
    this.el.querySelector('.pv-sum').textContent = over
      ? `Over the 15 MB limit even with prints at ${b.res} px. Use fewer or smaller designs.`
      : `Draco compressed (${d.was} before), under the 15 MB limit`;
    this.el.querySelector('.pv-line').textContent = d.line;
  }

  showError(msg) {
    const rep = this.el.querySelector('.pv-report');
    rep.classList.add('warn');
    this.el.querySelector('.pv-size').textContent = 'Not ready.';
    this.el.querySelector('.pv-sum').textContent = msg;
    this.el.querySelector('.pv-line').textContent = '';
  }

  loaded(mv) {
    if (mv !== this.viewer) return;
    this.el.querySelector('.pv-report').classList.remove('broken');
    mv.autoRotate = this.spin;
  }

  failed(ev) {
    const msg = ev.detail?.sourceError?.message || ev.detail?.type || 'unknown error';
    this.showError(`The store viewer could not open this file (${msg}).`);
    this.el.querySelector('.pv-report').classList.add('broken');
  }
}
