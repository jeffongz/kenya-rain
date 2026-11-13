# Kenya precipitation explorer: integration guide

## Architecture
`ingest.py` (server, cron) -> `data/<model>.json` + `data/manifest.json` -> browser (`forecast-adapter.js`, `script.js`).
The browser never calls a weather API, so traffic cannot exhaust any quota. Serve `data/` as static files (gzip on).

## Setup
1. `pip install numpy scipy eccodes eccodeslib ecmwf-opendata`
2. `python ingest.py` (all models) or `python ingest.py gfs`. Then schedule it: `30 */6 * * * python /path/ingest.py`
   (ECMWF open data lags ~2-8 h after the run, so a failed model keeps its previous file and is logged in `manifest.json`.)
3. Put your public Mapbox token in `data-mapbox-token`; keep `data-data-base` pointing at the `data/` URL.

## Models
| id | source | status |
|---|---|---|
| ecmwf_ifs | ECMWF Open Data via `ecmwf-opendata` (aws/azure/google/ecmwf; set `ECMWF_SOURCE`), CC-BY-4.0 | implemented |
| gfs | NOAA bucket `noaa-gfs-bdp-pds`, `.idx` byte-range, APCP buckets re-accumulated | implemented |
| icon | DWD `opendata.dwd.de` TOT_PREC + CLAT/CLON, nearest-neighbour regrid | implemented |
| ukmo | Met Office AWS bucket (CC BY-SA, NetCDF) | **stub**: verify the object layout first |
| access_g | BoM, registered users via cloud FTP only | **not open data**; stub |

## Notes
- Windows are EAT days (21Z-21Z) where the model has steps there; later IFS days (6-hourly) shift to 18Z-18Z and the first day is
  partial. The UI shows each window's real start/end/hours.
- Not run against the live servers from the build environment (network allow-list); first run may need small fixes.
- Attribution to show: ECMWF (CC-BY-4.0), NOAA/NCEP, DWD, plus Mapbox/OSM from the map.
