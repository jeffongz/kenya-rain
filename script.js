(function () {
  'use strict';

  // Threshold -> colour (same table drives raster and legend). Index i = colour for values >= T[i].
  const T = [0.1, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100, 125, 150, 200, 300];
  const C = ['#d9d9d9', '#bfe3f7', '#8fcbf0', '#5aa9e6', '#2f7fd6', '#1c56b8', '#1b3f9a', '#1f7a3a', '#33a14a', '#62c24a',
    '#98d93f', '#d4e83a', '#f6e72f', '#f7c92a', '#f6a623', '#f2811f', '#ea5a1e', '#df2f1f', '#c4161c', '#b0127a',
    '#cf2bb0', '#9b30c9', '#7a2aa8', '#5c2a8a', '#b8b8b8'].map(h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16)));

  function colourFor(v) {
    if (v == null || v < T[0]) return null;
    let i = T.length - 1; while (i > 0 && v < T[i]) i--;
    return C[i];
  }

  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', weekday: 'short', day: 'numeric', month: 'short' });
  const fmtFull = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const eat = iso => fmtFull.format(new Date(iso)) + ' EAT';

  const merc = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const unmerc = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

  function sample(d, lon, lat) {
    const { lons, lats, values } = d, s = d.gridStepDeg;
    const fx = (lon - lons[0]) / s, fy = (lat - lats[0]) / s;
    if (fx < 0 || fy < 0 || fx > lons.length - 1 || fy > lats.length - 1) return null;
    const x0 = Math.min(Math.floor(fx), lons.length - 2), y0 = Math.min(Math.floor(fy), lats.length - 2), tx = fx - x0, ty = fy - y0;
    const a = values[y0][x0], b = values[y0][x0 + 1], c = values[y0 + 1][x0], e = values[y0 + 1][x0 + 1];
    if ([a, b, c, e].some(v => v == null)) return null;
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
  }

  function render(d, canvas) {
    const E = d.extent, W = canvas.width = 960;
    const y0 = merc(E.south), y1 = merc(E.north);
    const H = canvas.height = Math.round(W * (y1 - y0) / (((E.east - E.west) * Math.PI) / 180));
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(W, H);
    for (let py = 0; py < H; py++) {
      const lat = unmerc(y1 - (py + 0.5) / H * (y1 - y0));
      for (let px = 0; px < W; px++) {
        const col = colourFor(sample(d, E.west + (px + 0.5) / W * (E.east - E.west), lat));
        if (!col) continue;
        const k = (py * W + px) * 4; img.data[k] = col[0]; img.data[k + 1] = col[1]; img.data[k + 2] = col[2]; img.data[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  class Explorer {
    constructor(root) {
      this.root = root; this.q = s => root.querySelector(s);
      this.base = root.dataset.dataBase || 'data';
      this.model = 'ecmwf_ifs'; this.date = null; this.data = null; this.ctrl = null; this.disabled = new Set();
      this.canvas = document.createElement('canvas');
      this.buildLegend(); this.buildModels();
      this.q('.kpe-opacity input').addEventListener('input', e => this.map && this.map.getLayer('kpe-wx') &&
        this.map.setPaintProperty('kpe-wx', 'raster-opacity', e.target.value / 100));
      const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => { if (es[0].isIntersecting) { io.disconnect(); this.init(); } }) : null;
      io ? io.observe(root) : this.init();
    }

    init() {
      const token = this.root.dataset.mapboxToken;
      if (!token || token.startsWith('YOUR_')) return this.msg('Add a Mapbox public token in data-mapbox-token.');
      mapboxgl.accessToken = token;
      this.map = new mapboxgl.Map({ container: this.q('.kpe-map'), style: 'mapbox://styles/mapbox/light-v11', center: [37.5, 0.5], zoom: 5.4, attributionControl: true });
      this.map.scrollZoom.disable();
      this.map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-right');
      this.map.on('load', () => {
        const E = ForecastAdapter.EXTENT;
        this.map.addSource('kpe-wx', { type: 'image', url: this.blank(), coordinates: [[E.west, E.north], [E.east, E.north], [E.east, E.south], [E.west, E.south]] });
        const firstSymbol = this.map.getStyle().layers.find(l => l.type === 'symbol');
        // weather layer sits under labels, over the basemap fills
        this.map.addLayer({ id: 'kpe-wx', type: 'raster', source: 'kpe-wx', paint: { 'raster-opacity': this.q('.kpe-opacity input').value / 100, 'raster-fade-duration': 300, 'raster-resampling': 'linear' } }, firstSymbol && firstSymbol.id);
        // Boundary visibility boost
        this.map.getStyle().layers.filter(l => /admin/.test(l.id) && l.type === 'line').forEach(l => this.map.setPaintProperty(l.id, 'line-color', '#444'));
        this.map.on('click', e => this.inspect(e));
        this.load();
      });
    }

    blank() { const c = document.createElement('canvas'); c.width = c.height = 2; return c.toDataURL(); }

    async load() {
      if (this.ctrl) this.ctrl.abort(); this.ctrl = new AbortController();
      this.q('.kpe-loading').hidden = false; this.q('.kpe-message').hidden = true;
      try {
        if (!this.manifest) {
          this.manifest = await ForecastAdapter.getManifest(this.base, this.ctrl.signal);
          Object.keys(ForecastAdapter.MODELS).forEach(m => { if (!this.manifest.models[m]) { this.disabled.add(m); this.why = this.why || {}; this.why[m] = (this.manifest.errors || {})[m] || 'No data ingested'; } });
          if (this.disabled.has(this.model)) { const ok = Object.keys(this.manifest.models)[0]; if (!ok) throw new Error('No models have data yet. Run ingest.py.'); this.model = ok; }
          this.syncModels();
        }
        const d = await ForecastAdapter.getForecastData({ model: this.model, date: this.date, base: this.base, signal: this.ctrl.signal });
        this.data = d; this.date = d.date;
        render(d, this.canvas);
        this.map.getSource('kpe-wx').updateImage({ url: this.canvas.toDataURL('image/png') });
        this.buildDates(d); this.buildMeta(d); this.syncModels();
      } catch (err) {
        if (err.name === 'AbortError') return;
        if (!this.data || this.data.model !== this.model) { this.disabled.add(this.model); this.syncModels(); }
        this.msg(err.message);
      } finally { this.q('.kpe-loading').hidden = true; }
    }

    msg(t) { const m = this.q('.kpe-message'); m.textContent = t; m.hidden = false; }

    buildModels() {
      const box = this.q('.kpe-models');
      Object.entries(ForecastAdapter.MODELS).forEach(([id, m]) => {
        const b = document.createElement('button'); b.type = 'button'; b.dataset.model = id; b.textContent = m.label;
        if (m.unsupported) { b.disabled = true; b.title = 'No genuine data feed available'; }
        b.addEventListener('click', () => { this.model = id; this.load(); });
        box.appendChild(b);
      });
    }
    syncModels() {
      this.root.querySelectorAll('.kpe-models button').forEach(b => {
        b.setAttribute('aria-pressed', b.dataset.model === this.model);
        if (this.disabled.has(b.dataset.model)) { b.disabled = true; b.title = (this.why && this.why[b.dataset.model]) || 'No data for this model'; }
      });
    }

    buildDates(d) {
      const box = this.q('.kpe-dates'); box.textContent = '';
      d.dates.forEach(ds => {
        const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab');
        const [wd, day, mon] = fmt.format(new Date(ds + 'T12:00:00+03:00')).replace(',', '').split(' ');
        b.innerHTML = '<strong></strong><small></small>'; b.firstChild.textContent = wd; b.lastChild.textContent = day + ' ' + mon;
        b.setAttribute('aria-selected', ds === this.date);
        b.addEventListener('click', () => { if (ds !== this.date) { this.date = ds; this.load(); } });
        box.appendChild(b);
      });
      const act = box.querySelector('[aria-selected="true"]'); act && act.scrollIntoView({ inline: 'center', block: 'nearest' });
    }

    buildLegend() {
      const lg = this.q('.kpe-legend'), bar = document.createElement('div'); bar.className = 'kpe-bar';
      C.forEach(c => { const i = document.createElement('i'); i.style.background = 'rgb(' + c.join(',') + ')'; bar.appendChild(i); });
      const mk = (cls, odd) => { const r = document.createElement('div'); r.className = 'kpe-ticks ' + cls;
        T.forEach((t, i) => { const s = document.createElement('span'); s.textContent = i % 2 === odd ? t : ''; r.appendChild(s); }); return r; };
      lg.append(mk('top', 1), bar, mk('', 0));
    }

    buildMeta(d) {
      const rows = [['Region', 'Kenya and East Africa'], ['Model', d.modelLabel + ' (' + d.resolution + '; shown on a ' + d.gridStepDeg + '° grid)'],
        ['Model run', eat(d.run)], ['Valid', eat(d.validStart) + ' → ' + eat(d.validEnd)],
        ['Period', d.hours + ' h accumulation' + (d.partial ? ' (partial first day: run start to end of day)' : '')], ['Data updated', eat(d.updated)], ['Source', d.source]];
      this.q('.kpe-title').textContent = 'Precipitation, ' + d.hours + 'h (mm)';
      const dl = this.q('.kpe-meta'); dl.textContent = '';
      rows.forEach(([k, v]) => { const a = document.createElement('dt'), b = document.createElement('dd'); a.textContent = k; b.textContent = v; dl.append(a, b); });
    }

    inspect(e) {
      if (!this.data) return;
      const v = sample(this.data, e.lngLat.lng, e.lngLat.lat);
      const feats = this.map.queryRenderedFeatures(e.point).filter(f => f.properties && f.properties.name);
      const place = feats.length ? feats[0].properties.name : null;
      const el = document.createElement('div'); el.className = 'kpe-pop';
      const lines = ['Lat ' + e.lngLat.lat.toFixed(2) + ', Lon ' + e.lngLat.lng.toFixed(2), place ? 'Near: ' + place : null,
        v == null ? 'No data at this point' : 'Precipitation: ' + v.toFixed(1) + ' mm (interpolated)',
        this.date + ' · ' + this.data.modelLabel].filter(Boolean);
      lines.forEach(t => { const p = document.createElement('div'); p.textContent = t; el.appendChild(p); });
      new mapboxgl.Popup({ closeButton: true }).setLngLat(e.lngLat).setDOMContent(el).addTo(this.map);
    }

    destroy() { if (this.ctrl) this.ctrl.abort(); if (this.map) this.map.remove(); }
  }

  document.querySelectorAll('.kenya-precipitation-explorer').forEach(el => { el.__kpe = new Explorer(el); });
})();
