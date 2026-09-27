# ADR-003 — Night Pipeline Simplification (Phase 15.5)

> **Path note (2026-09-27):** this ADR predates the `aero-1/` · `aero-2/` split. Bare `src/…`, `content/…`, `tools/…` and `scripts/…` paths below are relative to what is now `aero-1/`; paths that no longer exist anywhere are marked *(removed)* inline. The decision text itself is unchanged.

> Status: Accepted. Phase 1+2+1.5a+1.5b+1.5c+7 landed 2026-05-21.
> Phases 3-6 (productionize variant E + variant F + altitude-gate VIIRS) queued
> for post-validation when Pi 5 hardware confirms there's frame budget.

## Context

The night rendering pipeline as it stood on 2026-05-20 had grown to:

```
Day:     base imagery (saturated 1.4)
         + sky atmosphere + globe lighting

Night:   base imagery (brightness lerped 1.0 → 0.15, sat 1.4 → 0.05)
         + CartoDB Dark overlay (alpha lerped 0 → 0.8, bright 1.0 → 1.6,
           contrast 1.0 → 1.6)
         + VIIRS Black Marble (alpha smoothstep 0 → 0.5, hue/sat/bright
           tinting, terminator-aware dayAlpha=0/nightAlpha=1)
         + Cesium globe lighting (terminator)
         + Cesium skyAtmosphere (warm horizon glow)
         + Cesium built-in bloom (contrast 128 / brightness -0.3 / sigma 2.2)
         + COLOR_GRADING_GLSL custom shader:
             brightGuard | pollution corona | shadow crush | contrast boost

DOM:     haze | clouds | rain/lightning | micro-events | frost | wing |
         glass-vignette (z:9) | vignette (z:10) | glass-recess (z:11) | hud
```

Three imagery layers, two post-process passes, eleven DOM compositor
layers. Seven admin-tunable night params. ~180MB of tile cache. The user
characterized this as "overengineered."

A 4-lens council (game-design, game-dev, exp-design, exp-dev) reviewed
four candidate pipelines:

- **P1** Drop CartoDB + VIIRS. F (vector OSM roads) + E (altitude-aware
  buildings emissive) + base-darken shader carry ALL the night-light load.
- **P2** Drop CartoDB. Keep VIIRS gated to altitude > 5km as ambient
  luminance hint. F + E for low altitude.
- **P3** Keep all 3 imagery layers + add F + E on top.
- **P4** Status quo + add E only.

## Decision

**Three of four lenses voted P2.** The dissent (Experience Developer) was
on TIMING — "refactoring load-bearing pipeline 7 days from GO/NO-GO is
reckless" — not on architectural direction.

Adopted: **migrate to P2 in phases, prioritising subtractive cuts that
require no new infrastructure first.**

### Phases LANDED (commits 51f4290, 75ce250, a8b3fe5)

| Phase | What | Status |
|---|---|---|
| **1** | Add shader-driven base darkening in `COLOR_GRADING_GLSL`. `mix(rgb, vec3(0.02,0.04,0.08), smoothstep(0.45,0.9,nf) × 0.85 × (1-brightGuard))`. Preserves the "blue hour" beat via the same 0.45 → 0.9 smoothstep curve the CartoDB layer used. | ✅ Landed |
| **2** | Drop the CartoDB Dark imagery layer entirely. Remove `nightLayer` field, ~80 LOC of CartoDB setup + sync, the `CARTODB_DARK_URL` constant, the `NIGHT_MAP_SMOOTHSTEP_FLOOR/CEIL` exports. | ✅ Landed |
| **1.5a** | Drop redundant base-imagery brightness lerp. The shader's mix() to navy already darkens; the imagery-layer lerp was double-darkening. Saturation lerp stays (different job: green hue cast prevention). Drop `baseNightBrightness` config field. | ✅ Landed |
| **1.5b** | Drop shader shadow-crush + contrast operations. ~90% redundant with Cesium's HDR tonemap + bloom. Shader 5 ops → 3 ops. | ✅ Landed |
| **1.5c** | Collapse 3 glass DOM layers (z:9 + z:10 + z:11) into one element with stacked background gradients + inset box-shadow. Reactive rim opacity preserved via `@property` registered CSS custom property for transition support. | ✅ Landed |
| **7** | Drop the 3 truly orphan night config fields (`nightAlpha`, `nightBrightness`, `nightContrast`) that were CartoDB-only knobs. World namespace 16 fields → 13. | ✅ Landed |

### Phases QUEUED (commit pending, post-hardware-validation)

| Phase | What | Why deferred |
|---|---|---|
| **3** | Productionize variant E (altitude-aware buildings emissive in `compose.ts`). Cesium3DTileColorBlendMode.HIGHLIGHT with amber tint × `(1 - altitudeBlend)`. Buildings glow at low altitude, fade above 25k ft. | Adds runtime code. Best landed AFTER Pi 5 confirms there's frame budget. |
| **4** | New server route `/api/roads/:city` mirroring `/api/buildings/:city`. Tile-packager step: per-location Overpass fetch for highway types, GeoJSON output to `TILE_DIR/roads/:city.geojson`. | Build-time infrastructure. Adds before it subtracts. Wait for hardware validation. |
| **5** | Productionize variant F (vector OSM roads as a new geo effect or directly in `compose.ts`). Load from `/api/roads/:city` at boot. Cesium GeoJsonDataSource + `PolylineGlowMaterialProperty` styled by highway class. Coords lifted to 1500m altitude (PolylineGlow incompatible with `clampToGround=true`). Altitude-fade: full at 10-20k ft, dim at 30k+ ft. | Depends on Phase 4 infrastructure. |
| **6** | Altitude-gate VIIRS — multiply alpha by `smoothstep((altitude - 5000) / 10000)`. At cruise altitude VIIRS stays full; at low altitude VIIRS fades so vector roads (Phase 5) own the city-light load without competing. | Small. Lands with Phase 5. |

## Cumulative state after landed phases

```
Day:     base imagery (saturated 1.4)
         + sky atmosphere + globe lighting

Night:   base imagery (sat 1.4 → 0.05 lerp; brightness stays at 1.0)
         + VIIRS Black Marble (unchanged: smoothstep 0.55→0.9, cap 0.5)
         + Cesium globe lighting
         + Cesium skyAtmosphere
         + Cesium built-in bloom
         + COLOR_GRADING_GLSL: brightGuard | base mix to navy | pollution corona

DOM:     haze | clouds | rain/lightning | micro-events | frost | wing |
         glass (single element, multi-gradient) | hud
```

- **3 imagery layers → 2** (one fewer texture sample per fragment at night)
- **5 shader ops → 3** (one fewer pow() call per pixel)
- **11 DOM compositor layers → 9** (-2 DOM elements per frame)
- **7 admin night sliders → 4** (orphan params dropped)
- **CartoDB tile cache will reclaim ~180MB** (pending tile-packager source-list update in a follow-up)

## Preserved invariants

- **"Blue hour" beat** — sky darkens 30+ minutes before VIIRS city lights ignite. The 0.45 → 0.9 smoothstep ramp survives, now inline in `COLOR_GRADING_GLSL` instead of split across CartoDB alpha + base brightness lerp.
- **VIIRS terminator-awareness** — `dayAlpha=0 / nightAlpha=1` still hides VIIRS on the lit hemisphere.
- **Sun-disc / VIIRS amber protection** — `brightGuard` smoothstep(0.75, 0.95, lum) preserves bright pixels from the new base-darkening mix as well as the (kept) pollution corona.
- **3-pane parallax** — fleet protocol untouched; all six Pis still receive identical config patches.

## Reversal criteria

Revert any phase if visual inspection on Pi 5 hardware reveals:

- Phase 1+2: night sky reads "too flat" or "too dark" → tune the navy color
  `vec3(0.02, 0.04, 0.08)` first, restore CartoDB only if shader-based
  darkening fundamentally can't reproduce the atmospheric depth
- Phase 1.5a: terrain detail blown out at deep night → restore the
  brightness lerp at a gentler curve (e.g. lerp 1.0 → 0.5 instead of 0.15)
- Phase 1.5b: night reads "muddy" or "low-contrast" → restore shadow crush
  with reduced strength (0.2 instead of 0.4)
- Phase 1.5c: glass-vignette rim doesn't fade smoothly between sky states
  → confirm `@property` is supported in the kiosk Chromium build; fall
  back to JS-driven opacity if not

## Counter-evidence considered

The **Game Developer dissent** in the original council was on TIMING, not
direction. ExpDev: *"Refactoring load-bearing pipeline 7 days from
GO/NO-GO is reckless."* The user explicitly said *"we have some time"*
on 2026-05-21, lifting that timing constraint. The architectural
direction (3 of 4 lenses for P2) became the consensus.

The **Game Designer warning** that VIIRS provides "irregular fill between
arterials" at altitude was the reason VIIRS was NOT dropped in this
migration — only CartoDB was. P1 (drop both) was rejected in favor of P2
(keep VIIRS, drop CartoDB). VIIRS still earns its keep at high altitude
as the only photoreal aggregate-luminance source.

The **Experience Designer warning** that the install's reference is
"the passenger window, not the satellite" justifies the eventual F+E
migration (Phases 3-5) — buildings + roads as light sources, not
light-on-ground. This is the post-ship Week-2 work.

## Files touched

- `src/lib/world/shaders.ts` — base darken + drop shadow crush + contrast
- `src/lib/world/compose.ts` — drop CartoDB setup + sync, drop base brightness lerp
- `src/lib/world/cesium-setup.ts` — drop `CARTODB_DARK_URL` constant
- `src/lib/night/index.ts` *(removed — inlined into `src/lib/utils.ts`)* — drop `NIGHT_MAP_SMOOTHSTEP_FLOOR/CEIL` exports
- `src/lib/model/config-tree.svelte.ts` — drop `baseNightBrightness`, `nightAlpha`, `nightBrightness`, `nightContrast`
- `src/lib/shell/window/Glass.svelte` — collapse 3 elements into 1 with `@property` for reactive opacity

## Related

- Council that produced the P2 verdict: see `~/.claude/projects/-Users-rick-d-Developer-zyetaone-z-aero-window/memory/` for the 4-lens council records.
- Pre-simplification architecture: `docs/ARCHITECTURE-original-framing.md` v1.
- The vector roads paradigm shift: `src/routes/playground/night-lab/+page.svelte` *(removed — `/playground` was deleted; `?lab=1` on `/` is the DEV lab)* Variant F.
