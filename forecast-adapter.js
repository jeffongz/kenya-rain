/* Provider-independent adapter. Reads the static JSON written by ingest.py (no per-view API calls).
 * getForecastData({model, date, base, signal}) -> {model, modelLabel, resolution, run, date, validStart, validEnd,
 *   hours, partial, extent, lons, lats, values[lat][lon] (mm|null), units, source, updated, dates[], gridStepDeg}
 * A Meteologix/Kachelmann API provider can be added to `providers` later; none is implemented here. */
(function (global) {
  'use strict';
  const MODELS = {
    ecmwf_ifs: { label: 'ECMWF IFS' }, gfs: { label: 'GFS' }, icon: { label: 'ICON' },
    ukmo: { label: 'UKMO' }, access_g: { label: 'ACCESS-G' }
  };
  const EXTENT = { west: 28, east: 52, south: -12, north: 15 };
  const cache = new Map(), TTL = 10 * 60 * 1000;

  async function getJSON(url, signal) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < TTL) return hit.v;
    const res = await fetch(url, { signal, cache: 'no-cache' });
    if (!res.ok) throw new Error('No data file at ' + url + ' (HTTP ' + res.status + '). Has ingest.py run for this model?');
    const v = await res.json(); cache.set(url, { t: Date.now(), v }); return v;
  }
  async function getManifest(base = 'data', signal) {
    // 1) use manifest.json when it is valid
    try {
      const m = await getJSON(base + '/manifest.json', signal);
      if (m && m.models) return { errors: {}, ...m };
    } catch (e) { if (e.name === 'AbortError') throw e; }
    // 2) otherwise detect which model files exist (no manifest needed)
    const models = {}, errors = {};
    await Promise.all(Object.keys(MODELS).map(async id => {
      try {
        const r = await fetch(base + '/' + id + '.json', { method: 'HEAD', signal, cache: 'no-cache' });
        if (r.ok) models[id] = {}; else errors[id] = 'No data file (' + id + '.json)';
      } catch (e) { if (e.name === 'AbortError') throw e; errors[id] = 'No data file (' + id + '.json)'; }
    }));
    if (!Object.keys(models).length) throw new Error('No forecast files found in "' + base + '/". Add at least one model file, e.g. gfs.json.');
    return { models, errors, detected: true };
  }
  const axis = (a, b, s) => { const o = []; for (let v = a; v <= b + 1e-9; v += s) o.push(+v.toFixed(4)); return o; };

  async function getForecastData({ model, date = null, base = 'data', parameter = 'precipitation_accumulation', signal }) {
    if (parameter !== 'precipitation_accumulation') throw new Error('Unsupported parameter: ' + parameter);
    if (!MODELS[model]) throw new Error('Unknown model: ' + model);
    const r = await getJSON(base + '/' + model + '.json', signal);
    if (!r.days || !r.days.length) throw new Error('Model file contains no forecast days.');
    const day = r.days.find(x => x.date === date) || r.days[0];
    const e = r.extent, lons = axis(e.west, e.east, r.step), lats = axis(e.south, e.north, r.step), nx = lons.length, values = [];
    for (let y = 0; y < lats.length; y++) values.push(day.values.slice(y * nx, (y + 1) * nx));
    return {
      model, modelLabel: MODELS[model].label, resolution: r.resolution, run: r.run, date: day.date, validStart: day.start, validEnd: day.end,
      hours: day.hours, partial: !!day.partial, extent: e, lons, lats, values, units: r.units, source: r.source, updated: r.updated,
      dates: r.days.map(x => x.date), gridStepDeg: r.step
    };
  }
  global.ForecastAdapter = { getForecastData, getManifest, MODELS, EXTENT };
})(window);