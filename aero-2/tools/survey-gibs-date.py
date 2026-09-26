#!/usr/bin/env python3
"""
survey-gibs-date — pick the day GIBS_DATE should be pinned to.

`src/lib/server/tiles.ts` tells you to "sweep candidates against every catalog
entry, discard any that is not 11/11, then take the lowest washed-out
percentage". That instruction shipped for months with nothing that could carry
it out, so the pin was set on coverage alone and 08-23 sat at 24.4% near-white
tiles: over Denver, a north-south band brightening with longitude — a MODIS
swath edge — that looked for all the world like a broken imagery grade.

Two bars, and they are not the same bar:

  COVERAGE  a day with no tile over a location renders a black void under a
            lit sky. This is a gate, not a score.
  CLARITY   a covered tile can still be solid cloud. MODIS true colour is a
            same-day swath, so this varies wildly day to day.

Usage (dates are what you want to compare; there is no default set, because
the right candidates depend on when you are reading this):

    python3 tools/survey-gibs-date.py 2026-06-15 2026-06-20 2026-08-23

Needs Pillow: `pip install pillow`. Not a repo dependency — it decodes JPEGs
for a one-off decision, and adding an image library to a kiosk's install to
support a script that runs twice a year is the wrong trade.
"""

import concurrent.futures as cf
import io
import math
import sys
import time
import urllib.error
import urllib.request

try:
    from PIL import Image
except ImportError:
    sys.exit("needs Pillow: pip install pillow")

# Mirrors Location.CATALOG in src/lib/locations.ts. Duplicated on
# purpose: this is a standalone script, and importing the TS catalog would mean
# a build step for a tool whose whole value is being runnable on its own.
# If a location is added there and not here, the sweep silently under-tests —
# so check both when the catalog changes.
LOCATIONS = [
    ("hyderabad", 17.4435, 78.3772),
    ("mumbai", 19.076, 72.8777),
    ("dubai", 25.2048, 55.2708),
    ("dallas", 32.7767, -96.797),
    ("phoenix", 33.4352, -112.0101),
    ("las_vegas", 36.1699, -115.1398),
    ("denver", 39.8561, -104.6737),
    ("chicago_midway", 41.7868, -87.7522),
    ("himalayas", 27.9881, 86.925),
    ("ocean", 21.3069, -157.8583),
    ("desert", 23.4241, 25.6628),
]

URL = (
    "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/"
    "MODIS_Terra_CorrectedReflectance_TrueColor/default/{date}/"
    "GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg"
)

# Which zooms, and why more than one.
#
# The first version sampled z8 near each location centre. That was the wrong
# question: at 85-degree pitch the camera reports zoom ~10, `gibs` is capped at
# maxzoom 9, and the tiles filling the HORIZON resolve as low as z4 — so a day
# could score 13% here and render a white window, because the z8 tile over
# Denver was dark (lum 66) while the z6 tiles a few hundred km west, which fill
# most of the frame, were 145-157.
#
# The correction overshot: sampling z6 alone rates only the widest tiles. Logged
# what the kiosk actually requests over a full orbit and the spread is wide, with
# the count concentrated at the high end:
#
#   denver     z4:2  z5:4  z6:5  z7:8  z8:11 z9:10
#   hyderabad        z5:3  z6:7  z7:14 z8:18 z9:31
#   ocean                        z7:1  z8:16 z9:14
#
# So sweep z6-z9 and weight each level by roughly how many tiles it contributes.
# Neither "near the centre at one zoom" nor "widest zoom only" describes the
# window; this does.
ZOOM_WEIGHTS = {6: 1, 7: 2, 8: 3, 9: 3}
# +/-3 tiles, not +/-1, because a swath gap is narrow and off-centre.
# 2026-06-19 passed an 11/11 sweep at +/-1 and still rendered a BLACK WEDGE over
# the Pacific: six z9 tiles were missing a few hundred km from the pin, which is
# well inside what the window draws. A coverage gate that only looks next to the
# centre is not a gate.
WINDOW = 3
# Mean luminance above which a tile reads as cloud rather than ground.
# Calibrated against tiles inspected by eye: clear Denver land sits near 66,
# the cloud band west of it 145-157, solid overcast above 200.
WASHED_OUT = 140
# Transient failures get this many attempts before being called an error.
RETRIES = 3


def lonlat_to_tile(lat: float, lon: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180) / 360 * n)
    lat_rad = math.radians(lat)
    y = int((1 - math.log(math.tan(lat_rad) + 1 / math.cos(lat_rad)) / math.pi) / 2 * n)
    return x, y


def fetch_luminance(job) -> tuple[str, str, float | None]:
    """Returns (location, status, mean luminance). status is ok | missing | error.

    A 404 (genuinely no tile) and a timeout are NOT the same answer, and
    collapsing them fabricates coverage gaps: two runs over 2026-07-01 minutes
    apart scored it 11/11 and then 10/11, because one request happened to time
    out and was counted as absent imagery. Coverage is the gate this tool
    exists to enforce, so a flaky network must not be able to reject a date.

    Transient failures are retried, then reported separately as `error` so a
    run with real network trouble says so rather than quietly blaming the day.
    """
    name, date, z, y, x, _weight = job
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(URL.format(date=date, z=z, y=y, x=x), timeout=30) as r:
                image = Image.open(io.BytesIO(r.read())).convert("RGB")
            pixels = list(image.getdata())
            return name, "ok", sum(sum(p) / 3 for p in pixels) / len(pixels)
        except urllib.error.HTTPError as e:
            # 404 is the archive saying "no tile here" — authoritative, no retry.
            if e.code == 404:
                return name, "missing", None
            # 5xx and rate limits are transport, not absence.
            if attempt == RETRIES - 1:
                return name, "error", None
        except Exception:
            if attempt == RETRIES - 1:
                return name, "error", None
        time.sleep(1 + attempt)
    return name, "error", None


def survey(date: str) -> None:
    jobs = []
    for name, lat, lon in LOCATIONS:
        for zoom, weight in ZOOM_WEIGHTS.items():
            x, y = lonlat_to_tile(lat, lon, zoom)
            for dx in range(-WINDOW, WINDOW + 1):
                for dy in range(-WINDOW, WINDOW + 1):
                    jobs.append((name, date, zoom, y + dy, x + dx, weight))

    with cf.ThreadPoolExecutor(16) as pool:
        results = list(pool.map(fetch_luminance, jobs))

    gaps: dict[str, int] = {}
    errors = 0
    # (luminance, weight) — a z9 tile counts for more than a z6 one because the
    # window requests roughly three times as many of them.
    scored: list[tuple[float, int]] = []
    for (name, _d, _z, _y, _x, weight), (_n, status, lum) in zip(jobs, results):
        if status == "missing":
            gaps[name] = gaps.get(name, 0) + 1
        elif status == "error":
            errors += 1
        else:
            scored.append((lum, weight))

    if not scored:
        print(f"{date}  no data at all")
        return

    total = sum(w for _, w in scored)
    washed = 100 * sum(w for lum, w in scored if lum > WASHED_OUT) / total
    mean = sum(lum * w for lum, w in scored) / total
    covered = len(LOCATIONS) - len(gaps)
    verdict = "REJECT (coverage)" if gaps else "eligible"
    detail = ", ".join(f"{k}:{v} missing" for k, v in sorted(gaps.items())) or "none"
    print(
        f"{date}  {covered}/{len(LOCATIONS)} covered  "
        f"washed={washed:5.1f}%  mean={mean:6.1f}  "
        f"{verdict}  gaps=[{detail}]"
    )
    if errors:
        # Loud, because an unreliable run must not be read as a verdict on the
        # day: these are tiles that neither loaded nor 404'd after RETRIES.
        print(f"          !! {errors} tile(s) failed on transport — rerun before trusting this")


if __name__ == "__main__":
    dates = sys.argv[1:]
    if not dates:
        sys.exit(__doc__.strip().split("Usage")[1].strip())
    zooms = ",".join(f"z{z}x{w}" for z, w in ZOOM_WEIGHTS.items())
    print(f"{zooms} (weighted), +/-{WINDOW} tiles around each of {len(LOCATIONS)} locations")
    print("coverage is a GATE; clarity is the tiebreak\n")
    for d in dates:
        survey(d)
