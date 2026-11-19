/* Reads the static JSON written by ingest.py. Built to beat aggressive server/CDN caches:
 *  - forecasts are saved under unique names (<model>_<run>_<hash>.json) that latest.json points to; only latest.json needs cache-busting
 *  - requests for it get a unique ?cb= query string and cache:'no-store' (no custom headers, so no CORS preflight)
 *  - data-data-base may list several mirrors (comma-separated); the file with the newest "updated" wins. */
(function (global) {
  'use strict';
  const MODELS = { ecmwf_ifs: { label: 'ECMWF IFS' }, gfs: { label: 'GFS' }, icon: { label: 'ICON' } };
  const EXTENT = { west: -26, east: 60, south: -36, north: 38 };  // must match ingest.py
  const cache = new Map(), TTL = 10 * 60 * 1000;
  const bases = b => String(b || 'data').split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
  const bust = u => u + (u.includes('?') ? '&' : '?') + 'cb=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const aborted = s => { if (s && s.aborted) throw new DOMException('Aborted', 'AbortError'); };

  async function fetchJSON(url, signal) {
    const r = await fetch(bust(url), { signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  // latest.json (the only fixed-name file) is fetched with a cache-buster; the unique file names it lists never change, so they cache safely.
  async function pointers(base, signal) {
    const rs = await Promise.allSettled(bases(base).map(async b => ({ b, p: await fetchJSON(b + '/latest.json', signal) })));
    aborted(signal);
    return rs.filter(r => r.status === 'fulfilled' && r.value.p && r.value.p.models).map(r => r.value);
  }
  async function loadRaw(model, base, signal) {
    const key = base + '|' + model, hit = cache.get(key);
    if (hit && Date.now() - hit.t < TTL) return hit.v;
    const ptrs = await pointers(base, signal), jobs = [];
    ptrs.forEach(({ b, p }) => { const m = p.models[model]; if (m && m.file) jobs.push(fetch(b + '/' + m.file, { signal }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })); });
    if (!jobs.length) bases(base).forEach(b => jobs.push(fetchJSON(b + '/' + model + '.json', signal)));  // legacy fixed names (hand-uploaded files)
    const res = await Promise.allSettled(jobs); aborted(signal);
    const ok = res.filter(x => x.status === 'fulfilled').map(x => x.value).filter(v => v && Array.isArray(v.days) && v.days.length);
    if (!ok.length) throw new Error('No forecast file for ' + MODELS[model].label + ' (' + ((res[0] && res[0].reason && res[0].reason.message) || 'not listed in latest.json') + ').');
    const v = ok.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0];  // freshest mirror wins
    cache.set(key, { t: Date.now(), v }); return v;
  }
  async function availableModels(base, signal) {
    const ptrs = await pointers(base, signal), out = {};
    if (ptrs.length) { Object.keys(MODELS).forEach(id => { out[id] = ptrs.some(x => x.p.models[id] && x.p.models[id].file); }); return out; }
    await Promise.all(Object.keys(MODELS).map(async id => {  // no latest.json: probe legacy names
      const rs = await Promise.allSettled(bases(base).map(b => fetch(bust(b + '/' + id + '.json'), { method: 'HEAD', cache: 'no-store', signal })));
      out[id] = rs.some(r => r.status === 'fulfilled' && (r.value.ok || r.value.status === 405));
    }));
    aborted(signal); return out;
  }
  const axis = (a, b, s) => { const o = []; for (let v = a; v <= b + 1e-9; v += s) o.push(+v.toFixed(4)); return o; };

  async function getForecastData({ model, date = null, base = 'data', signal }) {
    if (!MODELS[model]) throw new Error('Unknown model: ' + model);
    const r = await loadRaw(model, base, signal);
    const day = r.days.find(x => x.date === date) || r.days[0];
    const e = r.extent, lons = axis(e.west, e.east, r.step), lats = axis(e.south, e.north, r.step), nx = lons.length, values = [];
    for (let y = 0; y < lats.length; y++) values.push(day.values.slice(y * nx, (y + 1) * nx));
    return {
      model, modelLabel: MODELS[model].label, resolution: r.resolution, run: r.run, date: day.date, validStart: day.start, validEnd: day.end,
      hours: day.hours, partial: !!day.partial, extent: e, lons, lats, values, units: r.units, source: r.source, updated: r.updated,
      dates: r.days.map(x => x.date), gridStepDeg: r.step,
      wind: day.wind ? { time: day.wind.time, step: day.wind.step, stepDeg: day.wind.step_deg, u: day.wind.u, v: day.wind.v,
        nx: Math.round((e.east - e.west) / day.wind.step_deg) + 1, ny: Math.round((e.north - e.south) / day.wind.step_deg) + 1 } : null
    };
  }

  // Daily totals at a point for every day of an already-loaded model (null if not loaded).
  function pointSeries({ model, lon, lat, base = 'data' }) {
    const hit = cache.get(base + '|' + model); if (!hit) return null;
    const r = hit.v, e = r.extent, s = r.step, nx = Math.round((e.east - e.west) / s) + 1, ny = Math.round((e.north - e.south) / s) + 1;
    const fx = (lon - e.west) / s, fy = (lat - e.south) / s, inside = fx >= 0 && fy >= 0 && fx <= nx - 1 && fy <= ny - 1;
    return r.days.map(d => {
      let v = null;
      if (inside) {
        const x0 = Math.min(Math.floor(fx), nx - 2), y0 = Math.min(Math.floor(fy), ny - 2), tx = fx - x0, ty = fy - y0, i = y0 * nx + x0;
        const q = [d.values[i], d.values[i + 1], d.values[i + nx], d.values[i + nx + 1]];
        if (q.every(x => x != null)) v = (q[0] * (1 - tx) + q[1] * tx) * (1 - ty) + (q[2] * (1 - tx) + q[3] * tx) * ty;
      }
      return { date: d.date, hours: d.hours, partial: !!d.partial, value: v };
    });
  }
  global.ForecastAdapter = { getForecastData, availableModels, pointSeries, clearCache: () => cache.clear(), MODELS, EXTENT };
})(window);
