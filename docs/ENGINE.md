# AeroWindow Engine Architecture

## Architecture at a glance

AeroWindow is not a conventional single-page application. It's a **real-time rendering engine** with SvelteKit as the orchestration layer and CesiumJS as the graphics engine. One Viewer instance renders continuously at 30-60 FPS. Svelte manages application lifecycles, state, routing, and persistence — never the render loop.

```
                         AeroWindow
──────────────────────────────────────────────────────
                 SvelteKit Application
──────────────────────────────────────────────────────
Boot • Routing • State • Settings • Persistence
──────────────────────────────────────────────────────
                  AeroWindow Engine
──────────────────────────────────────────────────────
Director • Flight • Motion • Telemetry • Config
──────────────────────────────────────────────────────
                   World Engine
──────────────────────────────────────────────────────
Camera • Clock • Terrain • Imagery • Buildings
Atmosphere • Lighting • Night • Post-Processing
──────────────────────────────────────────────────────
                      GPU
```

## One Viewer Rule

There is exactly one `Cesium.Viewer` instance per application lifetime. It is created once in `CesiumViewer.svelte`, stored in a module-level `$state` singleton (`activeCesium.svelte.ts`), and consumed by everything through typed accessors. No other file ever calls `new Viewer()`.

```
CesiumViewer.svelte
       │
       ▼
  activeCesium.manager
       │
       ▼
  Everything Else (via getCameraRead())
```

This keeps GPU memory predictable and prevents accidental multi-context allocations.

## Engine Responsibilities

### AeroWindow Engine (`model/`, `camera/`, `director/`)

Owns **what happens**. Decides where to fly, what weather to show, how fast to move. Never renders.

| Component | File | Role |
|---|---|---|
| Configuration | `config-tree.svelte.ts` | Flat `$state` tree — SSOT for every tunable parameter |
| Flight | `camera/flight.svelte.ts` | Catmull-Rom waypoints + orbit + cruise state machine |
| Motion | `camera/motion.svelte.ts` | Bank, turbulence, breathing, engine vibration |
| Director | `director/autopilot.svelte.ts` | Weather randomiser + location cycler + flyover beats |
| Telemetry | `model/telemetry.svelte.ts` | Ring-buffer FPS/frame-time/error observability |
| State root | `model/aero-window.svelte.ts` | Reactive DI context — `createAeroWindow()` / `useAeroWindow()` |

### World Engine (`world/`)

Owns **how it looks**. Renders terrain, buildings, atmosphere, night lights, and post-processing. Never decides where to fly.

| Component | File | Role |
|---|---|---|
| Orchestrator | `compose.ts` | `CesiumManager` — constructs single Viewer, delegates to managers, owns render loop |
| Terrain | `terrain-manager.ts` | CesiumTerrainProvider (local cache → Ion → ellipsoid fallback) |
| Imagery | `imagery.ts` | Sentinel-2 base + VIIRS night-lights + CartoDB road mask |
| Buildings | `buildings.ts` | OSM 3D Tiles + procedural lit-window `CustomShader` |
| Atmosphere | `atmosphere-manager.ts` | Globe color, sky, fog, moonlight swap, exposure, HBAO gate |
| Night | `shaders.ts`, `hash-palette.ts` | Color-grade post-process + per-pixel UV-hash palette variant |
| Lightning | `lightning-stage.ts` | Post-process flash on storm weather |
| Clouds | `cloud-billboard-layer.ts` | Cesium-native billboard cloud bank (experimental) |
| Lighting math | `curves.ts`, `sky.ts`, `altitude.ts` | Framework-free day/night response curves shared across engines |
| Setup | `cesium-setup.ts` | Viewer constructor options, Ion token, imagery source config, scene defaults |

## Render layers (bottom → top)

```
Cesium Globe (100% native)
  terrain → imagery → OSM buildings → skyAtmosphere → fog
       │
  Post-Processing (all Cesium postProcessStages)
  FXAA → bloom → HBAO (altitude-gated) → color-grade → ACES tonemap
       │
  Three.js Overlay (Wing + Clouds, transparent canvas above Cesium)
  camera-mirrored → Clouds.svelte + Wing.svelte
       │
  DOM Chrome
  oval frame → glass vignette → blind shade → HUD
```

Everything visual runs through Cesium. The Three.js bridge exists for two things Cesium cannot replicate visually:
the 2-band PNG-sprite cloud cluster system and the SW 737 wing GLB
with camera-anchored 3-Pi panorama positioning. SunGlow, Moon, LensFlare,
NightStars, EffectStack, and the DOM compositor have been deleted in favor
of Cesium-native equivalents.

## Frame update loop

```
$effect → game-loop.subscribe(dt)
       │
       ├── model.tick(dt)           [inside untrack() — no reactive re-subscription]
       │   ├── directorTick()       weather randomiser, location cycling
       │   ├── flight.tick()        orbit advance, cruise FSM, altitude settle
       │   └── motionStep()         bank angle, turbulence, breathing
       │
       └── Cesium postRender event
           ├── syncCamera()         heading, pitch, roll, parallax offset
           ├── syncClockCheck()     timeOfDay → Cesium JulianDate
           ├── atmosphere.sync()    globe color, sky, fog, moonlight, exposure, HBAO
           ├── imagery.sync()       VIIRS alpha, CartoDB roads
           ├── buildings.sync()     OSM tiles show/hide + shader uniforms
           ├── lightning.tick()     flash envelope
           └── terrain.sync()       vertical exaggeration
```

## Configuration flow

```
Slider / API / URL param
       │
       ▼
  applyConfigPatch(path, value)     [single write gate]
       │
       ├── $state mutation           [Svelte reactive]
       ├── CRDT stamp                [fleet multi-writer safety]
       └── peer-sync broadcast       [PATCH /api/config to each Pi]
       │
       ▼
  Engine sync (next tick, inside untrack())
       │
       ├── EpsilonGate check         [skip Cesium setter if value unchanged]
       └── Cesium API call           [viewer.scene.* .globe.* .postProcessStages.*]
```

No hidden writes exist. Every config mutation routes through `applyConfigPatch`.

## Key architectural invariants

1. **Cesium isolation** — only `CesiumViewer.svelte` does runtime `import('cesium')`. All other files reference it as `import type`.
2. **Single Viewer** — one `CesiumManager`, one `Viewer`, stored in `activeCesium.svelte.ts`.
3. **`untrack()` gate** — every tick body wraps work in `untrack()` so config reads don't rebuild the game-loop subscription.
4. **`EpsilonGate` idempotency** — all Cesium setter calls pass through threshold guards to prevent redundant GPU uniform uploads.
5. **Flat config DTOs** — extend additively, never reshape. The config tree is the SSOT; no `constants.ts`.
6. **Simulation ≠ presentation** — `director/` and `camera/` decide *what happens*. `world/` decides *how it looks*. They never import each other.
7. **Content ≠ control** — authored data (locations, weather recipes, night palette, shows) lives in `content/`. Engine code lives in `src/lib/`.

## Directory map

```
src/lib/
  model/         reactive $state tree — config, AeroWindow, CRDT, telemetry, persistence
  world/         Cesium globe engine — compose.ts orchestrator + 10+ leaf managers
  camera/        flight simulation — Catmull-Rom waypoints, orbit, banking, turbulence
  director/      autopilot — weather randomiser, location cycler, flyover beats
  fleet/         multi-Pi fleet protocol — REST, SSE, mDNS, CRDT peer sync
  http/          server middleware — auth, body readers, CORS, route factory
  shell/         cabin chrome — oval frame, glass, blind, HUD, sidepanel, watchdogs (84L GlobeLayer)
  show/          authored boot baseline — Show type + applyShowOpening
  game-loop.ts   RAF subscriber pattern — single tick clock for the entire app

content/
  locations/     location catalog with default altitude, night altitude, hasBuildings
  compositions/  night palette, weather recipes, cloud compositions, lightning compositions
  palettes/      sky palette, car-lights palette
  weather/       weather effect presets (turbulence, lightning, rain density)
  shows/         daily rotation shows — boot baseline per day

tools/
  tile-packager/ offline tile downloader for fielded Pi deployment
  perf/          Pi 5 performance benchmarks and checklists
```


## Performance Notes

- **Two WebGL contexts**: Cesium (opaque globe) + Three.js (transparent canvas).
  Adds ~50-100 MB GPU memory for the second framebuffer. Profiling on Pi 5
  hardware is pending. The `useThreeOverlay` config toggle allows falling back
  to Cesium-only rendering if the Pi cannot maintain framerate.
- **Wing Cesium Model port**: Wing.svelte (475L) uses Three.js GLTFLoader.
  Cesium"s `Model.fromGltfAsync()` could load the same GLB natively, saving
  the second WebGL context. Camera-anchored per-frame positioning would use
  `model.modelMatrix` updates. Deferred — the Three.js bridge is already
  alive for Clouds, so Wing benefits for free.
- **Tile 404s**: Sentinel-2 tile server misses some zoom levels at edges.
  Normal — Cesium degrades gracefully to lower-LOD tiles. A local tile
  cache (tools/tile-packager) eliminates network dependency for fielded Pis.
