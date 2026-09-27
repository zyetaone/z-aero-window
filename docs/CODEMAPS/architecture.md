# Architecture Codemap

**Last Updated:** 2026-08-12

> Prefer `AGENTS.md` + `docs/ARCHITECTURE.md` when this file drifts.

## Layer diagram

```
                         DEPENDENCY LAYERS

 ┌───────────────────────────────────────────────────────┐
 │  ROUTES                                               │
 │  +layout.ts (ssr=false, app-wide)                    │
 │  +page.svelte — root context + side-effects          │
 │  admin/   playground/   wiki/   api/                 │
 └─────────────┬───────────────────────┬─────────────────┘
               │                       │
               v                       v
 ┌─────────────────────────┐   ┌──────────────────────────┐
 │  MODEL                  │   │  SHELL                   │
 │  AeroWindow + ctx DI    │   │  pane/ passenger/        │
 │  config tree (SSOT)     │   │  operator/ window/       │
 │  CRDT LWW store         │   │  dual-tree panel/*       │
 │  telemetry, persistence │   └─────────────┬────────────┘
 └────┬─────┬────┬─────────┘                 │
      │     │    │                           │
      v     v    v                           v
 ┌────────┐┌──────────┐ ┌──────────────────────────────┐
 │FLIGHT  ││DIRECTOR  │ │ BUNDLE                       │
 │orbit + ││autopilot │ │ wire types + disk store      │
 │cruise  ││scenarios │ │ (no DOM mount)               │
 │motion  ││show open │ │ DOM effects live in shell/   │
 └────────┘└──────────┘ └──────────────┬───────────────┘
                                       │
                                       v
                          ┌──────────────────────────┐
                          │ WORLD                    │
                          │ Cesium (compose) +       │
                          │ Three overlay (flag)     │
                          └──────────────────────────┘

 Authored content                         Fleet (REST + SSE)
 ┌──────────────┐                         ┌──────────────────┐
 │ content/     │                         │ fleet/           │
 │ locations/   │                         │ client (SSE)     │
 │ weather/     │                         │ peer-sync        │
 │ palettes/    │                         │ parallax (roles) │
 │ shows/       │                         │ rest-admin       │
 └──────────────┘                         │ lan-peers mDNS   │
                                          └──────────────────┘
```

## The four invariants

1. **Cesium isolation.** `import 'cesium'` appears in exactly two type-level imports (`world/compose.ts`, `world/cesium-setup.ts`) and one runtime `import('cesium')` (`world/CesiumViewer.svelte`). Verify with `rg "from 'cesium'" src/lib/`.
2. **Flat DTO boundary.** Fleet protocol v1 + v2 messages cross the wire as flat shapes. v2 added `config_patch { path, value }` additively without restructuring v1.
3. **`untrack()` in tick bodies.** Tick work that runs inside reactive scopes wraps model reads in `untrack()` (flight, motion, director). Threlte `useTask` is outside tracking — no untrack needed there.
4. **Content/control split (Rule 0).** `content/` holds the authored what-plays artifacts (locations, weather, palettes, shows). `src/lib/` holds the how-it-plays code. Imported via the `$content` alias.

## Data flow: user adjusts a slider

```
SidePanel / admin panel (e.g. AtmosphereControls)
    │  usePanelConfig() → patch('atmosphere.clouds.density', 0.8)
    v
applyConfigPatch → setByPath + CRDT stamp
    │
    ├── admin: peer-sync $effect (PEER_SYNC_PATHS)
    │   → POST PATCH /api/config to every peer
    │     (other Pis route through their own CRDT merge)
    │
    ├── ArtsyClouds.svelte $derived recomputes sprite count
    │
    └── Pane.svelte $derived recomputes filterString
        → CSS backdrop-filter on the window pane
```

## Data flow: RAF tick

```
game-loop.ts (RAF singleton)
    │  subscribe(fn)
    v
Pane.svelte $effect → model.tick(delta)
    │
    ├── flight.tick(delta, ctx)            untrack() → FlightPatch
    │     (orbit, scenarios, cruise FSM)
    │
    ├── motionStep(delta, ctx)             untrack() → void
    │     (turbulence, banking, breathing, vibe)
    │
    └── directorTick(ctx)                  untrack() → WorldPatch
          early-return if !ctx.isLeader
          ├── tickRandomize → AtmospherePatch
          └── tickDirector  → LocationId
                    │
                    └── if leader: emit director_decision
                        with transitionAtMs = now + 2.5 s
                        → followers schedule timeout to apply at wall-clock
```

CesiumManager has its own `postRender` tick — decoupled from `game-loop.ts`.

## Data flow: fleet config write

```
Admin slider (or peer device's local UI)
    │
    v
config.atmosphere.haze.amount = 0.12
    │
    ├── crdt.set(path, value, Date.now(), deviceId)
    │     (local LWW timestamp + sourceId)
    │
    ├── peer-sync $effect → POST /api/config
    │   {path, value, timestamp, sourceId}
    │
    v
Peer device's POST /api/config handler
    │
    v
applyConfigPatch(path, value, { remote: { timestamp, sourceId } })
    │
    └── crdt.merge(...)
          ├── if local timestamp newer → reject (return false)
          ├── if equal & local sourceId greater → reject
          └── else apply → setByPath() → reactive update
```

LWW with sourceId tiebreak guarantees deterministic convergence across peers without central coordination.

## Component tree

```
+page.svelte ── CONTEXT BOUNDARY (createAeroWindow)
│
├── Pane.svelte ── useAeroWindow(), game-loop subscription
│   ├── CesiumViewer.svelte ── runtime import('cesium')
│   ├── GlobeLayer.svelte ── hosts CesiumViewer
│   ├── window/RainGlass (CSS water beads, mounted only while raining)
│   ├── window/Glass (vignette + recess)
│   └── window/Blind ── useBlind composable
│
├── HUD.svelte ── useAeroWindow() + showsOpenPassengerHud (parallax SSOT)
├── SidePanel.svelte ── showsOpsChrome + isOpsModeParam (parallax SSOT)
│   ├── hud/TelemetryOverlay (open-state, ALT/GS/LOC)
│   └── hud/BlindInfoCard (closed-state branding)
│
├── SidePanel.svelte ── useAeroWindow()
│   └── panel/* (LocationPicker, TimeControl, FlightControls,
│       AtmosphereControls, LightingControls, WeatherPicker)
│
└── TelemetryPanel.svelte ── Shift+T devtools view
```

## State ownership

| Owner | Responsibility |
|-------|----------------|
| `model/aero-window.svelte.ts` | AeroWindow class — composes engines, owns `location`/`weather`/`timeOfDay`/`flightMode`, dispatches ticks, applies show opening, holds `flight` instance, telemetry |
| `model/config-tree.svelte.ts` | Flat `$state` namespaces: `atmosphere`, `camera`, `director`, `world`, `shell`. The default literals here are the SSOT for tuning — no `constants.ts`. |
| `model/crdt-store.ts` | LWW register store with sourceId tiebreak. Wraps the config tree so fleet peers reach deterministic convergence. |
| `flight/flight.svelte.ts` | FlightSimEngine — orbit + cruise FSM. Position via `model.flight.*`. |
| `flight/motion.svelte.ts` | Module-scope `motion` `$state` — turbulence, banking, breathing. |
| `director/autopilot.svelte.ts` | Module-scope private timers. `directorTick()` returns `WorldPatch`. Leader-only. |
| `bundle/*` | Wire types + server disk store only — no runtime DOM mount. |
| `fleet/rest-admin.svelte.ts` | RestAdminStore — admin dashboard (devices, peers). |
| `fleet/client.svelte.ts` | DeviceClient — SSE + status loop on kiosk. |
| `fleet/peer-sync.svelte.ts` | Admin ambient → fleet; ambient push-failure log. `PEER_SYNC_PATHS` SSOT lives in `model/peer-sync-paths.ts` (shared with persistence). |
| `fleet/parallax.svelte.ts` | Role bindings + chrome gates (`showsOpsChrome`, etc.). |
| `shell/operator/panel/patch.ts` | `usePanelConfig` — dual-tree config write gate. |

## Key interfaces

### `SimulationContext` (`src/lib/types.ts`)
The per-frame snapshot every engine tick receives. Carries `time`, `wallTimeSec`, `wallDeltaSec`, `heading`, `altitude`, `weather`, `turbulenceLevel`, plus full `camera` + `director` config slices, plus `isLeader`. The wall-clock fields are the tick contract: absolute seconds, not accumulated deltas. Pre-allocated; reused each frame.

### Scene effects (no registry)
The `Effect`/`Compositor` registry was removed. DOM effects are plain Svelte
components composed directly in `shell/pane/Pane.svelte` and mounted with `{#if}`.
Geo effects render inside Cesium via world modules (`init*` / `setup*` / `sync*`).

### `Show` (`content/shows/` + `src/lib/director/show-opening.ts`)
The authored experience primitive. Shows are authored under `content/shows/` (Rule 0 content/control split); `pickDailyShow()` selects the day's show and `director/show-opening.ts` applies its opening to the running model. Today carries an `opening: { location, weather, timeOfDay }`. Documented growth surface: `scenes`, `cues`, `rotation`, `palette`.

### Fleet protocol v1/v2 (`src/lib/fleet/protocol.ts`)
v1 = flat patches. v2 = path-targeted (`config_patch`, `role_assign`, `director_decision`). Coexist on the wire; receivers branch on the `v` field.

## Flight mode FSM

```
orbit ─────flyTo()─────▶ cruise_departure ───(~2s)──▶ cruise_transit ───(~2s)──▶ orbit
                          warp ramp                    teleport + arrive
                          blind closes                 blind opens

durations: model.config.camera.cruise.{departureDurationSec, transitDurationSec}
```

## Z-layer system

There is no shared Z table. Layer order is local CSS in `shell/pane/Pane.svelte`
(Cesium at `z-index: 0`, optional Three overlay, then `RainGlass`, `Glass`, `Blind`).
