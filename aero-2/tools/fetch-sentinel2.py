#!/usr/bin/env python3
"""
Build a cloudless satellite basemap for one location, from Sentinel-2 on AWS.

    python3 tools/fetch-sentinel2.py hyderabad
    python3 tools/fetch-sentinel2.py denver --max-zoom 14

Why this exists
---------------
GIBS MODIS is a same-day swath at 250 m, capped at z9. Above ~6 km the ground
is an upscaled blur, and in monsoon season it is solid cloud. Sentinel-2 is
10 m and, picked by date, genuinely cloudless.

Licence is the other half. The EOX s2cloudless service is CC BY-NC-SA, which
does NOT cover a paid installation. This reads the SAME Sentinel-2 data from
the public `sentinel-cogs` bucket, which carries the Copernicus licence and
does permit commercial use. That is the whole reason for the extra steps.

How it picks a scene
--------------------
The orbit is an ellipse ~0.25 deg tall and ~0.425 deg wide, and the camera sees
well past it, so a single 110 km Sentinel-2 tile does not cover a location —
for Hyderabad the orbit runs ~11 km outside the west edge of 44QKE.

So: compute the bbox the flight can actually see, ask STAC which MGRS tiles
intersect it, and require ONE acquisition date that is clear across every one
of them. A per-tile "best" date would mosaic different seasons together and
show as colour steps at the tile seams.

Every asset URL comes from the STAC response. Do not reconstruct S3 paths by
hand — the month is not zero-padded, and guessing it yields a 404 that looks
like missing data.
"""

from __future__ import annotations

import argparse
import json
import re
import math
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import date
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

STAC = "https://earth-search.aws.element84.com/v1/search"

# Shortcuts only — --lat/--lon works for anywhere and is the general path.
#
# The first two mirror aero-2's src/lib/locations.ts; the rest are v1's
# content/locations/catalog.ts, which is the catalog that actually ships. Kept
# as plain numbers rather than parsed out of either TypeScript file: this is an
# offline build step run by hand, and a parser for two differently-shaped
# catalogs is more code than the entries it would read.
#
# `ocean` (Pacific) is deliberately absent: Sentinel-2 does not produce scenes
# over open water, so no date covers it at any cloud threshold. Open water also
# has no 10 m texture to gain. Leave that show on the MODIS basemap.
PLACES = {
    "hyderabad": (17.4435, 78.3772),
    "denver": (39.8561, -104.6737),
    "dubai": (25.2048, 55.2708),
    "mumbai": (19.076, 72.8777),
    "dallas": (32.7767, -96.797),
    "phoenix": (33.4352, -112.0101),
    "las_vegas": (36.1699, -115.1398),
    "chicago_midway": (41.7868, -87.7522),
    "himalayas": (27.9881, 86.925),
    "desert": (23.4241, 25.6628),
    "clouds": (35.6762, 139.6503),
}

# From ORBIT in src/lib/display/flight/orbit.ts: majorMax 0.25 deg of latitude,
# aspect 1.7 east-west. VIEW_MARGIN_DEG is how far past its own ground track
# the camera can see at the 13 km ceiling.
ORBIT_MAJOR_DEG = 0.25
ORBIT_ASPECT = 1.7
VIEW_MARGIN_DEG = 0.4

# Sentinel-2 is 10 m. At z14 a web-mercator pixel is 9.55 m, so z14 is the last
# zoom backed by real source pixels; beyond it the tiles are upscaling and cost
# storage for no detail. Deliberately not raised.
DEFAULT_MAX_ZOOM = 14
DEFAULT_MIN_ZOOM = 8
Z14_RES = 156543.03392804097 / 2**14

R = 6378137.0


def mercator(lon: float, lat: float) -> tuple[float, float]:
    x = R * math.radians(lon)
    y = R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    return x, y


def view_bbox(lat: float, lon: float, margin_deg: float = VIEW_MARGIN_DEG) -> list[float]:
    dlat = ORBIT_MAJOR_DEG + margin_deg
    dlon = ORBIT_MAJOR_DEG * ORBIT_ASPECT + margin_deg
    return [lon - dlon, lat - dlat, lon + dlon, lat + dlat]


# Two boxes, because "how far can the camera see" and "how much detail is worth
# storing out there" have different answers.
#
# At cruise on a globe projection the horizon is ~1,250 km away (measured by
# logging what the kiosk requests over a full orbit). Packing 10 m imagery to
# that radius at z13 is ~23 GB PER LOCATION — not a trade, just impossible on
# an SD card. But the far field is also where a tile covers the most screen and
# the least detail: the browser asks for z8-11 out there and z12-13 only near
# the aircraft.
#
# So: a wide box for the low zooms, a tight one for the high. Measured on
# Denver, sentinel2 requests split {8:17, 9:7, 10:10, 11:19, 12:98, 13:96} —
# the high zooms dominate by count and are all close in.
#
#   wide  z8-11 at 1.2 deg (~130 km)
#   tight z12-13 at 0.65 deg (~72 km)
#
# The first pass used ONE 0.65 deg box for every zoom, which left 18 of 34
# sentinel2 requests 404ing over Denver. Those 404s are harmless — MODIS shows
# through underneath, which is why this is an overlay — but they were coverage
# the same byte budget could have bought.
#
# 1.2 deg rather than the 3.0 deg the horizon would justify, and BOTH limits
# were measured rather than guessed:
#
#   SCRATCH. Each MGRS scene is a ~700 MB COG that gdalwarp streams to local
#   disk. A 3.0 deg box pulled 60 scenes for Denver alone (~20 GB of scratch,
#   x11 locations) — the warp stage, not the tiles, is what does not fit.
#
#   CLOUD. A wider box spans more weather, so requiring one clear acquisition
#   across all of it gets strictly harder: worst-cloud over Denver went 0.07%
#   at 0.65 deg to 4.91% at 3.0 deg, right at the --max-cloud limit. Past some
#   width there is no clear day at all.
#
# So the far field beyond ~130 km stays MODIS. That is the layer's job.
WIDE_MARGIN_DEG = 1.2
WIDE_MAX_ZOOM = 11


def post(body: dict, attempts: int = 4) -> dict:
    """STAC 502s under load; retry rather than lose the whole sweep."""
    data = json.dumps(body).encode()
    req = urllib.request.Request(STAC, data=data, headers={"Content-Type": "application/json"})
    for i in range(attempts):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=60).read())
        except Exception:
            if i == attempts - 1:
                raise
            time.sleep(3 * (i + 1))
    raise AssertionError("unreachable")


# A scene at the edge of the satellite swath fills only a sliver of its MGRS
# tile; the rest is nodata. Such a scene must never be chosen, and it is
# actively attractive to a naive picker: eo:cloud_cover is measured over VALID
# pixels only, so a tile that is 98.79% empty reports ~0% cloud and looks like
# the clearest thing available. Ranking on cloud alone selects the emptiest
# scene on offer, every time, and the mosaic comes out as black wedges.
#
# TRIED AND REVERTED (2026-09-03): treating this as a PREFERENCE rather than a
# rejection — keep partial scenes, rank full ones first, let a tile with no
# full coverage contribute its best partial. The reasoning was sound and the
# result was worse. Mumbai's inland hole is caused by 43QCB/43QCC being
# 10-57% nodata on every pass in a month, so admitting partials did fill it and
# raised the tile count 17 -> 20 at 0.00% cloud. But each partial brings its own
# diagonal swath edge, and those edges displaced scenes that had been covering
# the coast: the mosaic went from 17.8% to 37.3% empty overall, and the NEAR box
# — the part the window actually looks at — from 8.3% to 55.2%.
#
# The lesson is that nodata is not a per-tile property to be optimised
# independently. Adjacent partials do not reliably tile into a whole; they
# overlap along their own orbit geometry, and choosing them tile-by-tile
# rearranges which regions are covered rather than adding coverage. A real fix
# would compose the mosaic by measured area coverage, not by per-tile ranking.
# That is a different algorithm, not a threshold change.
MAX_NODATA_PCT = 5.0

# Concurrent gdalwarp processes.
#
# Each one streams a remote COG, so this is network-bound rather than CPU-bound
# and 6 is comfortably more than the core count. It is also the knob that fails:
# under load, gdalwarp can exhaust its retries, exit 0, and write an EMPTY
# raster — caught by has_pixels() below, which is why that check exists. Mumbai
# hit it on 43QCV at 6 workers and packed cleanly at 3.
DEFAULT_WORKERS = 6

# How far apart the scenes in one mosaic may be acquired.
#
# Requiring a single EXACT date is the obvious rule and it is too strict. The
# odds every tile is clear on one day fall off a cliff with tile count: in the
# survey, locations needing 4-5 scenes found ~0% cloud, while Hyderabad (11
# scenes, because 78E is the UTM 43/44 boundary and its box straddles both
# zones) and Dallas (9) bottomed out at 15-19%. Coverage was being sacrificed
# to a constraint that was never about dates.
#
# What actually matters is that the scenes MATCH — same sun angle, same
# vegetation, same atmosphere. Sentinel-2 L2A is atmospherically corrected
# surface reflectance, and the constellation revisits every ~5 days, so a
# fortnight either side offers several passes per tile while staying well
# inside one season. Months apart is what produces colour steps at the seams;
# a fortnight is not.
WINDOW_DAYS = 15


def pick_date(bbox: list[float], start: str, end: str, max_cloud: float,
              max_nodata: float = MAX_NODATA_PCT):
    """The clearest set of scenes covering every MGRS tile, within one window.

    Returns the anchor date, the worst per-tile cloud, the tiles, and the chosen
    scene per tile. Each (date, tile) usually has TWO acquisitions from adjacent
    orbits; rank by nodata FIRST and cloud second, never cloud alone — see
    MAX_NODATA_PCT.
    """
    # mgrs -> list of (date_ordinal, nodata, cloud, href, date_str)
    per_tile: dict[str, list[tuple[int, float, float, str, str]]] = defaultdict(list)
    # Every MGRS tile the bbox intersects, BEFORE the nodata filter thins it.
    #
    # `grids` below is built from what survives filtering, so a tile that is
    # partial on every pass simply vanishes and the run reports success over a
    # mosaic with a hole in it. That is what happened to Dubai: 40RBN and 39RZH
    # are cloud-free all August and sit at ~28% and ~34% nodata on every single
    # date, so both were dropped, `grids` never knew they were wanted, and the
    # coverage guard failed 35% empty with a message blaming a satellite gap.
    # The scenes were there the whole time.
    #
    # Tracking the unfiltered set separately costs nothing and lets the failure
    # name its real cause.
    seen_any: set[str] = set()
    for page in range(1, 8):
        r = post({
            "collections": ["sentinel-2-l2a"],
            "bbox": bbox,
            "datetime": f"{start}T00:00:00Z/{end}T23:59:59Z",
            "query": {"eo:cloud_cover": {"lt": max_cloud}},
            "limit": 50,
            "page": page,
        })
        feats = r.get("features", [])
        for f in feats:
            nodata = f["properties"].get("s2:nodata_pixel_percentage", 0.0)
            seen_any.add(f["id"].split("_")[1])
            if nodata > max_nodata:
                continue
            day = f["properties"]["datetime"][:10]
            per_tile[f["id"].split("_")[1]].append((
                date.fromisoformat(day).toordinal(),
                nodata,
                f["properties"]["eo:cloud_cover"],
                f["assets"]["visual"]["href"],
                day,
            ))
        if len(feats) < 50:
            break

    grids = sorted(per_tile)
    if not grids:
        sys.exit("No Sentinel-2 scenes at all for that bbox and window.")

    # Say which tiles the nodata filter removed entirely.
    #
    # These are the ones that produce a hole: cloud-free, genuinely available,
    # and partial on every pass, so no anchor date can ever include them. Left
    # silent, the run proceeds over a bbox it cannot fill and the coverage guard
    # blames a satellite gap 20 minutes later. Named here, the operator can see
    # the cause immediately and decide — raise MAX_NODATA_PCT and accept a
    # seamier mosaic, or pick a different date range.
    dropped = sorted(seen_any - set(grids))
    if dropped:
        print(
            f"! {len(dropped)} tile(s) intersect this view but are >"
            f"{max_nodata:g}% nodata on every clear pass: {', '.join(dropped)}\n"
            f"  They will be MISSING from the mosaic. If the coverage check then\n"
            f"  fails, this is why — not weather, and not a gap between passes.\n"
            f"  --max-nodata 35 admits them, at the cost of seamier edges.",
            file=sys.stderr,
        )

    anchors = sorted({o for v in per_tile.values() for o, *_ in v})
    best = None
    for anchor in anchors:
        chosen: dict[str, tuple[float, float, str]] = {}
        for mgrs, scenes in per_tile.items():
            near = [x for x in scenes if abs(x[0] - anchor) <= WINDOW_DAYS]
            if not near:
                break
            # nodata, then cloud, then closest to the anchor for tightest match
            o, nd, cl, href, _ = min(near, key=lambda x: (x[1], x[2], abs(x[0] - anchor)))
            chosen[mgrs] = (nd, cl, href)
        if len(chosen) != len(grids):
            continue
        worst = max(c for _, c, _ in chosen.values())
        spread = max(abs(x[0] - anchor) for m, scenes in per_tile.items()
                     for x in scenes if (x[1], x[2], x[3]) == chosen[m])
        if best is None or worst < best[0]:
            best = (worst, anchor, chosen, spread)

    if best is None:
        print(f"MGRS tiles needed: {grids}", file=sys.stderr)
        sys.exit(
            f"No {WINDOW_DAYS}-day window covers every tile under this cloud\n"
            "threshold. Widen --max-cloud or --start/--end."
        )
    worst, anchor, chosen, spread = best
    return date.fromordinal(anchor).isoformat(), worst, grids, chosen


# A mosaic with holes is the failure this pipeline is most prone to, and it is
# invisible until someone looks at a tile. Measure it instead: rasterise a small
# proof of the mosaic and count black. Anything above this is a coverage bug,
# not an artefact of the rim.
MAX_GAP_PCT = 1.0


def inspect_mosaic(vrt: Path, work: Path) -> tuple[float, float] | None:
    """(% empty, % white) over the visible area. None if Pillow is unavailable.

    The second number is the one STAC cannot give us. `eo:cloud_cover` is a
    cloud mask — it says nothing about SNOW, so a January scene over Denver or
    Chicago can be 0% cloud and still be a white sheet. Both read the same way
    on a window: bright and desaturated. So measure the picture, not the
    metadata. Reported, not enforced: snow on the Front Range is a legitimate
    view, an all-white one is not, and that is a judgement call.
    """
    try:
        from PIL import Image
    except ImportError:
        return None
    proof = work / "coverage-proof.png"
    subprocess.run(["gdal_translate", "-q", "-of", "PNG", "-outsize", "600", "0",
                    str(vrt), str(proof)], check=True)
    px = list(Image.open(proof).convert("RGB").getdata())
    n = len(px)
    black = sum(1 for r, g, b in px if r + g + b < 12)
    white = sum(1 for r, g, b in px
                if r + g + b >= 12 and (r + g + b) / 3 > 140 and max(r, g, b) - min(r, g, b) < 30)
    return 100.0 * black / n, 100.0 * white / n


def run(cmd: list[str]) -> None:
    print("  $", " ".join(cmd[:6]), "..." if len(cmd) > 6 else "", flush=True)
    subprocess.run(cmd, check=True)


def transpose_to_wmts(tiles_dir: Path, min_zoom: int, max_zoom: int, staging: Path) -> None:
    """Move gdal2tiles output into the served layout, transposing as it goes.

    `gdal2tiles --xyz` writes {z}/{x}/{y}; this server reads {z}/{y}/{x}.
    Both are called "XYZ" in the wild and the two orderings are
    indistinguishable on a square grid, which is exactly why this is a function
    rather than a comment: written the wrong way round, every tile 404s while
    the packager reports success and the directory looks plausible — the same
    absence-that-reports-as-success shape as the viirs `.jpg` bug.

    It takes a STAGING dir and merges into `tiles_dir`, and that is the whole
    correctness argument. The first version transposed `tiles_dir` in place, so
    running it for a second place re-transposed the FIRST place's already-
    correct tiles back into gdal2tiles order. Three of seven packs shipped that
    way: Hyderabad had a complete archive on disk and served 129 404s and zero
    hits, because its tiles were filed under x/y while the server asked y/x.
    In-place transposition of a shared tree cannot be made idempotent — the
    tiles carry no record of which way round they are — so the fix is to never
    transpose the shared tree at all.

    Verified end to end after the fix, because every pack in the archive had
    been hand-repaired by then and none of them proved the PACKER worked:
    las_vegas and then phoenix were packed into an empty tree at z8-10, and
    both came out complete and correctly filed, with the second run leaving the
    first untouched. That second run is the whole test — a single clean pack
    would have passed before this bug existed.
    """
    import shutil

    for z in range(min_zoom, max_zoom + 1):
        src = staging / str(z)
        if not src.is_dir():
            continue
        moved = 0
        for xdir in src.iterdir():
            if not xdir.is_dir():
                continue
            for tile in xdir.iterdir():
                if tile.suffix != ".jpg":
                    continue
                # xdir is X, tile stem is Y -> file it under {y}/{x}
                out = tiles_dir / str(z) / tile.stem
                out.mkdir(parents=True, exist_ok=True)
                tile.rename(out / f"{xdir.name}{tile.suffix}")
                moved += 1
        print(f"  z{z}: {moved} tiles -> {{z}}/{{y}}/{{x}}")
    shutil.rmtree(staging, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("place", help="a name from PLACES, or any label when --lat/--lon are given")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--start", default="2026-01-01")
    ap.add_argument("--end", default="2026-06-30")
    ap.add_argument("--max-cloud", type=float, default=5.0)
    # Escape hatch for the coastal case. See MAX_NODATA_PCT: 5% is right when
    # whole scenes are available, and impossible where the orbit only ever
    # clips the corner of a tile — which is most coastlines, and is why Dubai
    # could not be packed at the default.
    ap.add_argument("--max-nodata", type=float, default=MAX_NODATA_PCT,
                    help=f"max %% nodata per scene (default {MAX_NODATA_PCT:g})")
    ap.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                    help=f"concurrent gdalwarp streams (default {DEFAULT_WORKERS}; "
                         f"lower this if a tile comes back empty)")
    ap.add_argument("--min-zoom", type=int, default=DEFAULT_MIN_ZOOM)
    ap.add_argument("--max-zoom", type=int, default=DEFAULT_MAX_ZOOM)
    ap.add_argument("--out", default="data/tiles")
    a = ap.parse_args()

    if a.max_zoom > DEFAULT_MAX_ZOOM:
        print(f"! z{a.max_zoom} upscales: Sentinel-2 is 10 m and z14 is 9.55 m/px.",
              file=sys.stderr)

    if a.lat is not None and a.lon is not None:
        lat, lon = a.lat, a.lon
    elif a.place in PLACES:
        lat, lon = PLACES[a.place]
    else:
        sys.exit(f"unknown place {a.place!r}; pass --lat/--lon, or use one of: "
                 + ", ".join(sorted(PLACES)))
    bbox = view_bbox(lat, lon)
    wide_bbox = view_bbox(lat, lon, WIDE_MARGIN_DEG)
    print(f"{a.place}: near bbox {[round(v, 3) for v in bbox]}")
    print(f"{a.place}: far  bbox {[round(v, 3) for v in wide_bbox]}")

    day, worst, grids, tiles = pick_date(wide_bbox, a.start, a.end, a.max_cloud, a.max_nodata)
    print(f"date {day}: {len(grids)} MGRS tiles, worst cloud {worst:.2f}%")

    work = Path(a.out) / f"_s2-{a.place}"
    work.mkdir(parents=True, exist_ok=True)

    # Warp each scene to web mercator on the z14 pixel grid, so gdal2tiles never
    # resamples a second time.
    #
    # Deliberately NOT cropped to the bbox with -te. Each scene covers only its
    # own corner of it, so -te made twelve full-bbox grids that were mostly
    # nodata — about twice the total pixels, for padding the mosaic discards.
    # -tap keeps every output on the same grid, which is all gdalbuildvrt needs
    # to stitch rasters of differing extents.
    #
    # Run in parallel: each warp is network-bound on a remote COG, so they
    # overlap almost perfectly. Sequentially this stage took ~5 min per scene.
    def has_pixels(path):
        """Did the warp actually write imagery, or a correctly-shaped void?

        gdalwarp streaming a remote COG can exhaust its HTTP retries, write an
        all-zero raster of the right dimensions, and STILL exit 0. It happened
        to 2 of 11 Hyderabad tiles under six concurrent 700 MB streams: valid
        GeoTIFFs, right size, 509 KB of compressed nothing. Exit status does
        not answer the question, so ask the pixels.

        GDAL reports no STATISTICS_MEAN for a band with no valid data, so its
        absence -- or a mean of zero -- is the tell.
        """
        r = subprocess.run(["gdalinfo", "-stats", str(path)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            return False
        means = re.findall(r"STATISTICS_MEAN=([0-9.]+)", r.stdout)
        return bool(means) and max(float(m) for m in means) > 1.0

    def warp(item):
        i, (mgrs, (nodata, cloud, href)) = item
        dst = work / f"{mgrs}.tif"
        # `exists()` is not `usable()`. Caching on existence alone meant a void
        # tile was reused by every subsequent run, so the gap never healed.
        if dst.exists():
            if has_pixels(dst):
                print(f"[{i}/{len(tiles)}] {mgrs} cached", flush=True)
                return str(dst)
            print(f"[{i}/{len(tiles)}] {mgrs} cached but EMPTY - rewarping", flush=True)
            dst.unlink()
        print(f"[{i}/{len(tiles)}] {mgrs} cloud {cloud:.2f}% ...", flush=True)
        subprocess.run([
            "gdalwarp", "-q",
            "-t_srs", "EPSG:3857",
            "-tr", str(Z14_RES), str(Z14_RES), "-tap",
            "-r", "cubic",
            "-co", "COMPRESS=DEFLATE", "-co", "TILED=YES",
            "-wo", "NUM_THREADS=2",
            "--config", "GDAL_CACHEMAX", "512",
            "--config", "AWS_NO_SIGN_REQUEST", "YES",
            # 20 not 5: the failures above were retry exhaustion under load.
            "--config", "GDAL_HTTP_MAX_RETRY", "20",
            "--config", "GDAL_HTTP_RETRY_DELAY", "5",
            f"/vsicurl/{href}", str(dst),
        ], check=True)
        if not has_pixels(dst):
            dst.unlink(missing_ok=True)
            raise RuntimeError(
                f"{mgrs}: gdalwarp exited 0 but wrote an empty raster "
                f"(scene {href.rsplit('/', 2)[-2]}). Retry exhaustion under "
                f"load is the usual cause -- rerun with --workers below "
                f"{DEFAULT_WORKERS} (the tiles already fetched are cached)."
            )
        print(f"[{i}/{len(tiles)}] {mgrs} done", flush=True)
        return str(dst)

    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        warped = list(pool.map(warp, enumerate(sorted(tiles.items()), 1)))

    vrt = work / "mosaic.vrt"
    # The crop lives HERE, not on the warps. Warping full scenes is what makes
    # that stage fast, but the union of ~11 MGRS scenes is far larger than the
    # area the camera can see, and tiling that union would multiply the output
    # for ground nobody ever looks at. -te bounds the mosaic to the visible box.
    #
    # NO -addalpha. An alpha band forces gdal2tiles to emit PNG, several times
    # the bytes of JPEG for a photographic basemap and against the .jpg
    # convention /api/tiles already serves. Warped scenes carry nodata=0, which
    # gdalbuildvrt already honours: later sources fill earlier ones' gaps.
    x0, y0 = mercator(bbox[0], bbox[1])
    x1, y1 = mercator(bbox[2], bbox[3])
    run(["gdalbuildvrt", "-q", "-te", str(x0), str(y0), str(x1), str(y1),
         str(vrt), *warped])

    report = inspect_mosaic(vrt, work)
    if report is None:
        print("! coverage unverified (needs Pillow); check the tiles by eye.")
        holes = 0.0
    else:
        holes, white = report
        if white > 25:
            print(f"! {white:.1f}% of this mosaic is bright and desaturated — snow or "
                  f"haze, which STAC's cloud mask does not report. Look at "
                  f"{work}/coverage-proof.png before shipping it.")
    if report is not None and holes > MAX_GAP_PCT:
        # Name the proof image. The failure message used to describe the hole
        # without saying where to look at it, and the scratch dir is the first
        # thing anyone deletes after a failed run — so the one artefact that
        # explains WHY was routinely thrown away. It is worth keeping: Mumbai's
        # proof showed the Arabian Sea imaged perfectly and the hole sitting
        # inland to the north-east, which is the opposite of what "coastal
        # location, empty mosaic" leads you to assume.
        sys.exit(
            f"mosaic is {holes:.1f}% empty over the visible area — refusing to tile.\n"
            f"Look at {work}/coverage-proof.png: it shows exactly where the hole is.\n"
            "A gap between satellite passes cannot be fixed by a wider date range;\n"
            "weather can. Try --start/--end first, then --max-cloud."
        )
    else:
        print(f"coverage OK: {100 - holes:.2f}% of the visible area has pixels")

    # One flat layer dir for every place, NOT sentinel2/<place>/. Two reasons:
    # `pack-pmtiles.ts <layer>` and /api/tiles both read layer/{z}/{y}/{x}, and
    # separate archives per city would mean per-place routing in the app for no
    # gain. Cities this far apart share no tile at z8-14, so running this for a
    # second place merges into the same tree without collision.
    tiles_dir = Path(a.out) / "sentinel2"

    # Two passes, wide-and-coarse then tight-and-sharp. See WIDE_MARGIN_DEG.
    # Both write into the same layer tree; they cover different zoom ranges so
    # they cannot collide.
    wide_zmax = min(a.max_zoom, WIDE_MAX_ZOOM)
    passes: list[tuple[str, int, int, Path]] = []
    if a.min_zoom <= wide_zmax:
        wx0, wy0 = mercator(wide_bbox[0], wide_bbox[1])
        wx1, wy1 = mercator(wide_bbox[2], wide_bbox[3])
        wide_vrt = work / "mosaic-wide.vrt"
        run(["gdalbuildvrt", "-q", "-te", str(wx0), str(wy0), str(wx1), str(wy1),
             str(wide_vrt), *warped])
        passes.append(("far field", a.min_zoom, wide_zmax, wide_vrt))
    if a.max_zoom > WIDE_MAX_ZOOM:
        passes.append(("near field", max(a.min_zoom, WIDE_MAX_ZOOM + 1), a.max_zoom, vrt))

    # gdal2tiles writes into a per-run STAGING dir, never straight into the
    # shared layer tree. See transpose_to_wmts: the shared tree holds every
    # place, already in served order, and re-walking it would flip tiles a
    # previous run had put right.
    for label, zmin, zmax, source in passes:
        staging = work / f"tiles-{zmin}-{zmax}"
        print(f"tiling {label} z{zmin}-{zmax} -> {tiles_dir}")
        run([
            "gdal2tiles.py", "--xyz", "-w", "none", "--processes", "8",
            "--tiledriver", "JPEG", "--jpeg-quality", "85",
            "-z", f"{zmin}-{zmax}", "-r", "cubic",
            str(source), str(staging),
        ])
        transpose_to_wmts(tiles_dir, zmin, zmax, staging)

    meta = {"place": a.place, "date": day, "mgrs": grids,
            "worstCloudPct": round(worst, 3), "bbox": bbox,
            "minZoom": a.min_zoom, "maxZoom": a.max_zoom,
            "licence": "Copernicus Sentinel data — commercial use permitted"}
    (tiles_dir / f"source-{a.place}.json").write_text(json.dumps(meta, indent=1))
    print(f"done. {tiles_dir}/source-{a.place}.json records the scene and licence.")
    print(f"next: bun tools/pack-pmtiles.ts sentinel2 data/tiles/sentinel2.pmtiles")
    print(f"the warp scratch in {work} is safe to delete once packed.")


if __name__ == "__main__":
    main()
