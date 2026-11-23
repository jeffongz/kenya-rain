#!/usr/bin/env python3
"""Ingest open NWP precipitation forecasts -> static JSON for the Kenya explorer.

Usage:  python ingest.py [ecmwf_ifs gfs icon ...]     (default: all implemented models)
Cron:   every 6 h, e.g.  30 */6 * * *  python /path/ingest.py
Needs:  pip install numpy scipy eccodes ecmwf-opendata   (eccodes needs the ECMWF ecCodes library; `pip install eccodeslib` bundles it)

Output: $KPE_DATA/<model>.json and $KPE_DATA/manifest.json (default dir: ./data)
Each day is a precipitation accumulation between two forecast steps: cum(b) - cum(a), in mm.
Windows are EAT calendar days (21Z-21Z) when the model has steps there; otherwise shifted by +/-3 h or
shortened (first day), and the ACTUAL start/end/hours are always written to the JSON.
"""
import bz2, glob, hashlib, signal, datetime as dt, json, os, re, sys, tempfile, time, urllib.error, urllib.request
import numpy as np
import eccodes
from scipy.spatial import cKDTree

W, E, S, N, STEP = -26.0, 60.0, -36.0, 38.0, 0.25   # all of Africa (Cape Verde to Mauritius). Keep (E-W)/STEP and (N-S)/STEP EVEN: the 0.5 deg wind grid reuses every 2nd point
LON = np.arange(W, E + 1e-9, STEP)
LAT = np.arange(S, N + 1e-9, STEP)
LL = np.array([(a, b) for a in LAT for b in LON])
OUT = os.environ.get('KPE_DATA', 'data')
UTC, EAT = dt.timezone.utc, dt.timezone(dt.timedelta(hours=3))


DEADLINE = float('inf')  # set per model in main(): stop instead of hanging the whole job


def http(url, rng=None):
    err = None
    for attempt in range(3):
        if time.time() > DEADLINE:
            raise TimeoutError('time budget for this model exhausted')
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'kenya-precip-explorer/1.0'})
            if rng:
                req.add_header('Range', 'bytes=' + rng)
            print('  GET', url[-85:], flush=True)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404):
                raise
            err = e
        except Exception as e:
            err = e
        time.sleep(2 * (attempt + 1))
    raise err


def runs(cycles, n=8):
    now = dt.datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    t, out = now, []
    while len(out) < n:
        if t.hour in cycles:
            out.append(t)
        t -= dt.timedelta(hours=1)
    return out


def windows(run, avail):
    out, d0 = [], run.astimezone(EAT).date()
    for k in range(int(os.environ.get('KPE_DAYS', '7')) + 1):
        day = d0 + dt.timedelta(days=k)
        mid = dt.datetime(day.year, day.month, day.day, tzinfo=EAT).astimezone(UTC)
        end = mid + dt.timedelta(hours=24)
        partial = mid < run
        cands = [(run, end)] if partial else [(mid + dt.timedelta(hours=o), end + dt.timedelta(hours=o)) for o in (0, -3, 3)]
        for s, e in cands:
            a, b = int((s - run).total_seconds() // 3600), int((e - run).total_seconds() // 3600)
            if a >= 0 and a in avail and b in avail and b - a >= (12 if partial else 24):
                out.append(dict(date=day.isoformat(), a=a, b=b, start=s, end=e)); break
    return out


def mid_step(w, avail):
    """available forecast step nearest the middle of the accumulation window (wind snapshot)"""
    t = (w['a'] + w['b']) / 2
    return min(avail, key=lambda s: (abs(s - t), s))


def safe(fn, *a):
    try:
        return fn(*a)
    except Exception as e:  # wind is optional: never lose rainfall because of it
        print('  wind skipped:', e); return {}


def read_msgs(path, coords=True):
    res = []
    with open(path, 'rb') as f:
        while True:
            h = eccodes.codes_grib_new_from_file(f)
            if h is None:
                break
            try:
                m = dict(step=eccodes.codes_get(h, 'endStep'), name=eccodes.codes_get(h, 'shortName'), val=eccodes.codes_get_values(h))
                if coords:
                    m['key'] = grid_key(h)
                    if m['key'] is None or m['key'] not in _GRID:  # coordinates only needed once per grid
                        m['lat'] = eccodes.codes_get_array(h, 'latitudes'); m['lon'] = eccodes.codes_get_array(h, 'longitudes')
                res.append(m)
            finally:
                eccodes.codes_release(h)
    return res


_GRID = {}


def grid_key(h):
    try:
        return tuple(eccodes.codes_get(h, k) for k in ('Ni', 'Nj', 'latitudeOfFirstGridPointInDegrees', 'longitudeOfFirstGridPointInDegrees',
                                                      'latitudeOfLastGridPointInDegrees', 'longitudeOfLastGridPointInDegrees'))
    except Exception:
        return None


def regrid(m, val):
    key = m.get('key')
    if key is not None and key in _GRID:
        sel, idx, far = _GRID[key]
    else:
        lat, lon = m['lat'], m['lon']
        lon = np.where(lon > 180, lon - 360, lon)
        sel = (lat >= S - 1) & (lat <= N + 1) & (lon >= W - 1) & (lon <= E + 1)
        d, idx = cKDTree(np.c_[lat[sel], lon[sel]]).query(LL); far = d > 0.3
        if key is not None:
            _GRID[key] = (sel, idx, far)
    out = np.asarray(val[sel][idx], dtype=float); out[far] = np.nan
    return out.reshape(len(LAT), len(LON))


def r1(x):  # 1 decimal; whole numbers written as ints (smaller files: most of the continent is dry)
    v = round(float(x), 1)
    return int(v) if v == int(v) else v


ZERO = np.zeros((len(LAT), len(LON)))


def ecmwf_wind(client, run, steps):
    with tempfile.TemporaryDirectory() as td:
        tgt = os.path.join(td, 'uv.grib2')
        client.retrieve(date=run.strftime('%Y%m%d'), time=run.hour, stream='oper', type='fc', step=steps, param=['10u', '10v', '2t'], target=tgt)
        got = {}
        for m in read_msgs(tgt):
            got.setdefault(int(m['step']), {})[m['name']] = regrid(m, m['val'])
    return {s: dict(u=d.get('10u'), v=d.get('10v'), t=(d['2t'] - 273.15 if '2t' in d else None)) for s, d in got.items()}


# ---------------- ECMWF IFS open data (CC-BY-4.0) via the official ecmwf-opendata client ----------------
def fetch_ecmwf():
    from ecmwf.opendata import Client
    # The library's defaults retry 500 times with 120 s pauses, which stalls the job on a 503. Fail fast and try other mirrors.
    first = os.environ.get('ECMWF_SOURCE')
    sources = ([first] if first else []) + [x for x in ('aws', 'google', 'azure', 'ecmwf') if x != first]
    avail = set(range(0, 145, 3)) | set(range(150, 361, 6))
    for run in runs({0, 12}, 4):
        wins = windows(run, avail)
        need = sorted({s for w in wins for s in (w['a'], w['b'])} - {0})
        if not wins:
            continue
        for src in sources:
            with tempfile.TemporaryDirectory() as td:
                tgt = os.path.join(td, 'tp.grib2')
                try:
                    client = Client(source=src, maximum_retries=3, retry_after=10, use_server_retry_after=False)  # azure builds a token here
                    client.retrieve(date=run.strftime('%Y%m%d'), time=run.hour, stream='oper', type='fc', step=need, param='tp', target=tgt)
                except Exception as e:  # mirror overloaded, or run not published there yet
                    print('  ecmwf', src, run, 'failed:', str(e)[:120], flush=True); continue
                cum = {0: ZERO}
                for m in read_msgs(tgt):
                    cum[int(m['step'])] = regrid(m, m['val'] * 1000.0)  # tp is metres
            print('  ecmwf source:', src, run, flush=True)
            wind = safe(ecmwf_wind, client, run, sorted({mid_step(w, avail) for w in wins}))
            return run, wins, cum, 'ECMWF Open Data (CC-BY-4.0)', '0.25°', wind
    raise RuntimeError('no ECMWF run available from any mirror')


# ---------------- GFS 0.25 deg on the NOAA AWS bucket: .idx + HTTP range ----------------
GFS = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com'


def gfs_url(run, step):
    return '%s/gfs.%s/%02d/atmos/gfs.t%02dz.pgrb2.0p25.f%03d' % (GFS, run.strftime('%Y%m%d'), run.hour, run.hour, step)


def gfs_records(run, step):
    lines = http(gfs_url(run, step) + '.idx').decode().splitlines()
    recs = []
    for i, ln in enumerate(lines):
        p = ln.split(':')
        if len(p) > 5 and p[3] == 'APCP' and p[4] == 'surface':
            mm = re.match(r'(\d+)-(\d+) hour acc', p[5])
            if mm:
                end = int(lines[i + 1].split(':')[1]) - 1 if i + 1 < len(lines) else ''
                recs.append((int(mm.group(1)), int(mm.group(2)), '%s-%s' % (p[1], end)))
    return recs


def gfs_wind(run, steps):
    out = {}
    for f in steps:
        lines = http(gfs_url(run, f) + '.idx').decode().splitlines(); got = {}
        for i, ln in enumerate(lines):
            p = ln.split(':')
            if len(p) > 4 and ((p[3] in ('UGRD', 'VGRD') and p[4] == '10 m above ground') or (p[3] == 'TMP' and p[4] == '2 m above ground')):
                end = int(lines[i + 1].split(':')[1]) - 1 if i + 1 < len(lines) else ''
                with tempfile.NamedTemporaryFile(suffix='.grib2') as tf:
                    tf.write(http(gfs_url(run, f), '%s-%s' % (p[1], end))); tf.flush()
                    m = read_msgs(tf.name)[0]
                got[p[3]] = regrid(m, m['val'])
        if got:
            out[f] = dict(u=got.get('UGRD'), v=got.get('VGRD'), t=(got['TMP'] - 273.15 if 'TMP' in got else None))
    return out


def fetch_gfs():
    avail = set(range(0, 121)) | set(range(123, 385, 3))
    for run in runs({0, 6, 12, 18}):
        wins = windows(run, avail)
        if not wins:
            continue
        try:
            http(gfs_url(run, max(w['b'] for w in wins)) + '.idx')
        except urllib.error.HTTPError:
            print('  gfs', run, 'not complete yet'); continue
        cache = {0: ZERO}

        def cum(f):  # APCP buckets reset every 6 h, so rebuild cumulative totals from the idx intervals
            if f in cache:
                return cache[f]
            r = min((x for x in gfs_records(run, f) if x[1] == f), key=lambda x: x[0])
            with tempfile.NamedTemporaryFile(suffix='.grib2') as tf:
                tf.write(http(gfs_url(run, f), r[2])); tf.flush()
                m = read_msgs(tf.name)[0]
            cache[f] = regrid(m, m['val']) + (cum(r[0]) if r[0] > 0 else 0)
            return cache[f]
        for w in wins:
            cum(w['a']); cum(w['b'])
        wind = safe(gfs_wind, run, sorted({mid_step(w, avail) for w in wins}))
        return run, wins, cache, 'NOAA GFS (public domain)', '0.25°', wind
    raise RuntimeError('no GFS run available')


# ---------------- DWD ICON global (icosahedral GRIB2 -> nearest neighbour onto 0.25 deg) ----------------
def fetch_icon():
    avail = set(range(0, 181, 3))
    for run in runs({0, 6, 12, 18}):
        wins = windows(run, avail)
        if not wins:
            continue
        hh, ymdh = run.strftime('%H'), run.strftime('%Y%m%d%H')
        base = 'https://opendata.dwd.de/weather/nwp/icon/grib/' + hh

        def grab(var, folder, step=None, kind='time-invariant'):
            name = 'icon_global_icosahedral_%s_%s_%s%s.grib2.bz2' % (kind, ymdh, '%03d_' % step if step is not None else '', var)
            raw = bz2.decompress(http('%s/%s/%s' % (base, folder, name)))
            with tempfile.NamedTemporaryFile(suffix='.grib2') as tf:
                tf.write(raw); tf.flush()
                return read_msgs(tf.name, coords=False)[0]['val']
        try:
            need = sorted({s for w in wins for s in (w['a'], w['b'])} - {0})
            grab('TOT_PREC', 'tot_prec', need[-1], 'single-level')  # probe: is the run complete?
        except urllib.error.HTTPError:
            print('  icon', run, 'not complete yet'); continue
        clat, clon = grab('CLAT', 'clat'), grab('CLON', 'clon')
        if np.abs(clat).max() <= np.pi + 0.01:  # DWD stores some grid files in radians
            clat, clon = np.degrees(clat), np.degrees(clon)
        clon = np.where(clon > 180, clon - 360, clon)
        m = (clat >= S - 1) & (clat <= N + 1) & (clon >= W - 1) & (clon <= E + 1)
        d, idx = cKDTree(np.c_[clat[m], clon[m]]).query(LL)
        cum = {0: ZERO}
        for s in need:
            v = grab('TOT_PREC', 'tot_prec', s, 'single-level')[m][idx].astype(float)
            v[d > 0.3] = np.nan; cum[s] = v.reshape(len(LAT), len(LON))
        def wind_icon():
            out = {}
            for s in sorted({mid_step(w, avail) for w in wins}):
                f = {}
                for key, var in (('u', 'U_10M'), ('v', 'V_10M'), ('t', 'T_2M')):
                    try:
                        v = grab(var, var.lower(), s, 'single-level')[m][idx].astype(float); v[d > 0.3] = np.nan
                        f[key] = v.reshape(len(LAT), len(LON)) - (273.15 if key == 't' else 0)
                    except Exception as e:
                        print('  icon', var, 'skipped:', str(e)[:80], flush=True)
                out[s] = f
            return out
        wind = safe(wind_icon)
        return run, wins, cum, 'DWD ICON open data (CC BY 4.0)', '~13 km native, 0.25° shown', wind
    raise RuntimeError('no ICON run available')


def fetch_ukmo():
    raise NotImplementedError('UKMO: bucket s3://met-office-atmospheric-model-data is open (CC BY-SA, NetCDF) but its object layout '
                              'was not verified. List it with `aws s3 ls --no-sign-request`, then implement this function.')


def fetch_access_g():
    raise NotImplementedError('ACCESS-G is distributed to registered BoM users via cloud FTP/SFTP only; not open data.')


MODELS = {'ecmwf_ifs': fetch_ecmwf, 'gfs': fetch_gfs, 'icon': fetch_icon, 'ukmo': fetch_ukmo, 'access_g': fetch_access_g}


def write_json(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, separators=(',', ':'))
    os.replace(tmp, path)


def write_unique(name, run, obj):
    """Save as <model>_<run YYYYMMDDHH>_<sha1 of content>.json: a new name for every new forecast, so no cache can serve a stale copy."""
    body = json.dumps(obj, separators=(',', ':'))
    fname = '%s_%s_%s.json' % (name, run.strftime('%Y%m%d%H'), hashlib.sha1(body.encode()).hexdigest()[:8])
    tmp = os.path.join(OUT, fname + '.tmp')
    with open(tmp, 'w') as f:
        f.write(body)
    os.replace(tmp, os.path.join(OUT, fname))
    old = sorted(glob.glob(os.path.join(OUT, name + '_*.json')), key=os.path.getmtime, reverse=True)[3:]  # keep the newest 3
    for o in old:
        os.remove(o)
    return fname


def _alarm(signum, frame):
    raise TimeoutError('time budget for this model exhausted')


def main(names):
    global DEADLINE
    os.makedirs(OUT, exist_ok=True)
    mp = os.path.join(OUT, 'latest.json')  # the only fixed-name file: points at the current unique file of each model
    man = json.load(open(mp)) if os.path.exists(mp) else {'models': {}, 'errors': {}}
    for name in names:
        print('==', name, flush=True)
        DEADLINE = time.time() + int(os.environ.get('KPE_BUDGET', '600'))
        if hasattr(signal, 'SIGALRM'):  # hard stop even if a library call hangs
            signal.signal(signal.SIGALRM, _alarm); signal.alarm(int(os.environ.get('KPE_BUDGET', '600')))
        try:
            run, wins, cum, source, res, wind = MODELS[name]()
            days = []
            for w in wins:
                f = np.clip(cum[w['b']] - cum[w['a']], 0, None)
                days.append(dict(date=w['date'], start=w['start'].strftime('%Y-%m-%dT%H:%M:%SZ'), end=w['end'].strftime('%Y-%m-%dT%H:%M:%SZ'),
                                 hours=w['b'] - w['a'], partial=w['a'] == 0 and w['start'] > w['end'] - dt.timedelta(hours=24),
                                 values=[None if np.isnan(x) else r1(x) for x in f.ravel()]))
                if wind:  # 10 m wind snapshot near the middle of the window, stored at 0.5 deg to keep files small
                    k = min(wind, key=lambda s: abs(s - (w['a'] + w['b']) / 2))
                    if abs(k - (w['a'] + w['b']) / 2) <= 6:
                        cell = lambda a: [None if np.isnan(x) else round(float(x), 1) for x in a[::2, ::2].ravel()]
                        tm = (run + dt.timedelta(hours=k)).strftime('%Y-%m-%dT%H:%M:%SZ'); fl = wind[k]
                        if fl.get('u') is not None and fl.get('v') is not None:
                            days[-1]['wind'] = dict(step=k, time=tm, step_deg=STEP * 2, u=cell(fl['u']), v=cell(fl['v']))
                        if fl.get('t') is not None:   # 2 m temperature (deg C) at the same snapshot time
                            days[-1]['temp'] = dict(step=k, time=tm, step_deg=STEP * 2, values=cell(fl['t']))
            upd = dt.datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
            fname = write_unique(name, run, dict(model=name, run=run.strftime('%Y-%m-%dT%H:%M:%SZ'), resolution=res, source=source,
                                 updated=upd, units='mm', extent=dict(west=W, east=E, south=S, north=N), step=STEP, days=days))
            entry = dict(file=fname, run=run.strftime('%Y-%m-%dT%H:%M:%SZ'), updated=upd, days=len(days))
            man['models'][name] = entry; man['errors'].pop(name, None)
            write_json(os.path.join(OUT, '_ptr_%s.json' % name), dict(model=name, **entry))  # fragment merged into latest.json by the workflow
            print('  wrote', fname, flush=True)
        except Exception as e:
            man['errors'][name] = str(e); print('  FAILED:', e)
    if hasattr(signal, 'SIGALRM'):
        signal.alarm(0)
    man['generated'] = dt.datetime.now(UTC).strftime('%Y-%m-%dT%H:%M:%SZ')
    write_json(mp, man)


if __name__ == '__main__':
    main(sys.argv[1:] or list(MODELS))
