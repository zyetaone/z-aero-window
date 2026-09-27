#!/usr/bin/env python3
"""
build-terrain — quantized-mesh terrain for the offline pack, from open data.

Replaces the Cesium ion terrain the packager used to fetch (a hosted, tokened,
online service the fielded device may not call). Per city: download the
1-degree SRTM-format tiles from the AWS Open Data `elevation-tiles-prod`
bucket (Mapzen / public domain), stitch them into one VRT, and run
cesium-terrain-builder (ctb-tile, in its docker image) to emit
`{z}/{x}/{y}.terrain` quantized-mesh tiles. Then write one `layer.json`
covering every city, which CesiumTerrainProvider reads from
`<TILE_SERVER_URL>/cesium-terrain/layer.json`.

    python3 tools/build-terrain.py --out ../data/tiles/cesium-terrain hyderabad denver
    python3 tools/build-terrain.py --out ../data/tiles/cesium-terrain --all

Needs: docker (image tumgis/ctb-quantized-mesh), gdalbuildvrt, curl.
Output tiles are gzipped on disk; the tile route sends Content-Encoding for
them. Re-running is incremental (ctb --resume, curl skips present files).

ponytail: cities are listed here, not read from content/locations/catalog.ts —
that file is TypeScript and this runs on a laptop with no bun guaranteed. Keep
the two in step when a location is added.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

CITIES: dict[str, tuple[float, float]] = {
    "dubai": (25.2048, 55.2708),
    "mumbai": (19.076, 72.8777),
    "hyderabad": (17.4435, 78.3772),
    "dallas": (32.7767, -96.797),
    "phoenix": (33.4352, -112.0101),
    "las_vegas": (36.1699, -115.1398),
    "denver": (39.8561, -104.6737),
    "chicago_midway": (41.7868, -87.7522),
}
RADIUS_KM = 80.0
MAX_ZOOM = 12  # ~38 m/px at the equator in the geodetic scheme; SRTM is 30 m
SKADI = "https://s3.amazonaws.com/elevation-tiles-prod/skadi"
IMAGE = "tumgis/ctb-quantized-mesh"


def hgt_tiles(lat: float, lon: float) -> list[str]:
    dlat = RADIUS_KM / 111.0
    dlon = RADIUS_KM / (111.0 * math.cos(math.radians(lat)))
    names = []
    for la in range(math.floor(lat - dlat), math.floor(lat + dlat) + 1):
        for lo in range(math.floor(lon - dlon), math.floor(lon + dlon) + 1):
            ns = "N" if la >= 0 else "S"
            ew = "E" if lo >= 0 else "W"
            names.append(f"{ns}{abs(la):02d}{ew}{abs(lo):03d}")
    return names


def fetch(name: str, dem_dir: Path) -> Path:
    out = dem_dir / f"{name}.hgt"
    if out.exists() and out.stat().st_size > 0:
        return out
    url = f"{SKADI}/{name[:3]}/{name}.hgt.gz"
    gz = out.with_suffix(".hgt.gz")
    subprocess.run(["curl", "-sfL", "--retry", "3", "-o", str(gz), url], check=True)
    with gzip.open(gz, "rb") as src, open(out, "wb") as dst:
        shutil.copyfileobj(src, dst)
    gz.unlink()
    return out


def build_city(city: str, out_dir: Path, work: Path) -> None:
    lat, lon = CITIES[city]
    dem_dir = work / city
    dem_dir.mkdir(parents=True, exist_ok=True)
    files = [fetch(n, dem_dir) for n in hgt_tiles(lat, lon)]
    vrt = dem_dir / f"{city}.vrt"
    subprocess.run(
        ["gdalbuildvrt", "-q", "-srcnodata", "-32768", "-vrtnodata", "-32768", str(vrt), *map(str, files)],
        check=True,
    )
    # ctb reads the VRT and its .hgt siblings through the same mount.
    subprocess.run(
        [
            "docker", "run", "--rm",
            "-v", f"{work}:/work",
            "-v", f"{out_dir}:/out",
            IMAGE, "ctb-tile",
            "-f", "Mesh", "-C", "-N", "-R", "-q",
            "-s", str(MAX_ZOOM), "-e", "0",
            "-o", "/out",
            f"/work/{city}/{city}.vrt",
        ],
        check=True,
    )
    print(f"{city}: {len(files)} DEM tiles → mesh", file=sys.stderr)


def write_layer_json(out_dir: Path) -> None:
    """
    `available` per zoom: one rectangle per contiguous y-run in each x column.
    Cesium uses it to skip requests for tiles that do not exist, which is most
    of the planet — eight cities at z12 are ~20k tiles out of 33 million.
    """
    available: list[list[dict[str, int]]] = []
    for z in range(MAX_ZOOM + 1):
        zdir = out_dir / str(z)
        rects: list[dict[str, int]] = []
        if zdir.is_dir():
            for xdir in sorted(zdir.iterdir(), key=lambda p: int(p.name)):
                ys = sorted(int(p.stem) for p in xdir.glob("*.terrain"))
                x = int(xdir.name)
                start = prev = None
                for y in ys:
                    if start is None:
                        start = prev = y
                    elif y == prev + 1:
                        prev = y
                    else:
                        rects.append({"startX": x, "startY": start, "endX": x, "endY": prev})
                        start = prev = y
                if start is not None:
                    rects.append({"startX": x, "startY": start, "endX": x, "endY": prev})
        available.append(rects)
    layer = {
        "tilejson": "2.1.0",
        "name": "aero-window terrain (Mapzen / AWS Open Data, via ctb)",
        "description": "Quantized-mesh terrain for the packed locations; ellipsoid elsewhere.",
        "version": "1.0.0",
        "format": "quantized-mesh-1.0",
        "attribution": "Elevation: Mapzen / AWS Open Data",
        "scheme": "tms",
        "tiles": ["{z}/{x}/{y}.terrain"],
        "projection": "EPSG:4326",
        "bounds": [-180, -90, 180, 90],
        "minzoom": 0,
        "maxzoom": MAX_ZOOM,
        "extensions": ["octvertexnormals"],
        "available": available,
    }
    (out_dir / "layer.json").write_text(json.dumps(layer, separators=(",", ":")))
    n = sum(len(r) for r in available)
    print(f"layer.json: {n} availability rects over z0-{MAX_ZOOM}", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cities", nargs="*")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out", required=True, help="cesium-terrain output directory")
    ap.add_argument("--work", default=os.environ.get("TERRAIN_WORK", "/tmp/aero-terrain-dem"))
    a = ap.parse_args()
    cities = list(CITIES) if a.all else a.cities
    unknown = [c for c in cities if c not in CITIES]
    if unknown or not cities:
        ap.error(f"unknown or missing city: {unknown or 'none given'} (known: {', '.join(CITIES)})")
    out_dir = Path(a.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    work = Path(a.work).resolve()
    for c in cities:
        build_city(c, out_dir, work)
    write_layer_json(out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
