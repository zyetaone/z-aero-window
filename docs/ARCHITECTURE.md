# AeroWindow Architecture (canonical)

> **Status (2026-08-15):** Live tree is authoritative. CODEMAPS may lag —
> prefer this file + `AGENTS.md` + `aero-1/src/lib/*` folders.
> Paths in this document are relative to the repo root; the app it describes is `aero-1/`.
>
> **Product:** Zyeta · **Engineered by:** rdtect (`aero-1/src/lib/credits.ts`).  
> Stakeholder view (architecture + terms + credits): **`/wiki`**.
>
> See also: `AGENTS.md` for day-to-day patterns (Cesium isolation, untrack rule).

## Surfaces (kiosk vs admin vs API)

| Surface | Route | State | Renders globe? |
|---------|-------|-------|----------------|
| **Kiosk** | `/` | `createAeroWindow()` context | Yes (Cesium; Three dynamic) |
| **Admin** | `/admin/*` | module `config` + `RestAdminStore` | **No** |
| **API** | `/api/*` | process modules under `server/` | — |
| **Wiki** | `/wiki` | none (`csr=false`) | — |

Admin **never** constructs AeroWindow — it authors `config_patch` / `command` only.

## Display modes (`set_mode`)

Admin **Mode** pushes a fleet `command` (`type: 'set_mode'`). Wire + validation
live in `fleet/display-payload.ts` (not shell).

| Mode | Payload | Kiosk behaviour |
|------|---------|-----------------|
| `flight` | none | Globe (default). Clears media + persist. |
| `video` | URL string (http(s) or `/api/assets/…`) | Full-bleed looped video. |
| `screensaver` | JSON `{ urls: string[], intervalSec? }` | Image slideshow. |

Kiosk apply path: SSE → `AeroWindow.setDisplayMode` (reject bad payload, no-op)
→ `Pane` stacks `MediaStage` over a **parked** `GlobeLayer` (`useDefaultRenderLoop
= false`, tick/liveness off). Return-to-flight is warm (no Cesium remount).

Persist: `fleet/display-mode-persist.ts` (`localStorage` + `savedAt` wall-clock)
so reload keeps media. Fleet `set_mode` carries `decidedAtMs`; decisions older
than `savedAt` are ignored (local Escape not undone by SSE replay).

Exit media: SidePanel **Return to Flight**, **Escape**, or **long-press** (~1.2s)
on the stage (touch / edge panes). Total media failure auto-returns to flight
after ~4s. Admin rewrites relative assets to absolute against its origin;
slideshow size is capped (`MAX_SLIDESHOW_URLS` / ~3.5 KB) under the 4 KB command
body budget. Status reports `fps: 0` while media (globe parked).

## Three clocks (do not collapse)

1. **game-loop RAF** → `model.tick` (flight / motion / director)
2. **Cesium postRender** → `compose` sync* (imperative, EpsilonGate)
3. **Threlte useTask** → CameraMirror / Clouds / Wing

Pose is **pull-model**: engines read plain numbers each frame. Do not
`$effect(() => cesium.setCamera(model.flight.camLat))`.

## Client bundle

Route-**split** client chunks (`svelte.config.js`). Kiosk boot does not
download `/admin` UI. Three overlay is `import()`-lazy from GlobeLayer.
Cesium remains `await import('cesium')` in `CesiumViewer.svelte` only.

---

## Five-layer engine stack

```text
                       AeroWindow
─────────────────────────────────────────────────────
                 SvelteKit Application
─────────────────────────────────────────────────────
+layout.svelte         +page.svelte
Pane                   HUD
Settings               Telemetry
─────────────────────────────────────────────────────
                Svelte 5 Reactive Model
─────────────────────────────────────────────────────
$state        — mutable world state (config, flight, weather, …)
$derived     — computed values (lighting, sun, nightMix, …)
$effect       — synchronisation only (push to Cesium)
─────────────────────────────────────────────────────
                  Cesium Native Engine
─────────────────────────────────────────────────────
Viewer      Scene      Camera     Clock      Globe
Terrain     Imagery    Buildings  Atmosphere
PostProcess  SkyAtmosphere  Fog  Sun  Moon
─────────────────────────────────────────────────────
                 Open Data Sources
─────────────────────────────────────────────────────
Terrain:     Copernicus DEM · Mapzen · SRTM
Imagery:     Sentinel-2 · Blue Marble
Night:       NASA VIIRS Black Marble
Buildings:   OSM Buildings · Google Open Buildings
Weather:     Open-Meteo · METAR · NOAA
─────────────────────────────────────────────────────
                       WebGL
```

## Runtime ownership

```text
SvelteKit
    ↓
AeroWindow              (Svelte 5 orchestration + reactive state)
    ↓
CesiumViewer.svelte      (the ONLY place `new Cesium.Viewer()` is called)
    ↓
Viewer
    ↓
Scene
    ↓
GPU
```

Only one object owns the Viewer. Everything else consumes it.

## Responsibilities

| Concern | Owns | Never |
|---|---|---|
| **Model** | application state | renders |
| **World** | Earth (Cesium primitives) | decides where to fly |
| **Camera** | movement (camera pose) | anything visual |
| **Flight** | behaviour (location, weather, time) | renders |
| **Scene** | decorative effects | touches Cesium globe primitives |
| **Shell** | presentation (DOM chrome: pane, glass, blind, HUD, ops panel) | owns Cesium / decides flight / invents second scene state |

Shell **reads** the model for display (location name, flight mode, readout
stats). It does not *drive* simulation — writes go through
`applyConfigPatch` / typed setters so CRDT + fleet stay coherent.

## Shell: passenger vs operator vs multi-window

North star: **one continuous flight across all panes**. Ambient installs
break when the machine's internal state becomes visible uninvited.

### Surfaces

```text
Passenger glass     globe + glass + blind (+ optional cabin clock)
Cruise only         soft "En route / {place}" whisper (center|solo)
Blind closed        faint wall-clock time + place on the shade
Operator            SidePanel — ALT / GS / LOCAL + controls
Edge panes          pure view (no tab, no open-blind HUD)
```

| Surface | When | Role gate |
|---|---|---|
| BlindInfoCard | blind closed | every pane (furniture on the shade) |
| TelemetryOverlay whisper | blind open + en route | `showsOpenPassengerHud(role, hudVisible)` |
| SidePanel tab | operator invite | `showsOpsChrome(role, opsMode)` |
| ALT / GS / LOCAL | SidePanel header only | same as SidePanel |
| CabinClock | single tap, `shell.clockVisible` | fleet-synced config |

### Role / chrome SSOT

All shell chrome role gates live in **`aero-1/src/lib/fleet/parallax.svelte.ts`**
next to `isGroupLeader`. Do not re-inline `role === 'left' || …` in
components.

| Helper | Meaning |
|---|---|
| `isGroupLeader(role)` | center \| solo — autopilot + director broadcast |
| `isEdgePane(role)` | left \| right — share scene, hide edge UI |
| `showsOpsChrome(role, opsMode)` | SidePanel tab; edge needs `?ops=1` |
| `showsOpenPassengerHud(role, hudVisible)` | open-blind whisper |
| `isOpsModeParam(search)` | parse `?ops=1\|true` |

### Sync rule (fleet)

| Kind | Sync? | Why |
|---|---|---|
| Scene state (location, altitude, weather, time, flight mode, director) | **yes** — CRDT / `director_decision` | one flight |
| Shell config that is cabin furniture (`clockVisible`, `windowFrame`, …) | **yes** when written via `applyConfigPatch` | wall agrees |
| Operator chrome open/closed, SidePanel scroll, Advanced fold | **no** — local | tech tool, not the product |
| Passenger discoverable hints | **local / center-only** | three coaches desync the wall |

### Panel composition

`+page.svelte` owns section order. Essentials first (Location → Weather →
Time → Flight); Atmosphere / Lighting / Lab behind a closed `<details
class="advanced">`. Lab is DEV + `?lab=1` only.

## Data flow

```text
Settings UI
    ↓
$config                    (rune)
    ↓
$derived                    (e.g. lightingState)
    ↓
$effect                      (only Cesium sync)
    ↓
Cesium Scene / PostProcess  (the external system)
    ↓
GPU
```

The Svelte team's recommendation is to **prefer `$derived` for computed
values rather than `$effect`** (Svelte 5 docs). We follow that strictly:
computation lives in `$derived`, `$effect` is reserved for pushing values
into Cesium.

## The Single-Viewer Rule

Exactly **one** Cesium `Viewer` per process. No other file in the
codebase calls `new CesiumModule.Viewer(...)`.

**Why:**
- GPU memory predictability (a second Viewer doubles the budget)
- No shared render context to reason about
- Cesium's tile streaming + post-process pipelines are not designed
  to share state across viewers

**If you think you need a second canvas** (a tiny preview in the admin
panel, for example): that's a signal you should be designing a
*different* pattern — a screenshot pipeline, a Cesium DataSource, or
a custom render-target — not a second Viewer.

The invariant is enforced by convention. The single call site is
`aero-1/src/lib/world/CesiumViewer.svelte` and it's documented in that file's
header comment.

## Reactive feature pattern

```ts
// 1. Mutable state (rune, in $state)
export const config = $state({
	terrain: 'copernicus',
	bloom: true,
	hdr: true,
	weather: 'clear',
	quality: 'balanced',
});

// 2. Computed (rune, in $derived)
export const lighting = $derived(computeLighting(clock.utc));
export const nightMix = $derived(lighting.nightMix);

// 3. Synchronisation (rune, in $effect — only Cesium sync)
$effect(() => {
	viewer.scene.fog.density = lighting.fogDensity;
});

$effect(() => {
	viewer.scene.globe.enableLighting = config.enableLighting;
});
```

Three rules:
- **`$state`** — only actual application state.
- **`$derived`** — every computation; never compute inside `$effect`.
- **`$effect`** — push rune values into Cesium; never compute.

## Manager → feature migration map

| Old | New | Phase |
|---|---|---|
| `world/lightning-stage.ts` | `world/lightning-stage.ts` (module functions) | **1** [shipped] |
| `world/clouds/billboard-layer.ts` | `world/clouds/billboard-layer.ts` (module functions) | **1** [shipped] |
| (color-grade in `compose.ts`) | inline PostProcessStage in `compose.ts` | **1** [shipped] |
| `world/imagery.ts` | `world/imagery.ts` (hybrid) | **2** [shipped] |
| `world/buildings.ts` | `world/buildings.ts` (hybrid) | **2** [shipped] |
| `world/atmosphere-manager.ts` | `world/atmosphere.ts` (hybrid) | **2** [shipped] |
| `world/terrain-manager.ts` | `world/terrain.ts` (hybrid) | **2** [shipped] |
| `world/camera-manager.ts` | `world/camera.ts` (`getCameraRead()` + `syncCamera()`) | **3** [shipped] |
| `world/compose.ts` | (kept, slimmed) | **4** [shipped] |

> Phase 1 shipped: lightning, clouds, color-grade are now reactive
> features. Both `lightning-stage.ts` and `clouds/billboard-layer.ts`
> export module-level `mount*(C, v)` + `tick/update*()` + `destroy*()`
> functions — the legacy imperative classes (`LightningStage`,
> `CloudBillboardLayer`) were deleted. Color-grade lives inline in
> `compose.ts` as a single PostProcessStage.

> **Phase 2 shipped**: imagery, buildings, atmosphere, terrain all
> converted to hybrid (module-level state + `init()` + `setup()` +
> `sync()` functions, no class). Async I/O is correctly modeled —
> `setupImagery()` awaits the Sentinel-2 tile provider, etc. Per-tick
> sync uses `EpsilonGate` for idempotent Cesium setter calls. The
> class shell is gone; the lifecycle is explicit in the function
> signatures.

> **Phase 3 shipped**: `world/camera.ts` exports both
> `getCameraRead()` (typed boundary for CameraMirror / Three side)
> and `syncCamera(slice, resources, scratchDest)` (the per-frame
> camera sync body). `CesiumManager.#syncCamera()` is now a 7-line
> wrapper that builds the slice + resources from `this.#model` and
> delegates. The `#scratchDest` field stays on the orchestrator
> because it belongs to the per-viewer allocation lifetime. 8 tests
> in `aero-1/tests/lib/world/camera.test.ts` pin the math.

> **Phase 4 shipped**: `compose.ts` dropped to ~376 lines (was 670+).
> It sits at **535** today and has been ~520 since mid-August — the
> growth is the post-process concern (`#setupPostProcess` +
> `#syncQuality`, ~135 lines), not leaf work creeping back. See the
> coupling note below before trying to extract it.
> The `#tick` method is 8 lines of imperative dispatch (was 50+). The
> `CesiumManager` class is the orchestrator only — every leaf concern
> (atmosphere, terrain, imagery, buildings, lightning, clouds,
> color-grade, camera sync) lives in its own `.ts` file with
> `init*`/`setup*`/`sync*` exported functions. `CesiumManager` owns:
>   - the `Cesium.Viewer` instance (single viewer invariant)
>   - the post-process stage enumeration (HBAO, bloom, FXAA)
>   - the quality-mode transition (one-shot, fires on change)
>   - the public `applyQualityMode()` + `setBuildingsWireframe()` API
>   - the `#scratchDest` allocation (camera sync work buffer)
>   - the destroy / cleanup contract
> The orchestrator is no longer the source of leaf logic — it
> delegates.


**Hybrid** = class for async setup (Ion token, terrain provider, 3D
Tiles init), `$effect` for per-frame sync. Async I/O does not fit
the `$effect` model cleanly — setup runs once, sync runs reactively.

## Three.js overlay

The overlay (in `aero-1/src/lib/world/three/`) holds **only** what Cesium
genuinely can't do:
- **Wing** — camera-anchored SWA 737 GLB with yaw-stripped
  positioning for 3-Pi panorama continuity
- **Clouds** — PNG-sprite cluster composition at the cloud deck
  (artistic CSS3D-style reads that don't match Cesium's BillboardCollection aesthetic)

Cesium handles everything else natively: stars, sun, moon, bloom,
tonemap, lightning post-process, building OSM tiles, VIIRS night
lights. The Three overlay is not another engine; it's a thin canvas
consumer that mirrors the Cesium camera each frame.

### Why the post-process concern has not been extracted

`#syncQuality` looks like the obvious next Phase-4 extraction — it is the
largest method in the file. It does not extract on its own, and the reason is
worth recording so the attempt is not made twice.

`#syncImagery` and `#syncQuality` **co-own** four fields, bidirectionally:

| Field | Written by | Read / invalidated by |
|---|---|---|
| `#nightFxOn` | `#syncImagery` | `#syncQuality` |
| `#lastQualityMode` | `#syncQuality` | `#syncImagery` |
| `#lastColorGradeEnabled` | `#syncImagery` | `#syncQuality` (invalidates) |
| `#colorGradeStage` | `#setupPostProcess` | both |

They share one Cesium stage and hand a memo-invalidation flag back and forth
so the two grading paths never stack (the double-grade bug). Moving
`#syncQuality` alone converts four private fields into a cross-module mutable
protocol — strictly worse than the class that currently contains them.

The coherent unit, if this is ever done, is the WHOLE post-process concern —
`#setupPostProcess` + `#syncQuality` + the color-grade half of `#syncImagery`
— as one module owning all five fields, following the hybrid pattern with its
own `registerViewerTeardown`. That is a real refactor of tuned night-path
code, so it wants a reason beyond tidiness.

## Non-goals

- **`applyConfigPatch` is not removed.** It's the single write gate for
  the fleet CRDT LWW merge (concurrent-admin-write safety) and the
  prototype-pollution defense (`__proto__`/`constructor`/`prototype`
  rejection). Direct `$state` mutation would break both. The function
  is a deliberate trade-off in favor of safety, not against runes.
- **ECS is not adopted.** The product has one entity (the display).
  There is no second entity to justify the pattern. We use manager-
  per-Cesium-primitive (the MRAX "Actions layer") instead.
- **The Flight Engine stays imperative.** Simulation is time-driven,
  not state-driven. Wrapping flight in `$effect` would produce visible
  jitter across reactive frames; an imperative `tick(dt)` is correct.