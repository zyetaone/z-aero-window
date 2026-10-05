#!/usr/bin/env python3
"""
Fetch real building footprints for one location, from OpenStreetMap via Overpass.

    python3 tools/fetch-buildings.py hyderabad
    python3 tools/fetch-buildings.py denver --max-features 1200

Why this tool exists
--------------------
`data/buildings/*.geojson` is drawn as fill extrusions and is the entire
subject of the downtown pass in `src/lib/display/flight/downtown.ts` — a ~2 x 3
km loop closed on the `Location` pin, because the pin is the only place the
flight code knows about. The pass has no idea where the buildings are.

Measured 2026-09-27, and the two ways that goes wrong:

  hyderabad   the pin is 10.9 km from a 6.4 km pack, so it is OUTSIDE it
              entirely. The pack is also SYNTHETIC: 564 of its 600 features are
              closed 5-point rectangles and every one is `height: 8`. That is a
              grid of identical boxes, not a city. The thread circles bare
              ground there and there is nothing under it even if it did not.

  denver      the right place — the pack covers its pin to 0.4 km, and Denver's
              catalogue pin is 39.8561, -104.6737, which is the airport the
              kiosk deliberately flies over, not a downtown coordinate. But it
              holds 190 footprints against 600 in every other pack, so its pass
              is thin.

Nothing about either is visible from the app: the endpoint answers 200, the
extrusions mount, `probe-layers.mjs` paints, and the failure reads as "the pass
does not do much". That is invariant 10 pointed at geometry instead of
datasets — `data/roads/` was the same story once, 46 MB of served, tested,
undrawn geometry.

WHY THE SELF-CHECK AT THE BOTTOM IS THE POINT

Every other pack in this repo is written by a tool that trusts its input. This
one verifies its own OUTPUT before it is allowed to replace what is on disk:
the pack must CONTAIN the pin it is named for, and it must hold enough
footprints to read as a city. A pack that fails either is written to a `.rej`
file and the tool exits non-zero.

That is deliberate. The defect above was found by a test written after the
fact, having survived several rounds of review, and it would have been caught at
the moment it was created by four lines at the end of the fetcher that already
know where the pin is. Containment is the right test rather than a centroid
distance, because the roads packs are metro-wide with centres up to 15.3 km
from a pin that is comfortably inside — a distance check would fail all eight
and mean nothing.

WHY THE PIN HERE IS A COPY, NOT AN IMPORT

`fetch-sentinel2.py` carries its own `PLACES` table for the same reason: these
tools run on a build machine with GDAL and network, not inside the app, and
`src/lib/locations.ts` is TypeScript. `tests/pack-coverage.test.ts` is what
keeps the two honest — it reads the real catalogue and fails if this table
drifts from it. A copy with a test that checks the copy is cheaper than making
a Python tool import Svelte.

Height
------
OSM `height` in metres where present, else `building:levels` x 3.2 m, else a
per-type default. Buildings with no height at all are dropped rather than
guessed: a 40 m box in a row of 8 m houses is worse than a hole, and the night
glow is ramped off height by `stamp-building-glow.mjs`, so a wrong height is
wrong twice.

Output
------
`data/buildings/{place}.geojson` and `data/buildings/source-{place}.json`.
The manifest records the pin, radius, Overpass endpoint and a content hash, so
a pack's provenance is answerable without re-running anything — the roads and
buildings packs both arrived without one, which is why the offsets had to be
re-measured by hand.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# Must match src/lib/locations.ts. tests/pack-coverage.test.ts fails if it drifts.
PLACES = {
    "hyderabad": (17.4435, 78.3772),
    "denver": (39.8561, -104.6737),
    "dubai": (25.2048, 55.2708),
    "mumbai": (19.076, 72.8777),
    "dallas": (32.7767, -96.797),
    "phoenix": (33.4352, -112.0101),
    "las_vegas": (36.1699, -115.1398),
    "chicago_midway": (41.7868, -87.7522),
}

# ~5 km of box, which is what the downtown loop is sized against
# (DOWNTOWN_LOOP_SCALE 0.08 on a 25-40 km orbit).
DEFAULT_RADIUS_M = 2600

# Every other pack in data/buildings/ holds exactly this many.
DEFAULT_MAX_FEATURES = 600

# Below this the pass is a flyover of a car park. Denver is the known one.
MIN_FEATURES = 300

# FAILOVER LIST, ordered, and every entry measured rather than assumed. A build
# that can reach exactly one mirror is a build that stops whenever that mirror
# rate-limits — which overpass-api.de does routinely, and did recently with a
# 406 that had nothing to do with this query.
#
#   overpass-api.de            200 in ~1-3 s   — primary
#   maps.mail.ru/osm/tools     200 in ~15 s
#   overpass.kumi.systems      200 in ~58 s    — community mirror
#
# Deliberately NOT in this list, each for a reason that was measured:
#
#   overpass.private.coffee    504 after 79 s. Flaky enough to be a coin flip;
#                              a third endpoint that fails half the time adds
#                              latency without adding availability.
#   overpass.osm.jp            TLS CERTIFICATE VERIFY FAILED. A mirror whose
#                              certificate does not validate is worse than no
#                              mirror: urllib refuses it, and a less careful
#                              client would happily send the query to whoever
#                              holds that cert.
#   overpass.osm.ch            Switzerland-only. It answers 200 with ZERO
#                              elements for every other country. That is the
#                              dangerous failure of the three — it looks like
#                              success, and what arrives is an empty pack that
#                              the self-check then has to refuse. A silent wrong
#                              answer is the reason a failover list needs each
#                              entry checked against a non-home query.
ENDPOINTS: tuple[str, ...] = (
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
)

# Metres per storey, for buildings that give levels but no height. 3.2 is the
# figure OSM's own building:levels consumers use for mixed residential.
M_PER_LEVEL = 3.2

# Fallbacks by building type, for footprints with no height and no levels.
# Deliberately modest: these are the values OSM's own defaults assume, and a
# guessed tower is more wrong than a guessed bungalow.
TYPE_DEFAULT_M = {
    "house": 7,
    "residential": 11,
    "apartments": 14,
    "commercial": 16,
    "retail": 9,
    "office": 26,
    "industrial": 12,
    "warehouse": 11,
    "garage": 3,
    "shed": 3,
    "carport": 3,
    "hut": 2.5,
    "church": 14,
    "school": 11,
    "hospital": 22,
    "hotel": 24,
    "parking": 8,
}
TYPE_DEFAULT_M["default"] = 8


def parse_height(tags: dict) -> tuple[float | None, str]:
    """(metres, provenance) or (None, reason) when the building cannot be sized."""
    raw = tags.get("height")
    if raw:
        try:
            # OSM writes "12", "12 m", "12.5", and occasionally "40'" or a range.
            m = float(str(raw).split(";")[0].strip().rstrip("m").strip().rstrip("'"))
            if math.isfinite(m) and m > 0:
                return m, "height"
        except ValueError:
            pass

    levels = tags.get("building:levels")
    if levels:
        try:
            n = float(str(levels).split(";")[0].strip())
            if math.isfinite(n) and n > 0:
                return n * M_PER_LEVEL, "levels"
        except ValueError:
            pass

    btype = tags.get("building", "")
    if btype in TYPE_DEFAULT_M:
        return TYPE_DEFAULT_M[btype], f"type:{btype}"
    if btype:
        return TYPE_DEFAULT_M["default"], "type:default"
    return None, "unsized"


def overpass_query(lat: float, lon: float, radius_m: int) -> str:
    # `around:` takes METRES. This once divided by 1000 first, so a 2,600 m
    # request asked for a 2.6 m circle and every fetch came back empty.
    return f"""
[out:json][timeout:{max(60, radius_m // 40)}];
(
  way["building"](around:{radius_m},{lat:.6f},{lon:.6f});
  relation["building"](around:{radius_m},{lat:.6f},{lon:.6f});
);
out geom tags qt;
""".strip()


def fetch_overpass(query: str, endpoints: tuple[str, ...], attempts: int = 3) -> tuple[dict, str]:
    """POST the query across a failover list, retrying with a real backoff.

    Returns (payload, endpoint) — the endpoint that ACTUALLY served, not the
    one asked for first. The manifest records it as provenance, and a manifest
    that names a mirror which 504'd is a lie about where the city came from.

    Overpass rate-limits by IP and returns 429 as a plain text body, so the
    status has to be read before the body is parsed as JSON.

    STRUCTURE: rounds × endpoints, exactly as aero-1's `fetchRoadGroupFeatures`
    has always done it. Within a round every endpoint is tried once, in order;
    only when the round is exhausted does the backoff sleep. That ordering is
    what makes failover cheap — a dead primary costs one request, not one
    timeout, because the sleep is not paid until every endpoint has declined.

    FAILURE POLICY, deliberately not uniform — this is the second code path,
    and it exists because not every failure deserves a retry:

      400 / 413 / 422  raise immediately. The REQUEST is wrong — a malformed
                       query or an oversized body — and every mirror would
                       reject the same one, so cycling only buys two backoff
                       sleeps before the author sees the real message.
      everything else  (429 rate limit, any other 4xx, 5xx, TLS failure,
                       timeout, malformed JSON) moves to the next endpoint,
                       because a different mirror may well answer.

    The distinction is between "nobody can answer this" and "this mirror
    cannot answer this", and only the second is what failover is for.
    """
    delay = 5.0
    last: Exception | None = None
    for attempt in range(1, attempts + 1):
        for endpoint in endpoints:
            try:
                req = urllib.request.Request(
                    endpoint,
                    data=query.encode("utf-8"),
                    headers={
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent": "aero-2-tile-packager/1.0 (offline kiosk imagery)",
                    },
                )
                with urllib.request.urlopen(req, timeout=180) as resp:
                    return json.loads(resp.read().decode("utf-8")), endpoint
            except urllib.error.HTTPError as exc:
                last = exc
                body = exc.read().decode("utf-8", "replace")
                # 400 / 413 / 422 mean the REQUEST is wrong — malformed query or
                # oversized body. No mirror can fix those, so cycling through
                # the list would only delay the real message behind two backoff
                # sleeps. Raise immediately and let the author read it. Anything
                # else (429 rate limit, 5xx, a mirror being down) is exactly
                # what failover is for.
                fatal = exc.code in (400, 413, 422)
                print(
                    f"  overpass {endpoint}: HTTP {exc.code} {body[:80]}"
                    + ("" if fatal else " — trying next endpoint"),
                    file=sys.stderr,
                )
                if fatal:
                    raise
                continue
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
                last = exc
                print(f"  overpass {endpoint}: {exc} — trying next endpoint", file=sys.stderr)
                continue
        # Whole round failed. Sleep, then start over from the primary, because
        # by now every mirror has been asked once and the likeliest reason is
        # rate limiting, which clears with time rather than with a better mirror.
        if attempt < attempts:
            print(f"  all endpoints failed, round {attempt}/{attempts}, waiting {delay:.0f}s", file=sys.stderr)
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(
        f"overpass failed after {attempts} rounds across {len(endpoints)} endpoints: {last}"
    )


def rings_of(element: dict) -> list[list[list[float]]]:
    """Outer ring(s) of a way or relation, as closed [lng, lat] lists.

    Relations carry `members` with per-member `geometry`; their outer rings are
    the members whose role is outer or empty. Interior rings are dropped — a fill
    extrusion does not render a courtyard, and a ring that punches a hole needs
    the even-odd rule to survive the GeoJSON reader.
    """
    if element.get("type") == "way":
        geom = element.get("geometry")
        if not geom or len(geom) < 4:
            return []
        return [[(float(p["lon"]), float(p["lat"])) for p in geom]]

    rings: list[list[tuple[float, float]]] = []
    for member in element.get("members") or []:
        if member.get("role") not in ("outer", ""):
            continue
        geom = member.get("geometry")
        if not geom or len(geom) < 4:
            continue
        ring = [(float(p["lon"]), float(p["lat"])) for p in geom]
        # A relation's member ways are often open; close each one.
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        rings.append(ring)
    return rings


def centroid_of(ring: list[tuple[float, float]]) -> tuple[float, float]:
    """Planar centroid, adequate for a building footprint."""
    lat = sum(p[1] for p in ring[:-1]) / (len(ring) - 1)
    lng = sum(p[0] for p in ring[:-1]) / (len(ring) - 1)
    return lng, lat


def m_between(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    dy = (lat1 - lat2) * 111_320.0
    dx = (lon1 - lon2) * 111_320.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot(dx, dy)


def build(lat: float, lon: float, radius_m: int, max_features: int, endpoints: tuple[str, ...]) -> dict:
    # `endpoint` is whatever actually served, not whatever was asked for first —
    # it is written into the manifest as provenance below.
    raw, endpoint = fetch_overpass(overpass_query(lat, lon, radius_m), endpoints)
    elements = raw.get("elements") or []
    print(f"  overpass returned {len(elements)} elements", file=sys.stderr)

    candidates: list[tuple[float, float, dict, str]] = []
    unsized = 0
    for el in elements:
        rings = rings_of(el)
        if not rings:
            continue
        height, provenance = parse_height(el.get("tags") or {})
        if height is None:
            unsized += 1
            continue
        for ring in rings:
            c_lng, c_lat = centroid_of(ring)
            candidates.append((height, m_between(c_lat, c_lng, lat, lon), {
                "type": "Feature",
                "properties": {"height": round(height, 1)},
                "geometry": {"type": "Polygon", "coordinates": [[list(r) for r in ring]]},
            }, provenance))
    if unsized:
        print(f"  dropped {unsized} elements with no usable height", file=sys.stderr)

    # Deterministic selection: TALLEST first, then nearest the pin. A skyline
    # is what reads from 2 km up — a random 600 of 40,000 would be a field of
    # bungalows with three towers in it. Distance breaks ties so the result does
    # not depend on Overpass's element order.
    candidates.sort(key=lambda c: (-c[0], c[1], c[2]["geometry"]["coordinates"][0][0][0]))
    kept = candidates[:max_features]

    features = [c[2] for c in kept]
    sources: dict[str, int] = {}
    for c in kept:
        sources[c[3]] = sources.get(c[3], 0) + 1

    return {
        "type": "FeatureCollection",
        "features": features,
        "_meta": {
            "place_pin": {"lat": lat, "lon": lon},
            "radiusM": radius_m,
            "maxFeatures": max_features,
            "available": len(candidates),
            "kept": len(features),
            "unsizedDropped": unsized,
            "heightSources": sources,
            "endpoint": endpoint,
            "odLicence": "© OpenStreetMap contributors, ODbL 1.0",
        },
    }


def write_pack(fc: dict, lat: float, lon: float, radius_m: int, out_dir: Path, place: str) -> None:
    """Write the pack and its manifest, after the self-check."""
    pack_dir = out_dir / "data" / "buildings"
    pack_dir.mkdir(parents=True, exist_ok=True)
    pack_path = pack_dir / f"{place}.geojson"

    features = fc["features"]
    # ── THE SELF-CHECK ────────────────────────────────────────────────────────
    # Containment, not distance. A distance check fails all eight cities, because
    # the roads packs are metro-wide with centres up to 15.3 km from pins that
    # are inside. What the renderer needs is that the PIN is in the drawn box.
    # The PACK's box, not any one footprint's: this once asked whether the pin
    # sat inside a single building, which a pin on a road never does.
    lats = [p[1] for f in features for p in f["geometry"]["coordinates"][0]]
    lngs = [p[0] for f in features for p in f["geometry"]["coordinates"][0]]
    inside = bool(features) and min(lats) <= lat <= max(lats) and min(lngs) <= lon <= max(lngs)
    problems: list[str] = []
    if not features:
        problems.append("no features at all")
    else:
        if not inside:
            problems.append(
                f"pack does not contain its own pin {lat:.4f},{lon:.4f} "
                f"(box lat {min(lats):.4f}..{max(lats):.4f}, lon {min(lngs):.4f}..{max(lngs):.4f})"
            )
        if len(features) < MIN_FEATURES:
            problems.append(f"only {len(features)} footprints, want >= {MIN_FEATURES}")

    if problems:
        rej = pack_dir / f"{place}.rej.json"
        rej.write_text(json.dumps({"place": place, "problems": problems, "meta": fc["_meta"]}, indent=2))
        print(f"REFUSING to write {pack_path}:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(f"  candidate written to {rej}", file=sys.stderr)
        raise SystemExit(2)

    meta = fc["_meta"]
    body = {"type": "FeatureCollection", "features": features}
    text = json.dumps(body, separators=(",", ":"))
    pack_path.write_text(text)

    manifest = {
        "place": place,
        "lat": lat,
        "lon": lon,
        "radiusM": radius_m,
        "maxFeatures": meta["maxFeatures"],
        "featureCount": len(features),
        "heightSources": meta["heightSources"],
        "licence": meta["odLicence"],
        "source": "OpenStreetMap via Overpass API",
        "endpoint": meta["endpoint"],
        "note": (
            "'height' only. The per-building 'night' colour is stamped afterwards by "
            "tools/stamp-building-glow.mjs, which reads this height and the pack centroid."
        ),
        "contentSha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
    }
    (pack_dir / f"source-{place}.json").write_text(json.dumps(manifest, indent=2) + "\n")
    rej = pack_dir / f"{place}.rej.json"
    if rej.exists():
        rej.unlink()

    print(f"  wrote {pack_path} ({len(features)} features, {len(text) / 1024:.0f} KB)", file=sys.stderr)
    print(f"  sha256 {manifest['contentSha256'][:16]}", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("place", help="a name from PLACES, or any label when --lat/--lon are given")
    ap.add_argument("--lat", type=float)
    ap.add_argument("--lon", type=float)
    ap.add_argument("--radius", type=int, default=DEFAULT_RADIUS_M,
                    help=f"metres around the pin (default {DEFAULT_RADIUS_M}, ~5 km box)")
    ap.add_argument("--max-features", type=int, default=DEFAULT_MAX_FEATURES,
                    help=f"cap on footprints, tallest kept (default {DEFAULT_MAX_FEATURES})")
    # `action="append"` so a caller can pin the list — one --endpoint reproduces
    # the old single-endpoint RETRIES (same backoff budget), and two lets a test
    # prove failover. Omitted entirely means ENDPOINTS, the measured list.
    # "Reproduces" is the word, not "exactly": the retry classification also
    # changed (allowlist -> the 400/413/422 denylist), so a lone --endpoint that
    # answers 406 now retries-and-sleeps where the old tool raised immediately.
    ap.add_argument(
        "--endpoint",
        action="append",
        default=None,
        metavar="URL",
        help="override the failover list; repeat to give more than one "
             f"(default: {len(ENDPOINTS)} measured mirrors)",
    )
    ap.add_argument("--out", default=".", help="repo root holding data/buildings")
    args = ap.parse_args()

    # --endpoint is a developer convenience, and right now only the tests use it
    # — but "convenience" is the kind of thing that later gets wired into a CI
    # script, and a flag that accepts `file:///etc/passwd` or `http://169.254.…`
    # would quietly turn a build tool into a local-file reader the moment it
    # does. The default list is hardcoded https; the override must stay within
    # http(s) too, or the flag is an SSRF trap waiting for a caller.
    if args.endpoint is not None:
        for ep in args.endpoint:
            scheme = urllib.parse.urlparse(ep).scheme
            if scheme not in ("http", "https"):
                ap.error(f"--endpoint {ep!r} is not http(s); refusing to fetch from "
                         f"{scheme or 'an unparsable'} scheme")

    if args.lat is not None and args.lon is not None:
        lat, lon, label = args.lat, args.lon, args.place
    elif args.place in PLACES:
        lat, lon = PLACES[args.place]
        label = args.place
    else:
        print(f"unknown place {args.place!r}; pass --lat/--lon, or one of: {', '.join(sorted(PLACES))}",
              file=sys.stderr)
        raise SystemExit(2)

    print(f"{label}: {lat:.4f},{lon:.4f} r={args.radius}m cap={args.max_features}", file=sys.stderr)
    endpoints: tuple[str, ...] = tuple(args.endpoint) if args.endpoint else ENDPOINTS
    print(f"  endpoints: {' -> '.join(endpoints)}", file=sys.stderr)
    fc = build(lat, lon, args.radius, args.max_features, endpoints)
    write_pack(fc, lat, lon, args.radius, Path(args.out), label)


if __name__ == "__main__":
    main()
