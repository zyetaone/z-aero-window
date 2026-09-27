# ADR-001: Offline Tile Architecture for Pi 5 Fleet Deployment

> **Path note (2026-09-27):** this ADR predates the `aero-1/` · `aero-2/` split. Bare `src/…`, `content/…`, `tools/…` and `scripts/…` paths below are relative to what is now `aero-1/`; paths that no longer exist anywhere are marked *(removed)* inline. The decision text itself is unchanged.

> Implementation note: this ADR captures the intended standalone tile architecture. The current `main` branch only retains the script-based helpers in `scripts/prefetch-tiles.ts` and `scripts/build-pmtiles.ts`; the standalone packager workspace described below is not part of the current tree, and historical names like `tile-packager/` or `aero-tiles.service` are preserved here for context only.

## Context

Aero Dynamic Window runs on Pi 5 kiosks in offline/intermittent-network environments.
The current tile pipeline depends on live internet access to four remote services:

| Layer | Current Source | Protocol | Max Zoom | Purpose |
|-------|---------------|----------|----------|---------|
| Base imagery | ESRI World Imagery | REST/WMTS | 19 | Daytime satellite terrain |
| Terrain mesh | Cesium Ion World Terrain | REST | 15 | 3D elevation, water masks |
| Night lights | NASA VIIRS CityLights 2012 | WMTS | 8 | Night city glow overlay |
| Road glow | CartoDB Dark (no labels) | XYZ tiles | 18 | OSM road outlines at night |
| Buildings | Google 3D Tiles (optional) | 3D Tiles | N/A | Photorealistic buildings |

The service worker (`sw.js`) implements cache-first for tiles, but:
1. First boot requires internet to populate the cache
2. Cache API storage is browser-managed and can be evicted
3. No control over which tiles get pre-cached
4. 18 locations x multiple zoom levels = potentially millions of tiles
5. No mechanism to distribute tile packages across the fleet

The fleet server (`@zyeta/server`) can push scene changes to displays, but has
no tile distribution capability.

### Constraints

- **Pi 5 specs**: 8GB RAM, 64GB-128GB microSD (or NVMe via HAT), VideoCore VII GPU
- **Network**: Displays may be on corporate WiFi, air-gapped, or intermittent
- **18 locations**: 14 urban (hasBuildings:true), 4 nature/scenic
- **Altitude range**: 10,000-65,000 ft (zoom levels ~5-14 for imagery)
- **CesiumJS bundle**: ~5MB JS, plus ~30MB static assets (Workers, Assets, ThirdParty)
- **Current visual quality**: Excellent (ESRI 0.5m/px, Ion terrain with water masks)
- **24/7 operation**: Must survive power cycles, SD card corruption

---

## Current Tile Consumption Analysis

Before evaluating paths, we need to understand actual tile consumption:

```
Per location, orbit mode:
  Imagery (ESRI):     zoom 8-14 within ~0.3 degree radius
  Terrain (Ion):      zoom 8-12 within same radius
  VIIRS:              zoom 3-8 (global, low-res)
  CartoDB:            zoom 10-16 within same radius (night only)

Tile count estimation per location (256px tiles):
  z8:   ~4 tiles       z12: ~256 tiles
  z9:   ~16 tiles      z13: ~1024 tiles
  z10:  ~64 tiles      z14: ~4096 tiles
  z11:  ~128 tiles

Per location, z8-14 imagery:  ~5,600 tiles x ~20KB avg = ~112 MB
Per location, z8-12 terrain:  ~470 meshes x ~30KB avg = ~14 MB
Per location, z3-8 VIIRS:     ~340 tiles x ~15KB avg = ~5 MB (shared global)
Per location, z10-16 CartoDB: ~5,400 tiles x ~8KB avg = ~43 MB

TOTAL per location: ~174 MB
TOTAL 18 locations: ~3.1 GB
VIIRS global (shared): ~340 tiles = ~5 MB (tiny, cached once)
```

This is well within Pi 5 storage capacity.

---

## Path Evaluation

### Path 1: CesiumJS + Open Data Pipeline

**Concept**: Replace all paid/terms-restricted services with open-source equivalents.
Keep CesiumJS as the renderer.

```
Data Sources:
  Imagery:  Sentinel-2 Cloudless (EOX, 10m, CC-BY 4.0)
            OR MapTiler Satellite (free tier: 100k tiles/mo)
  Terrain:  Copernicus DEM 30m (ESA, free) → cesium-terrain-builder → quantized-mesh
  Nights:   NASA VIIRS (public domain, keep as-is)
  Roads:    OSM data → tilemaker → vector tiles → Martin tile server
            OR pre-render to raster with Mapnik/Tessera
  Buildings: OSM buildings from Overture Maps → 3D Tiles via py3dtiles
```

| Criterion | Assessment |
|-----------|-----------|
| **Visual quality** | WORSE. Sentinel-2 is 10m/px vs ESRI 0.5m/px. At 10-15k ft night altitude, individual buildings and streets become mushy. Copernicus 30m terrain lacks the fine detail of Ion (which uses 1-3m LIDAR in urban areas). Water masks absent. |
| **Cost** | $0 recurring, $0 one-time (all CC-BY or public domain) |
| **Implementation** | 3-4 weeks. cesium-terrain-builder is unmaintained C++ (last commit 2019). OSM building extrusion to 3D Tiles is fragile pipeline work. Vector tile rendering on Pi requires Martin + style config. |
| **Pi 5 resources** | Martin (Rust tile server): ~30MB RAM. Pre-rendered rasters: 0 runtime cost. Storage: ~3GB for 18 locations. |
| **Offline reliability** | EXCELLENT. All data is local. Zero network dependency. |
| **3D buildings** | POSSIBLE but crude. OSM building footprints exist for major US cities. Extrusion heights are often missing. Result looks like Minecraft vs Google 3D Tiles. |
| **MRAX alignment** | Good separation (data pipeline = Actions, tile schemas = Model) but high complexity for marginal visual result. |

**Verdict**: The visual quality regression is unacceptable for a product meant to evoke
"looking out an airplane window." Sentinel-2 at 10m makes cities look like impressionist
paintings. The terrain loss (no water masks, no LIDAR detail) kills the ocean animation
and mountain detail that make Himalayas/Pacific compelling.

---

### Path 2: CesiumJS + Cesium Ion Clips

**Concept**: Use Cesium Ion's Asset Depot / Clipping Region feature to download
bounded terrain + imagery tiles for each location, then serve locally.

```
Workflow:
  1. Create Ion account with commercial license
  2. For each of 18 locations, create a "clip" bounding box (~50km radius)
  3. Export as 3D Tiles / quantized-mesh packages
  4. Package into fleet deployment image
  5. Serve from Pi filesystem or minimal HTTP server
```

| Criterion | Assessment |
|-----------|-----------|
| **Visual quality** | IDENTICAL to current. Same ESRI imagery, same Ion terrain, same water masks. |
| **Cost** | Ion Commercial: $800/mo (includes 500k tiles/mo API, 50GB storage, clips feature). One-time clip generation for 18 locations. Ongoing cost even though we only use clips. Alternative: Ion Self-Hosted ($$$$ enterprise pricing, likely $5k+/yr). |
| **Implementation** | 1-2 weeks. Ion clips are a supported feature. Main work is automating the clip-per-location pipeline and integrating local serving. |
| **Pi 5 resources** | Storage: ~3-4GB. No tile server needed if using Cesium's offline capabilities with file:// or local HTTP. |
| **Offline reliability** | EXCELLENT once clips are generated. |
| **3D buildings** | YES, Ion OSM Buildings can be clipped. BUT the existing CESIUM_primitive_outline bug (noted in CesiumViewer.svelte line 419) still applies. |
| **MRAX alignment** | Clean. Clips are static artifacts (Model). Pipeline is automated (Actions). |

**Verdict**: Best visual quality with minimal effort, but the $800/mo recurring cost is
steep for what amounts to static data generation. The clips feature also requires manual
or scripted interaction with the Ion dashboard API. The real question is whether we can
generate the clips ONCE and cancel the subscription.

**Note**: Ion ToS may restrict offline redistribution. This needs legal review.

---

### Path 3: MapLibre GL JS

**Concept**: Replace CesiumJS entirely with MapLibre GL JS (open-source fork of Mapbox GL).
Uses vector tiles, has 3D terrain, much lighter runtime.

```
Stack:
  MapLibre GL JS v5 (~400KB gzipped)
  PMTiles (single-file tile archives, fully offline)
  Martin tile server OR direct PMTiles reading
  OpenFreeMap / Protomaps for base tiles
  Terrain: Mapzen Terrain Tiles (AWS open data) in PMTiles format
```

| Criterion | Assessment |
|-----------|-----------|
| **Visual quality** | DIFFERENT. MapLibre renders vector tiles with custom styling, not satellite imagery. Can do satellite via raster layers, but without Cesium's globe/atmosphere/post-processing, the result is a flat map with terrain exaggeration, not a planet. No skybox, no atmosphere scattering, no sun/moon, no ocean normals, no Cesium bloom. |
| **Cost** | $0. Everything open source + open data. |
| **Implementation** | 4-6 weeks. COMPLETE REWRITE of CesiumViewer.svelte, all post-processing shaders, the entire night lighting pipeline, fog system, and atmosphere rendering. The color grading shader (cesium-shaders.ts) and cloud post-process (cloud-post-process.ts) are Cesium PostProcessStage — MapLibre has no equivalent compositing pipeline. Would need custom WebGL passes or Three.js hybrid. |
| **Pi 5 resources** | MUCH lighter. MapLibre: ~40MB RAM vs Cesium: ~200-400MB RAM. PMTiles: ~2GB for global z0-14 raster. Vector tiles: ~80GB for planet (but per-location extracts: ~200MB total). |
| **Offline reliability** | EXCELLENT. PMTiles are single files, no tile server needed (HTTP range requests or local file API). |
| **3D buildings** | YES, native in MapLibre via fill-extrusion layers with OSM building data. Better integration than Cesium's 3D Tiles approach. |
| **MRAX alignment** | Deletable (replaces one renderer with another), but the scope of change is massive. |

**Verdict**: MapLibre is technically superior for offline operation and resource efficiency,
but the visual identity of Aero Window IS Cesium. The globe rendering, atmospheric
scattering, sun/moon positioning, ocean waves, and the custom GLSL post-processing pipeline
(color grading + clouds) are what make it look like a real airplane window view. Rewriting
all of this in MapLibre would take 4-6 weeks and produce a fundamentally different product.
This is a non-starter for the current product identity.

---

### Path 4: Hybrid — CesiumJS + Local Data Pipeline (RECOMMENDED)

**Concept**: Keep CesiumJS for its irreplaceable rendering capabilities. Build a data
pipeline that pre-fetches tiles from the best available free/cheap sources and packages
them for offline Pi deployment. Accept a small visual quality trade-off on imagery
while preserving terrain quality through self-hosted terrain.

```
Architecture:

  BUILD TIME (Fleet Server / CI)          RUNTIME (Pi 5 Kiosk)
  ================================       ================================

  tile-packager CLI                       Bun file server (port 8888)
   ├── fetch ESRI tiles*                   ├── /imagery/{z}/{x}/{y}.jpg
   │   (z8-14, 18 locations)               ├── /terrain/{z}/{x}/{y}.terrain
   ├── fetch Bing Maps tiles               ├── /viirs/{z}/{x}/{y}.jpg
   │   (alternative, better cache terms)   ├── /roads/{z}/{x}/{y}.png
   ├── generate terrain from               └── /buildings/{tileset.json}
   │   Copernicus DEM 30m
   │   via ctb-tile (quantized-mesh)       CesiumJS (browser)
   ├── fetch NASA VIIRS (z3-8)              ├── UrlTemplateImageryProvider
   ├── pre-render CartoDB dark tiles        │   → http://localhost:8888/imagery/...
   │   via headless Mapnik OR               ├── CesiumTerrainProvider
   │   fetch from CartoDB CDN*              │   → http://localhost:8888/terrain/...
   └── package as location tarballs         ├── VIIRS provider → localhost
       location-dubai.tar.gz                ├── Road provider → localhost
       location-himalayas.tar.gz            └── Post-processing (unchanged)
       ...
                                           Service Worker
  * = subject to terms of service;          └── cache-first with local fallback
    see "Imagery Strategy" below
```

#### The Key Insight: Tiered Imagery Strategy

Not all tiles need the same quality. The application operates at specific altitudes:

```
Altitude    Effective Zoom    Tile Detail Needed
65,000 ft   z8-9              Country-level (any source is fine)
45,000 ft   z9-10             Regional (Sentinel-2 10m is OK)
35,000 ft   z10-11            Metro area (Sentinel-2 marginal)
28,000 ft   z11-12            City detail (need 2-5m imagery)
15,000 ft   z13-14            Street-level (need <2m imagery)
10,000 ft   z14+              Individual buildings (need <1m)
```

The application's NIGHT altitude (where imagery matters least because it's dark)
uses z11-13. DAY altitude uses z11-14 where detail matters.

**Solution: Sentinel-2 for z8-11, Bing Maps for z12-14.**

Bing Maps has a free tier (125k transactions/yr for non-profit/personal, or
negotiate bulk license for commercial). More importantly, Bing Maps tiles can be
cached by Cesium's built-in `BingMapsImageryProvider` with `mapStyle: AERIAL`.

For the 18 locations at z12-14 only: 18 x 5,120 tiles = ~92,160 tiles.
At one-time download cost, this is well within Bing's free tier.

**Alternatively**: Stay with ESRI. ArcGIS Online's terms allow caching for
"operational use." A Pi kiosk running pre-cached ESRI tiles in a corporate setting
likely qualifies. ESRI's free tier (1M basemap tiles/mo for non-commercial)
would cover initial download. For commercial: ArcGIS Developer subscription
at $100/yr gets 2M basemap tiles/mo.

#### Terrain Strategy

**Option A: Cesium Ion terrain (keep current, cache aggressively)**

The existing SW already caches Ion terrain tiles. The gap is pre-warming.
Add a "terrain pre-warm" phase to provisioning that flies the camera through
all 18 locations at multiple altitudes, forcing all needed terrain tiles into
the SW cache. Then persist the cache.

- Pro: Zero visual quality loss, minimal code change
- Con: Requires Ion token (free tier: 500k asset requests/mo, enough for 18 locations)
- Con: Browser cache can be evicted

**Option B: Self-hosted Copernicus DEM terrain**

Generate quantized-mesh tiles from Copernicus GLO-30 DEM (30m resolution, ESA, free):
```bash
# Pipeline:
# 1. Download GeoTIFF for each location bbox
gdal_translate -projwin $BBOX copernicus_glo30.tif location.tif

# 2. Generate quantized-mesh tiles
# Using cesium-terrain-builder (or newer: quantized-mesh-encoder)
ctb-tile -f Mesh -C -N -o /tiles/terrain location.tif

# 3. Package for Pi
tar -czf terrain-dubai.tar.gz /tiles/terrain/
```

- Pro: Fully offline, no token needed, no cache eviction risk
- Con: 30m resolution vs Ion's 1-3m LIDAR in urban areas
- Con: No water masks (ocean animation degrades)
- Con: cesium-terrain-builder is abandonware (last release 2019)

**Option C: Hybrid terrain (RECOMMENDED)**

Use Ion terrain during the build phase to generate high-quality cached tiles,
then serve from local filesystem. The key insight: `CesiumTerrainProvider` can
point to a local URL serving `layer.json` + quantized-mesh tiles.

```typescript
// Current (live Ion):
v.terrainProvider = await C.createWorldTerrainAsync({
  requestVertexNormals: true,
  requestWaterMask: true,
});

// Offline (local server):
v.terrainProvider = await C.CesiumTerrainProvider.fromUrl(
  'http://localhost:8888/terrain', {
    requestVertexNormals: true,
    requestWaterMask: true,
  }
);
```

To capture Ion terrain for offline:
1. Use `cesium-terrain-server` (Go, reads quantized-mesh from disk)
2. OR use a recording proxy that captures Ion responses during a build-time crawl
3. Package the captured tiles per-location

This preserves Ion quality (LIDAR, water masks) without runtime dependency.

---

## Recommended Architecture: Path 4 (Hybrid)

### System Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │            BUILD PIPELINE (CI/CD)           │
                    │                                             │
                    │  tile-packager/                             │
                    │  ├── src/                                   │
                    │  │   ├── types.ts       (Model)             │
                    │  │   ├── rules.ts       (bbox calc, zoom    │
                    │  │   │                   ranges, validation)│
                    │  │   ├── actions/                           │
                    │  │   │   ├── fetch-imagery.ts               │
                    │  │   │   ├── fetch-terrain.ts               │
                    │  │   │   ├── fetch-viirs.ts                 │
                    │  │   │   ├── fetch-roads.ts                 │
                    │  │   │   └── package.ts                     │
                    │  │   └── index.ts       (CLI entry)         │
                    │  └── package.json                           │
                    │                                             │
                    │  Input: locations.ts (18 locations)          │
                    │  Output: tile-packages/                     │
                    │          ├── imagery/   (XYZ raster tiles)  │
                    │          ├── terrain/   (quantized-mesh)    │
                    │          ├── viirs/     (XYZ raster tiles)  │
                    │          ├── roads/     (XYZ raster tiles)  │
                    │          └── manifest.json                  │
                    └──────────────────┬──────────────────────────┘
                                       │
                            SD card / NVMe / rsync
                                       │
                    ┌──────────────────▼──────────────────────────┐
                    │              PI 5 KIOSK                     │
                    │                                             │
                    │  ┌──────────────────────────────┐           │
                    │  │  Bun Tile Server (port 8888) │           │
                    │  │  /opt/zyeta-aero/tiles/      │           │
                    │  │  ├── imagery/{z}/{x}/{y}.jpg │           │
                    │  │  ├── terrain/ (layer.json +  │           │
                    │  │  │   quantized-mesh tiles)   │           │
                    │  │  ├── viirs/{z}/{x}/{y}.jpg   │           │
                    │  │  └── roads/{z}/{x}/{y}.png   │           │
                    │  └──────────┬───────────────────┘           │
                    │             │ http://localhost:8888          │
                    │  ┌──────────▼───────────────────┐           │
                    │  │  Chromium (CesiumJS)          │           │
                    │  │  ├── UrlTemplateImageryProv.  │           │
                    │  │  │   → localhost:8888/imagery  │          │
                    │  │  ├── CesiumTerrainProvider    │           │
                    │  │  │   → localhost:8888/terrain  │          │
                    │  │  ├── VIIRS provider           │           │
                    │  │  │   → localhost:8888/viirs    │          │
                    │  │  ├── CartoDB/road provider    │           │
                    │  │  │   → localhost:8888/roads    │          │
                    │  │  ├── Cloud post-process GLSL  │           │
                    │  │  ├── Color grading GLSL       │           │
                    │  │  └── SW (cache layer, optional)│          │
                    │  └──────────────────────────────┘           │
                    │                                             │
                    │  ┌──────────────────────────────┐           │
                    │  │  Fleet WS Client              │           │
                    │  │  → connects to fleet server   │           │
                    │  │  → receives scene commands    │           │
                    │  │  → reports status             │           │
                    │  └──────────────────────────────┘           │
                    └─────────────────────────────────────────────┘
```

### MRAX Structure for tile-packager

```
packages/tile-packager/
├── src/
│   ├── types.ts              # TileCoord, BBox, TilePackage, LocationTileSpec
│   ├── rules.ts              # bbox-from-location, zoom-range-for-altitude,
│   │                         #   tile-coords-in-bbox, storage-estimate
│   ├── actions/
│   │   ├── fetch-imagery.ts  # Download ESRI/Bing tiles for a bbox+zoom range
│   │   ├── fetch-terrain.ts  # Download Ion terrain OR generate from Copernicus
│   │   ├── fetch-viirs.ts    # Download NASA VIIRS tiles (global, one-time)
│   │   ├── fetch-roads.ts    # Download CartoDB dark tiles for a bbox
│   │   ├── package.ts        # Tar/compress per-location bundles
│   │   └── validate.ts       # Verify tile completeness, checksum
│   ├── index.ts              # CLI entry point
│   └── tile-server.ts        # Minimal Bun HTTP server for Pi deployment
├── package.json
└── README.md
```

### CesiumViewer Changes

The CesiumViewer.svelte changes are minimal — swap remote URLs for local ones:

```typescript
// NEW: detect offline mode (tile server running on localhost)
const OFFLINE_TILE_SERVER = 'http://localhost:8888';

async function setupImageryLayers(v, C, signal) {
  // Try local tile server first, fall back to remote
  const useLocal = await checkTileServer(OFFLINE_TILE_SERVER);

  if (useLocal) {
    // Local imagery
    const localImagery = new C.UrlTemplateImageryProvider({
      url: `${OFFLINE_TILE_SERVER}/imagery/{z}/{x}/{y}.jpg`,
      maximumLevel: 14,
      minimumLevel: 8,
    });
    v.imageryLayers.addImageryProvider(localImagery);

    // Local terrain
    v.terrainProvider = await C.CesiumTerrainProvider.fromUrl(
      `${OFFLINE_TILE_SERVER}/terrain`, {
        requestVertexNormals: true,
        requestWaterMask: true,
      }
    );
  } else {
    // Current remote providers (ESRI + Ion)
    // ... existing code unchanged ...
  }

  // VIIRS: try local, fall back to NASA
  try {
    const viirs = useLocal
      ? new C.UrlTemplateImageryProvider({
          url: `${OFFLINE_TILE_SERVER}/viirs/{z}/{x}/{y}.jpg`,
          maximumLevel: 8,
        })
      : new C.WebMapTileServiceImageryProvider({ /* existing NASA config */ });
    nightLayer = v.imageryLayers.addImageryProvider(viirs);
    // ... existing alpha/brightness config ...
  } catch (e) { /* ... */ }

  // Roads: try local, fall back to CartoDB
  try {
    const roads = useLocal
      ? new C.UrlTemplateImageryProvider({
          url: `${OFFLINE_TILE_SERVER}/roads/{z}/{x}/{y}.png`,
          maximumLevel: 16,
        })
      : new C.UrlTemplateImageryProvider({
          url: 'https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png',
          /* existing config */
        });
    roadLightLayer = v.imageryLayers.addImageryProvider(roads);
    // ... existing alpha/colorToAlpha config ...
  } catch (e) { /* ... */ }
}

async function checkTileServer(url) {
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
    return resp.ok;
  } catch { return false; }
}
```

### Bun Tile Server (runs on Pi)

```typescript
// packages/tile-server/src/index.ts
// Minimal static file server optimized for tile serving

const TILE_DIR = process.env.TILE_DIR || '/opt/zyeta-aero/tiles';
const PORT = parseInt(process.env.TILE_PORT || '8888', 10);

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', tiles: TILE_DIR });
    }

    // Map URL path to filesystem
    // /imagery/12/2145/1523.jpg → TILE_DIR/imagery/12/2145/1523.jpg
    const filePath = `${TILE_DIR}${url.pathname}`;
    const file = Bun.file(filePath);

    if (await file.exists()) {
      return new Response(file, {
        headers: {
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
});
```

### Fleet Integration

The fleet server gains a new capability: tile package distribution.

```
Protocol additions (protocol.ts):

ServerMessage additions:
  | { type: 'tile_update'; locationId: LocationId; version: string; url: string }

DisplayMessage additions:
  | { type: 'tile_status'; cached: LocationId[]; diskUsage: number }
```

When a new location is added or tiles are updated, the fleet server can push
a `tile_update` message to displays. The display's tile management module
downloads the new package from the fleet server.

### Provisioning Changes

```bash
# Addition to deploy/provision-pi.sh (removed — provisioning is now deploy/pi/install.sh):

# ─── 5b. Install Tile Server ────────────────────────────────────────────────

echo "[5b/7] Installing tile server..."

# Install Bun (for tile server)
curl -fsSL https://bun.sh/install | bash

# Create tile server service
cat > /etc/systemd/system/aero-tiles.service <<EOF
[Unit]
Description=Zyeta Aero Tile Server
After=local-fs.target

[Service]
Type=simple
User=kiosk
Environment=TILE_DIR=/opt/zyeta-aero/tiles
Environment=TILE_PORT=8888
ExecStart=/home/kiosk/.bun/bin/bun run /opt/zyeta-aero/tile-server/index.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# Pre-seed tiles (if tile package exists on SD card)
if [ -d "/boot/firmware/aero-tiles" ]; then
    echo "  Pre-seeding tiles from SD card..."
    cp -r /boot/firmware/aero-tiles/* /opt/zyeta-aero/tiles/
fi
```

---

## Storage Budget

```
Pi 5 with 128GB SD Card:
  OS + packages:          ~4 GB
  CesiumJS static:       ~30 MB
  SvelteKit app:          ~5 MB
  Tile packages:
    Imagery (18 loc):    ~2.0 GB  (ESRI z8-14)
    Terrain (18 loc):    ~0.25 GB (Ion quantized-mesh z8-12)
    VIIRS (global):      ~0.01 GB (z3-8)
    Roads (18 loc):      ~0.77 GB (CartoDB z10-16)
    ─────────────────────────────
    Total tiles:         ~3.0 GB
  Bun runtime:           ~80 MB
  Log space:             ~1 GB
  ═══════════════════════════════
  TOTAL:                 ~8.4 GB
  FREE:                  ~120 GB  (room for 30+ more locations)
```

With 64GB SD: still ~55GB free. Not a concern.

RAM budget:
```
  Chromium + CesiumJS:   ~400 MB (WebGL context, tile cache)
  Bun tile server:        ~30 MB
  X server:               ~50 MB
  OS + services:         ~200 MB
  ═══════════════════════
  TOTAL:                 ~680 MB of 8 GB
  FREE:                  ~7.3 GB (comfortable)
```

---

## Implementation Plan

### Phase 1: Tile Packager CLI (Week 1)

Build the `packages/tile-packager` workspace package.

Tasks:
1. Define types: `TileCoord`, `BBox`, `LocationTileSpec`, `TileManifest`
2. Implement rules: bbox calculation from location + radius, tile coordinate enumeration
3. Implement fetch-imagery: download ESRI tiles with rate limiting + retry
4. Implement fetch-viirs: download NASA VIIRS global tiles
5. Implement fetch-roads: download CartoDB dark tiles
6. Implement package: create directory structure with manifest.json
7. CLI interface: `bun run tile-packager --locations dubai,dallas --output ./tiles`

### Phase 2: Local Tile Server (Week 1, parallel)

Build `packages/tile-server` as a minimal Bun file server.

Tasks:
1. Static file serving with CORS headers
2. Health endpoint
3. Manifest endpoint (what locations are cached, disk usage)
4. systemd service file

### Phase 3: CesiumViewer Offline Mode (Week 2)

Modify `CesiumViewer.svelte` to support local tile providers.

Tasks:
1. Add `checkTileServer()` probe
2. Create local provider factories (imagery, terrain, viirs, roads)
3. Graceful fallback: local -> remote -> error
4. Wire up through the existing `setupImageryLayers` flow
5. Test: run tile server locally, verify rendering matches remote

### Phase 4: Terrain Pipeline (Week 2-3)

The hardest piece — getting terrain with water masks offline.

**Approach A (Recommended for v1): Recording proxy**
1. Build a Bun proxy that intercepts Ion terrain requests
2. Run CesiumJS in a headless browser, fly through all 18 locations
3. Proxy records all terrain tiles to disk in quantized-mesh format
4. Package the recorded tiles with `layer.json` metadata

**Approach B (v2): Self-generated terrain**
1. Download Copernicus DEM GeoTIFFs for each location
2. Use `ctb-tile` or `quantized-mesh-encoder` to generate tiles
3. Accept 30m vs 1-3m quality loss
4. No water masks (Cesium falls back to WGS84 ellipsoid water detection)

### Phase 5: Fleet Integration (Week 3)

Extend `@zyeta/server` and `ws-client.ts` for tile distribution.

Tasks:
1. Add tile-related protocol messages
2. Fleet server serves tile packages over HTTP
3. Display reports tile status (cached locations, disk usage)
4. Admin can trigger tile sync for specific displays

### Phase 6: Provisioning (Week 3)

Update `deploy/provision-pi.sh` *(removed — provisioning is now `deploy/pi/install.sh`)*.

Tasks:
1. Add Bun installation
2. Add tile server systemd service
3. Add SD card pre-seeding logic
4. Document the "golden image" creation process

---

## Mixing Paths: The Recommended Blend

The optimal solution cherry-picks from multiple paths:

| Component | Source | Path | Cost |
|-----------|--------|------|------|
| **CesiumJS renderer** | Keep current | 4 | $0 |
| **Day imagery** | ESRI (cached) | 4 | $0-100/yr |
| **Terrain** | Ion (cached via proxy) | 2+4 | Free tier |
| **Night lights** | NASA VIIRS (public domain) | 1 | $0 |
| **Road glow** | CartoDB (cached) | 4 | $0 |
| **Buildings** | Skip for v1 | N/A | $0 |
| **Clouds** | Existing GLSL shader | N/A | $0 |
| **Color grading** | Existing GLSL shader | N/A | $0 |
| **Tile serving** | Bun file server on Pi | 4 | $0 |
| **Tile packaging** | Custom CLI tool | 4 | $0 |

**Total cost: $0-100/yr** (ArcGIS Developer subscription if deploying commercially)

---

## Decision

**Path 4 (Hybrid) with the recording proxy approach for terrain.**

### Why

1. **Visual quality**: Zero regression. Same ESRI imagery, same Ion terrain geometry
   and water masks, same NASA VIIRS, same CartoDB roads. The only change is WHERE
   the tiles are served from (localhost vs internet).

2. **Cost**: Effectively $0 for the product's use case. ESRI free tier covers the
   one-time download. Ion free tier covers the one-time terrain crawl. NASA is
   public domain. CartoDB is free for reasonable usage.

3. **Implementation**: ~3 weeks, incremental. Each phase is independently valuable.
   Phase 1-3 alone give us offline imagery+roads+viirs (biggest win). Phase 4 adds
   terrain. Phase 5-6 are fleet polish.

4. **Deletability**: The tile-packager is a standalone CLI tool. The tile-server is
   a standalone Bun script. The CesiumViewer changes are a provider swap behind a
   feature flag. Any piece can be deleted without affecting the others.

5. **Scalability**: Adding a new location = run the packager for that location, rsync
   to Pi. No code changes needed.

## Options

| Option | Pros | Cons | Deletable? |
|--------|------|------|------------|
| Path 1: All open data | $0, fully open | 10m imagery unacceptable, 30m terrain loses water masks, unmaintained tools | Yes |
| Path 2: Ion Clips | Identical quality, supported | $800/mo recurring, ToS risk for redistribution | Yes |
| Path 3: MapLibre | Lightest runtime, best offline | Complete visual rewrite, loses globe/atmosphere/post-processing | No (too entangled) |
| **Path 4: Hybrid** | **Same quality, ~$0, incremental, each piece deletable** | **Recording proxy is novel/untested, 3 week effort** | **Yes** |

## Status

Proposed

## Open Questions

1. **ESRI ToS for kiosk caching**: Need to verify that pre-caching ESRI tiles for
   offline kiosk use is permitted under their free/developer tier terms. If not,
   Bing Maps Aerial is the fallback (Microsoft's terms are more permissive for
   caching). Either way, the tile-packager architecture is provider-agnostic.

2. **Ion terrain proxy legality**: Recording Ion terrain responses for offline use
   may violate Ion ToS. Alternative: use Copernicus DEM for v1 and accept 30m
   resolution, then negotiate an enterprise Ion license for v2 if terrain quality
   matters enough.

3. **CartoDB rate limits**: CartoDB dark tiles are served from a CDN. Downloading
   ~97K tiles per location batch should be spread over time. The packager should
   implement rate limiting (max 50 req/s) and resume-on-failure.

4. **3D Buildings**: Deferred to v2. The current CESIUM_primitive_outline bug makes
   Ion OSM Buildings degrade imagery quality anyway. When this is resolved upstream,
   buildings can be added to the tile pipeline as 3D Tiles packages.
