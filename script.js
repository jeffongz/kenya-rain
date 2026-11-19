(function () {
  'use strict';

  // Threshold -> colour: one table drives the raster AND the legend.
  const T = [0.1, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 125, 150, 200, 300];
  const C = ['#d9d9d9', '#bfe3f7', '#8fcbf0', '#5aa9e6', '#2f7fd6', '#1c56b8', '#1b3f9a', '#1f7a3a', '#33a14a', '#62c24a',
    '#98d93f', '#d4e83a', '#f6e72f', '#f7c92a', '#f6a623', '#f2811f', '#ea5a1e', '#df2f1f', '#c4161c', '#b0127a',
    '#cf2bb0', '#9b30c9', '#7a2aa8', '#5c2a8a', '#b8b8b8'].map(h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16)));
  const colourFor = v => { if (v == null || v < T[0]) return null; let i = T.length - 1; while (i > 0 && v < T[i]) i--; return C[i]; };

  const TZ = 'Africa/Nairobi';
  const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  const eat = iso => timeFmt.format(new Date(iso)) + ' EAT';
  const ord = n => { const v = n % 100, s = ['th', 'st', 'nd', 'rd']; return s[(v - 20) % 10] || s[v] || 'th'; };
  function dayLabel(ds) {
    const p = {}; dayFmt.formatToParts(new Date(ds + 'T12:00:00+03:00')).forEach(x => p[x.type] = x.value);
    return { t: (p.weekday + ', ' + p.month + ' ' + p.day).toUpperCase(), o: ord(+p.day) };
  }
  const todayEAT = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());   // e.g. 2026-11-18, in East Africa Time
  const ago = iso => { const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000)); return m < 60 ? m + ' min ago' : m < 2880 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + 'd ago'; };
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  const I = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>', pause: '<svg viewBox="0 0 24 24"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>', next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
    pin: '<svg viewBox="0 0 30 42"><path d="M15 40C8 30 3 24 3 15a12 12 0 0 1 24 0c0 9-5 15-12 25z"/><circle cx="15" cy="15" r="5" fill="none"/></svg>'
  };

  const merc = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const unmerc = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

  function sample(d, lon, lat) {
    const { lons, lats, values } = d, s = d.gridStepDeg, fx = (lon - lons[0]) / s, fy = (lat - lats[0]) / s;
    if (fx < 0 || fy < 0 || fx > lons.length - 1 || fy > lats.length - 1) return null;
    const x0 = Math.min(Math.floor(fx), lons.length - 2), y0 = Math.min(Math.floor(fy), lats.length - 2), tx = fx - x0, ty = fy - y0;
    const a = values[y0][x0], b = values[y0][x0 + 1], c = values[y0 + 1][x0], e = values[y0 + 1][x0 + 1];
    if ([a, b, c, e].some(v => v == null)) return null;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  }
  // value (0.1 mm bins) -> colour lookup; every threshold is a multiple of 0.1 so this equals colourFor() exactly
  const LUT = (() => { const a = new Array(3001); for (let i = 0; i <= 3000; i++) a[i] = colourFor((i + 0.05) / 10); return a; })();
  function render(d, canvas) {   // Mercator-registered raster so it stays aligned with the map
    const E = d.extent, W = canvas.width = 1800, y0 = merc(E.south), y1 = merc(E.north), st = d.gridStepDeg, vals = d.values, nx = d.lons.length, ny = d.lats.length;
    const H = canvas.height = Math.round(W * (y1 - y0) / (((E.east - E.west) * Math.PI) / 180));
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H), px = img.data, X0 = new Int32Array(W), TX = new Float32Array(W);
    for (let x = 0; x < W; x++) { const fx = (x + 0.5) / W * (E.east - E.west) / st; let c = Math.floor(fx); if (c > nx - 2) c = nx - 2; X0[x] = c; TX[x] = fx - c; }
    for (let y = 0; y < H; y++) {
      const fy = (unmerc(y1 - (y + 0.5) / H * (y1 - y0)) - E.south) / st; if (fy < 0 || fy > ny - 1) continue;
      let r = Math.floor(fy); if (r > ny - 2) r = ny - 2; const ty = fy - r, ra = vals[r], rb = vals[r + 1];
      for (let x = 0; x < W; x++) {
        const c = X0[x], tx = TX[x], a = ra[c], b = ra[c + 1], e = rb[c], f = rb[c + 1];
        if (a == null || b == null || e == null || f == null) continue;
        const col = LUT[Math.min(3000, Math.floor(((a * (1 - tx) + b * tx) * (1 - ty) + (e * (1 - tx) + f * tx) * ty) * 10 + 1e-9))]; if (!col) continue;
        const k = (y * W + x) * 4; px[k] = col[0]; px[k + 1] = col[1]; px[k + 2] = col[2]; px[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  function windAt(w, ex, lon, lat) {
    const fx = (lon - ex.west) / w.stepDeg, fy = (lat - ex.south) / w.stepDeg;
    if (fx < 0 || fy < 0 || fx > w.nx - 1 || fy > w.ny - 1) return null;
    const x0 = Math.min(Math.floor(fx), w.nx - 2), y0 = Math.min(Math.floor(fy), w.ny - 2), tx = fx - x0, ty = fy - y0, i = y0 * w.nx + x0;
    const g = a => [a[i], a[i + 1], a[i + w.nx], a[i + w.nx + 1]], U = g(w.u), V = g(w.v);
    if (U.some(v => v == null) || V.some(v => v == null)) return null;
    const b = a => (a[0] * (1 - tx) + a[1] * tx) * (1 - ty) + (a[2] * (1 - tx) + a[3] * tx) * ty;
    return [b(U), b(V)];
  }

  class Explorer {
    constructor(root) {
      this.root = root; this.q = s => root.querySelector(s); this.base = root.dataset.dataBase || 'data';
      this.model = 'ecmwf_ifs'; this.date = null; this.data = null; this.ctrl = null; this.frames = new Map(); this.canvas = document.createElement('canvas');
      this.playing = false; this.precipOn = true; this.windOn = true; this.wind = null; this.raf = null; this.loadedAt = 0;
      this.buildLegend(); this.bindUI();
      const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => { if (es[0].isIntersecting) { io.disconnect(); this.init(); } }) : null;
      io ? io.observe(root) : this.init();
    }

    /* ---------------- UI ---------------- */
    buildLegend() {
      const bar = this.q('.kpe-lg-bar'), tk = this.q('.kpe-lg-ticks');
      C.forEach(c => { const i = el('i'); i.style.background = 'rgb(' + c.join(',') + ')'; bar.appendChild(i); });
      [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 24].forEach(i => { const s = el('span', null, T[i]); s.style.left = ((i + 0.5) / T.length * 100) + '%'; tk.appendChild(s); });
      tk.appendChild(el('span', 'kpe-unit', 'mm'));
    }
    bindUI() {
      const q = this.q;
      q('.kpe-prev').innerHTML = I.prev; q('.kpe-next').innerHTML = I.next; this.syncPlay();
      q('.kpe-prev').addEventListener('click', () => { this.pause(); this.go(this.idx() - 1); });
      q('.kpe-next').addEventListener('click', () => { this.pause(); this.go(this.idx() + 1); });
      q('.kpe-play').addEventListener('click', () => this.playing ? this.pause() : this.play());
      q('.kpe-today').addEventListener('click', () => this.goToday());
      q('.kpe-zin').addEventListener('click', () => this.map && this.map.zoomIn({ duration: 250 }));
      q('.kpe-zout').addEventListener('click', () => this.map && this.map.zoomOut({ duration: 250 }));
      this.root.querySelectorAll('.kpe-layer').forEach(b => b.addEventListener('click', () => {
        const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on);
        if (b.dataset.layer === 'wind') { this.windOn = on; on ? this.runWind() : this.stopWind(); }
        else { this.precipOn = on; this.map && this.map.getLayer('kpe-wx') && this.map.setLayoutProperty('kpe-wx', 'visibility', on ? 'visible' : 'none'); q('.kpe-legend').hidden = !on; }
      }));
      q('.kpe-op input').addEventListener('input', e => this.map && this.map.getLayer('kpe-wx') && this.map.setPaintProperty('kpe-wx', 'raster-opacity', e.target.value / 100));
      q('.kpe-model').addEventListener('change', e => { this.model = e.target.value; this.load(); });
      this.initSearch();
      if ('ResizeObserver' in window) new ResizeObserver(() => { this.map && this.map.resize(); this.fitWind && this.fitWind(); }).observe(this.root);
      const again = () => { this.markToday(); if (!document.hidden && this.data && Date.now() - this.loadedAt > 30 * 60 * 1000) { ForecastAdapter.clearCache(); this.frames.clear(); this.load(); } };
      document.addEventListener('visibilitychange', again); this.timer = setInterval(again, 15 * 60 * 1000);
    }
    syncPlay() { const b = this.q('.kpe-play'); b.innerHTML = this.playing ? I.pause : I.play; b.setAttribute('aria-label', this.playing ? 'Pause slideshow' : 'Play slideshow'); }
    idx() { return this.data ? Math.max(0, this.data.dates.indexOf(this.date)) : 0; }
    pickDate(dates) { const t = todayEAT(); return dates.includes(t) ? t : (dates.find(x => x > t) || dates[dates.length - 1]); }  // today, else next available, else latest
    goToday() { if (!this.data) return; this.pause(); this.date = this.pickDate(this.data.dates); this.load(); }
    markToday() {   // highlight today's tab (and dim past days), independent of which day is selected
      const t = todayEAT();
      this.q('.kpe-days').querySelectorAll('.kpe-day').forEach(b => {
        const isT = b.dataset.date === t, tag = b.querySelector('.kpe-tag');
        b.classList.toggle('is-today', isT); b.classList.toggle('is-past', b.dataset.date < t);
        if (isT && !tag) b.appendChild(el('span', 'kpe-tag', 'Today')); else if (!isT && tag) tag.remove();
      });
    }
    async go(i) { if (!this.data) return; const n = this.data.dates.length; this.date = this.data.dates[(i + n) % n]; await this.load(); }
    play() { this.playing = true; this.syncPlay(); this.schedule(); }
    pause() { this.playing = false; clearTimeout(this.tm); this.syncPlay(); }
    schedule() { clearTimeout(this.tm); if (!this.playing) return; this.tm = setTimeout(async () => { if (!this.playing) return; await this.go(this.idx() + 1); this.schedule(); }, 2200); }

    initSearch() {
      const inp = this.q('.kpe-search input'), ul = this.q('.kpe-results'), clr = this.q('.kpe-clear'); let t, ac, items = [], sel = -1;
      const close = () => { ul.hidden = true; sel = -1; };
      const mark = () => [...ul.children].forEach((li, i) => li.classList.toggle('on', i === sel));
      const pick = f => { inp.value = f.name; close(); this.flyTo(f.lon, f.lat, f.name); };
      const show = list => { items = list; ul.textContent = ''; list.forEach(f => { const li = el('li'); li.append(el('b', null, f.name), el('small', null, f.sub)); li.addEventListener('mousedown', e => { e.preventDefault(); pick(f); }); ul.appendChild(li); }); ul.hidden = !list.length; sel = -1; };
      const run = async () => {
        const v = inp.value.trim(); if (v.length < 2) return close();
        const m = v.match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);  // "lat, lon"
        if (m && Math.abs(+m[1]) <= 90 && Math.abs(+m[2]) <= 180) return show([{ name: (+m[1]).toFixed(3) + ', ' + (+m[2]).toFixed(3), sub: 'Coordinates', lat: +m[1], lon: +m[2] }]);
        if (ac) ac.abort(); ac = new AbortController();
        try {
          const u = 'https://api.mapbox.com/search/geocode/v6/forward?q=' + encodeURIComponent(v) + '&bbox=-26,-36,60,38&limit=6&language=en&access_token=' + mapboxgl.accessToken;
          const j = await (await fetch(u, { signal: ac.signal })).json();
          show((j.features || []).map(f => ({ name: f.properties.name, sub: f.properties.place_formatted || '', lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })));
        } catch (e) { if (e.name !== 'AbortError') show([]); }
      };
      inp.addEventListener('input', () => { clr.hidden = !inp.value; clearTimeout(t); t = setTimeout(run, 250); });
      inp.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; mark(); } }
        else if (e.key === 'Enter') { e.preventDefault(); const f = items[sel >= 0 ? sel : 0]; f ? pick(f) : run(); }
        else if (e.key === 'Escape') close();
      });
      inp.addEventListener('blur', () => setTimeout(close, 150));
      clr.addEventListener('click', () => { inp.value = ''; clr.hidden = true; close(); inp.focus(); });
    }

    /* ---------------- map ---------------- */
    init() {
      const token = this.root.dataset.mapboxToken;
      if (!token || token.startsWith('YOUR_')) return this.msg('Add a Mapbox public token in data-mapbox-token.');
      mapboxgl.accessToken = token;
      this.map = new mapboxgl.Map({ container: this.q('.kpe-map'), style: 'mapbox://styles/mapbox/light-v11', bounds: [[-26, -36], [60, 38]], fitBoundsOptions: { padding: { top: 110, bottom: 30, left: 30, right: 30 } }, minZoom: 1.6, attributionControl: false, dragRotate: false, pitchWithRotate: false, projection: 'mercator' });
      this.map.scrollZoom.disable(); this.map.touchZoomRotate.disableRotation(); this.map.touchPitch && this.map.touchPitch.disable();
      this.map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
      this.map.addControl(new mapboxgl.ScaleControl({ maxWidth: 110 }), 'bottom-left');
      this.map.on('load', () => {
        const E = ForecastAdapter.EXTENT;
        this.map.addSource('kpe-wx', { type: 'image', url: this.blank(), coordinates: [[E.west, E.north], [E.east, E.north], [E.east, E.south], [E.west, E.south]] });
        const fs = this.map.getStyle().layers.find(l => l.type === 'symbol'), before = fs && fs.id;
        this.map.addLayer({ id: 'kpe-wx', type: 'raster', source: 'kpe-wx', paint: { 'raster-opacity': this.q('.kpe-op input').value / 100, 'raster-fade-duration': 300, 'raster-resampling': 'linear' } }, before);
        this.addCoast(before); this.addBorders(before); this.styleLabels(); this.initWind();
        this.map.on('click', e => { const f = this.map.queryRenderedFeatures(e.point).find(x => x.properties && x.properties.name); this.showPoint(e.lngLat, f && f.properties.name); });
        this.start();
      });
    }
    // Every map label: white fill, solid black outline, nothing else (no blur, glow, shadow or transparency).
    styleLabels() {
      const map = this.map;
      map.getStyle().layers.forEach(l => {
        if (l.type !== 'symbol' || !l.layout || l.layout['text-field'] == null) return;
        const set = (k, v) => map.setPaintProperty(l.id, k, v);
        set('text-color', '#ffffff'); set('text-halo-color', '#000000'); set('text-halo-width', 1.5); set('text-halo-blur', 0); set('text-opacity', 1);
      });
    }

    blank() { const c = document.createElement('canvas'); c.width = c.height = 2; return c.toDataURL(); }
    flyTo(lon, lat, name) { this.map.flyTo({ center: [lon, lat], zoom: Math.max(this.map.getZoom(), 8), duration: 900 }); this.showPoint({ lng: lon, lat }, name); }

    // Dark-theme shorelines and borders, drawn ABOVE the rainfall (below labels) so the opacity slider never hides them.
    addCoast(before) {
      const map = this.map, z = (a, b) => ['interpolate', ['linear'], ['zoom'], 3, a, 8, b];
      if (!map.getSource('composite')) return;
      const wv = ['any', ['==', ['get', 'worldview'], 'all'], ['in', 'US', ['get', 'worldview']]], sh = { type: 'line', source: 'composite', 'source-layer': 'water', layout: { 'line-join': 'round' } };
      map.addLayer({ ...sh, id: 'kpe-coast-casing', paint: { 'line-color': '#0a0f16', 'line-opacity': 0.8, 'line-width': z(1.5, 4) } }, before);
      map.addLayer({ ...sh, id: 'kpe-coast-line', paint: { 'line-color': '#a9d0f5', 'line-width': z(1.2, 2.2) } }, before);
      map.addLayer({ id: 'kpe-maritime', type: 'line', source: 'composite', 'source-layer': 'admin', filter: ['all', ['==', ['get', 'admin_level'], 0], ['==', ['get', 'maritime'], 'true'], wv],
        paint: { 'line-color': '#a9d0f5', 'line-opacity': 0.9, 'line-width': z(1, 1.8), 'line-dasharray': [3, 2] } }, before);
    }
    addBorders(before) {
      const map = this.map, z = (a, b) => ['interpolate', ['linear'], ['zoom'], 3, a, 8, b];
      const admin = map.getStyle().layers.filter(l => l.type === 'line' && l['source-layer'] === 'admin');
      admin.forEach(l => map.moveLayer(l.id, before));
      let countries = admin.filter(l => /admin-0/.test(l.id) && !/bg|disputed/.test(l.id));
      if (!countries.length && map.getSource('composite')) countries = [{ id: 'kpe-fallback', source: 'composite', 'source-layer': 'admin',
        filter: ['all', ['==', ['get', 'admin_level'], 0], ['==', ['get', 'maritime'], 'false'], ['any', ['==', ['get', 'worldview'], 'all'], ['in', 'US', ['get', 'worldview']]]] }];
      countries.forEach(l => {
        const b = { type: 'line', source: l.source, 'source-layer': l['source-layer'], layout: { 'line-join': 'round', 'line-cap': 'round' } }; if (l.filter) b.filter = l.filter;
        map.addLayer({ ...b, id: 'kpe-bc-' + l.id, paint: { 'line-color': '#0a0f16', 'line-opacity': 0.85, 'line-width': z(1.5, 4) } }, before);
        map.addLayer({ ...b, id: 'kpe-bl-' + l.id, paint: { 'line-color': '#f1f5f9', 'line-width': z(1.4, 2.6) } }, before);
      });
      admin.filter(l => /admin-1/.test(l.id) && !/bg/.test(l.id)).forEach(l => { map.setPaintProperty(l.id, 'line-color', '#b7c4d4'); map.setPaintProperty(l.id, 'line-opacity', 0.6); });
    }

    /* ---------------- data ---------------- */
    async start() {
      this.ctrl = new AbortController();
      try {
        const av = await ForecastAdapter.availableModels(this.base, this.ctrl.signal), sel = this.q('.kpe-model'); sel.textContent = '';
        Object.entries(ForecastAdapter.MODELS).forEach(([id, m]) => { const o = el('option', null, m.label + (av[id] ? '' : ' (no data)')); o.value = id; o.disabled = !av[id]; sel.appendChild(o); });
        if (!av[this.model]) { const ok = Object.keys(av).find(k => av[k]); if (!ok) return this.msg('No forecast files found in "' + this.base + '". Run the update workflow first.'); this.model = ok; }
        sel.value = this.model; this.load();
      } catch (e) { if (e.name !== 'AbortError') this.msg(e.message); }
    }
    async load() {
      if (this.ctrl) this.ctrl.abort(); this.ctrl = new AbortController();
      const ld = this.q('.kpe-loading'); ld.hidden = false; this.q('.kpe-message').hidden = true;
      try {
        const get = date => ForecastAdapter.getForecastData({ model: this.model, date, base: this.base, signal: this.ctrl.signal });
        let d = await get(this.date);
        if (!this.date || !d.dates.includes(this.date)) { const t = this.pickDate(d.dates); if (t !== d.date) d = await get(t); }   // open on today
        this.data = d; this.date = d.date; this.loadedAt = Date.now(); this.show(d);
        setTimeout(() => this.prefetch(), 60);
      } catch (e) { if (e.name !== 'AbortError') this.msg(e.message); }
      finally { ld.hidden = true; }
    }
    frame(d) {  // rendered raster per model/day/data-version, so slideshow frames are instant
      const key = d.model + '|' + d.date + '|' + d.updated; let url = this.frames.get(key);
      if (!url) { render(d, this.canvas); url = this.canvas.toDataURL('image/png'); this.frames.set(key, url); if (this.frames.size > 14) this.frames.delete(this.frames.keys().next().value); }
      return url;
    }
    async prefetch() {
      if (!this.data) return; const n = this.data.dates.length, next = this.data.dates[(this.idx() + 1) % n];
      try { this.frame(await ForecastAdapter.getForecastData({ model: this.model, date: next, base: this.base })); } catch (e) { /* optional */ }
    }
    show(d) {
      const e = d.extent; this.map.getSource('kpe-wx').updateImage({ url: this.frame(d), coordinates: [[e.west, e.north], [e.east, e.north], [e.east, e.south], [e.west, e.south]] });
      const days = this.q('.kpe-days');
      if (days.dataset.key !== d.model + d.dates.join()) {
        days.textContent = ''; days.dataset.key = d.model + d.dates.join();
        d.dates.forEach((ds, i) => { const l = dayLabel(ds), b = el('button', 'kpe-day'); b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.date = ds;
          const lab = el('span', 'kpe-dl'); lab.append(l.t); lab.appendChild(el('sup', null, l.o)); b.appendChild(lab); b.addEventListener('click', () => { this.pause(); this.go(i); }); days.appendChild(b); });
      }
      let active; days.querySelectorAll('.kpe-day').forEach(b => { const on = b.dataset.date === d.date; b.setAttribute('aria-selected', on); if (on) active = b; });
      this.markToday(); const isToday = d.date === todayEAT(), tb = this.q('.kpe-today'); tb.setAttribute('aria-pressed', isToday);
      if (active) days.scrollTo({ left: active.offsetLeft - days.clientWidth / 2 + active.offsetWidth / 2, behavior: 'smooth' });
      this.q('.kpe-lg-cap').textContent = (d.date === todayEAT() ? 'Today · ' : '') + 'Precipitation ' + d.hours + ' h' + (d.partial ? ' (partial day)' : '') + ' · ' + eat(d.validStart) + ' → ' + eat(d.validEnd);
      this.q('.kpe-model').value = d.model; this.q('.kpe-run').textContent = 'Run ' + eat(d.run);
      const up = this.q('.kpe-updated'); up.textContent = 'updated ' + ago(d.updated); up.classList.toggle('stale', Date.now() - new Date(d.updated) > 14 * 3600e3);
      up.title = d.source + ' · ' + d.resolution + ' · wind ' + (d.wind ? eat(d.wind.time) : 'n/a');
      this.setWind(d.wind);
      if (this.popup && this.popup.isOpen()) this.showPoint(this.pt.ll, this.pt.label);
    }
    msg(t) { const m = this.q('.kpe-message'); m.textContent = t; m.hidden = false; }

    /* ---------------- point popup ---------------- */
    showPoint(ll, label) {
      if (!this.data || !this.map) return; this.pt = { ll, label };
      if (this.popup) this.popup.remove();
      if (!this.marker) { const m = el('div', 'kpe-pin'); m.innerHTML = I.pin; this.marker = new mapboxgl.Marker({ element: m, anchor: 'bottom' }); }
      this.marker.setLngLat(ll).addTo(this.map);
      const v = sample(this.data, ll.lng, ll.lat), box = el('div', 'kpe-pop');
      box.appendChild(el('div', 'kpe-pc', ll.lat.toFixed(3) + ', ' + ll.lng.toFixed(3)));
      if (label) box.appendChild(el('div', 'kpe-pn', label));
      const val = el('div', 'kpe-pv', v == null ? 'No data' : v.toFixed(1)); if (v != null) val.appendChild(el('small', null, ' mm')); box.appendChild(val);
      box.appendChild(el('div', 'kpe-ps', this.data.modelLabel + ' · ' + dayLabel(this.date).t + ' · ' + this.data.hours + ' h (interpolated)'));
      const btn = el('button', 'kpe-fc', 'Show forecast'), list = el('div', 'kpe-fl'); btn.type = 'button'; list.hidden = true;
      btn.addEventListener('click', () => {
        if (!list.hidden) { list.hidden = true; btn.textContent = 'Show forecast'; return; }
        const rows = ForecastAdapter.pointSeries({ model: this.model, lon: ll.lng, lat: ll.lat, base: this.base }) || [], max = Math.max(10, ...rows.map(r => r.value || 0));
        list.textContent = ''; rows.forEach(r => { const row = el('div'), bar = el('i'); bar.style.width = Math.max(2, (r.value || 0) / max * 100) + '%';
          row.append(el('span', null, dayLabel(r.date).t.replace(/^(\w+), /, '$1 ')), bar, el('b', null, r.value == null ? '–' : r.value.toFixed(1))); list.appendChild(row); });
        list.hidden = false; btn.textContent = 'Hide forecast';
      });
      box.append(btn, list);
      this.popup = new mapboxgl.Popup({ offset: [0, -44], className: 'kpe-popup', maxWidth: '290px', closeOnClick: false }).setLngLat(ll).setDOMContent(box).addTo(this.map);
      this.popup.on('close', () => this.marker && this.marker.remove());
    }

    /* ---------------- wind streamlines ---------------- */
    initWind() {
      this.wc = document.createElement('canvas'); this.wc.className = 'kpe-wind'; this.q('.kpe-map').after(this.wc); this.wctx = this.wc.getContext('2d');
      this.fitWind = () => { const r = this.q('.kpe-stage').getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
        this.wc.width = r.width * d; this.wc.height = r.height * d; this.wctx.setTransform(d, 0, 0, d, 0, 0); this.ww = r.width; this.wh = r.height; this.parts = []; };
      this.fitWind(); this.map.on('move', () => this.clearWind());
    }
    clearWind() { if (this.wctx) this.wctx.clearRect(0, 0, this.ww, this.wh); }
    seed(p) { p.x = Math.random() * this.ww; p.y = Math.random() * this.wh; p.age = 0; p.max = 40 + Math.random() * 60; return p; }
    setWind(w) { this.wind = w; const b = this.q('[data-layer="wind"]'); b.disabled = !w; b.style.opacity = w ? '' : '.45'; this.clearWind(); w && this.windOn ? this.runWind() : this.stopWind(); }
    runWind() {
      if (this.raf || !this.wind || !this.wc || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
      const ctx = this.wctx, K = 0.18;
      this.parts = Array.from({ length: Math.round(Math.min(4000, this.ww * this.wh / 350)) }, () => this.seed({}));
      const frame = () => {
        this.raf = requestAnimationFrame(frame); if (!this.wind) return; const ex = (this.data && this.data.extent) || ForecastAdapter.EXTENT;
        ctx.globalCompositeOperation = 'destination-out'; ctx.fillStyle = 'rgba(0,0,0,0.07)'; ctx.fillRect(0, 0, this.ww, this.wh);
        ctx.globalCompositeOperation = 'source-over'; ctx.lineWidth = 1.1;
        for (const p of this.parts) {
          const ll = this.map.unproject([p.x, p.y]), uv = windAt(this.wind, ex, ll.lng, ll.lat);
          if (!uv || ++p.age > p.max) { this.seed(p); continue; }
          const nx = p.x + uv[0] * K, ny = p.y - uv[1] * K;
          ctx.strokeStyle = 'rgba(255,255,255,' + Math.min(0.95, 0.35 + Math.hypot(uv[0], uv[1]) / 20) + ')';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke(); p.x = nx; p.y = ny;
        }
      };
      frame();
    }
    stopWind() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = null; this.clearWind(); }
    destroy() { this.stopWind(); this.pause(); clearInterval(this.timer); if (this.ctrl) this.ctrl.abort(); if (this.map) this.map.remove(); }
  }

  document.querySelectorAll('.kenya-precipitation-explorer').forEach(e => { e.__kpe = new Explorer(e); });
})();
