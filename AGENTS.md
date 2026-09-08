# Repository Guidelines

> **Repository layout: this repo holds TWO applications.**
>
> | Path | What it is |
> |---|---|
> | `aero-1/` | v1 — Cesium + Threlte. Feature-complete and **what the Pi fleet runs today**. |
> | `aero-2/` | The rewrite — MapLibre + Three, ADR-007 wall-sync. Pre-ship. |
> | `data/`, `deploy/`, `docs/` | Shared at the root. `data/` is symlinked into `aero-1/`. |
>
> A measured comparison of the two — size, reactivity shape, enforcement,
> dead weight, and what each predicts on the Pi — is in
> `docs/AERO-1-VS-AERO-2.md`, with the commands to re-derive every number.
>
> **The repo root has no `package.json`.** Every `bun run ...` below must be run
> from `aero-1/` or `aero-2/`. This document describes **aero-1** unless a
> section says otherwise; aero-2 has its own `aero-2/AGENTS.md`.
>
> v1 lived at the root for its whole life, so anything that assumed git root ==
> app root needed fixing when it moved: the fleet updater, the installer, the
> systemd unit's `WorkingDirectory`, and the root-anchored `.gitignore` patterns.
> If you add tooling, resolve the app directory rather than assuming the root.

> See `docs/ARCHITECTURE.md` for the canonical engine-stack architecture
> (five layers, single-Viewer rule, reactive-feature pattern, manager →
> feature migration map). New features must follow the pattern:
> `$state` (state) → `$derived` (computation) → `$effect` (Cesium sync only).

## Project Overview

Aero Dynamic Window renders a **circadian-aware digital airplane window display** for office wellbeing. It composites CesiumJS globe/terrain/buildings with an optional Three.js photoreal overlay, CSS effect layers, and cabin chrome (oval frame, blind, wing silhouette). Designed for **Raspberry Pi 5 fleet deployment** in headless Chromium kiosk mode. Active branch: `hybrid-v2`.

## Architecture & Data Flow

### Rendering Stack (bottom → top)

```
Cesium globe (terrain, buildings, VIIRS night-lights, post-process color grade)
  └── Three.js overlay (clouds, wing, sky-extras, neon, postprocess) — flag-gated, default OFF
       └── CSS effect layers (haze, artsy clouds, rain, lightning, frost, micro-events)
            └── Shell chrome (oval window frame, blind, glass vignette, HUD)
```

- **Cesium** is confined to `src/lib/world/` — only `CesiumViewer.svelte` does `import('cesium')` at runtime; all other files reference it as a type only.
- **Three.js overlay** (`src/lib/world/three/`) mounts a transparent `<Canvas>` above Cesium. Camera is **pulled** from Cesium each frame (Cesium drives; Three mirrors). Gated behind `config.world.useThreeOverlay` (default `true`).

### State Management

Single `$state`-based reactive tree:

| File | Role |
|---|---|
| `src/lib/model/aero-window.svelte.ts` | `AeroWindow` class — root simulation state, owns `tick()` loop, orchestrates engines, CRDT config patching, fleet broadcast, persistence |
| `src/lib/model/config-tree.svelte.ts` | Flat reactive config — five `$state` namespaces: `atmosphere`, `camera`, `director`, `world`, `shell`. All tuning numbers live here inline at their defaults. **No `constants.ts` — the config tree IS the SSOT.** |
| `src/lib/model/crdt-store.ts` | CRDT LWW-register store for cross-device config reconciliation |

Context-based DI: `createAeroWindow()` in `+page.svelte`, `useAeroWindow()` in any descendant.

### Tick Pipeline (60Hz RAF)

```
Pane.svelte (RAF via game-loop.ts)
  └── model.tick(delta)
       ├── flight.tick(delta, ctx)       → FlightPatch (wraps body in untrack())
       ├── motionStep(delta, ctx)        → void        (wraps body in untrack())
       ├── directorTick(delta, ctx)      → WorldPatch  (leader-only, wraps in untrack())
       └── telemetry.recordFrame(duration)
```

Scene effects subscribe to the game-loop independently — NOT driven by `model.tick()`.

### Fleet Protocol (Multi-Pi)

REST + SSE (no central broker). Three Pis form one continuous panoramic window. Leader handles autopilot; followers receive `director_decision` events scheduled at wall-clock instants.

| Endpoint | Purpose |
|---|---|
| `PATCH /api/config` | Config patch dispatch (bearer-gated, namespace-allowlisted) |
| `POST /api/command` | SSE fan-out: `director_decision`, `set_scene`, `set_mode` |
| `POST /api/status` | Device heartbeat |
| `GET /api/devices` | Fleet device registry |
| `GET /api/events` | SSE event stream |

### Display modes (`set_mode`)

Admin **Mode** push (or local Escape / Return to Flight) switches the kiosk path:

| Mode | Wire name | Payload | Kiosk |
|---|---|---|---|
| Flight | `flight` | none | Cesium/Three globe |
| Video | `video` | absolute media URL | full-viewport looped `<video>` |
| Slideshow | `screensaver` | JSON `{ urls, intervalSec? }` | image playlist |

Payload parse/validate: `$lib/fleet/display-payload`. Persist across reload:
`$lib/fleet/display-mode-persist`. Admin rewrites `/api/assets/…` to absolute
URLs against the admin origin so multi-Pi walls share one asset host.

### Flight Mode State Machine

```
orbit ──flyTo()──→ cruise_departure ──(~2s)──→ cruise_transit ──(~2s)──→ orbit
```

## Key Directories

| Directory | Purpose |
|---|---|
| `src/lib/model/` | Reactive state — AeroWindow, config-tree, CRDT, telemetry, atmosphere-rules |
| `src/lib/flight/` | Flight sim FSM + motion (was `camera/` — avoids clash with `world/camera.ts`) |
| `src/lib/director/` | Autopilot + show-opening apply |
| `src/lib/world/` | Cesium isolation + `three/` overlay (dynamic import on kiosk) |
| `src/lib/shell/pane/` | Pane + GlobeLayer (compositor + RAF host) |
| `src/lib/shell/passenger/` | HUD, clocks, flight-readout |
| `src/lib/shell/operator/` | SidePanel, panel controls, TelemetryPanel |
| `src/lib/shell/window/` | Blind, Glass, RainGlass |
| `src/lib/shell/media/` | MediaStage — video/slideshow when not in flight |
| `src/lib/fleet/` | Browser multi-Pi client / admin store / parallax chrome gates |
| `src/lib/server/fleet/` | SSE bus, mDNS, heartbeat |
| `src/lib/bundle/` | Content-bundle **wire types only** (no runtime mount) |
| `src/lib/server/bundle/` | Bundle disk + asset/geojson serve |
| `src/lib/http/` | Auth, CORS, peer token (LAN host guard) |
| `src/routes/` | `/` kiosk · `/admin/*` fleet UI · `/api/*` · `/wiki` (architecture · terms · credits) |
| `src/lib/credits.ts` | Product attribution SSOT — Zyeta · engineered by rdtect |
| `content/` | Authored artifacts — Rule 0 content/control split |
| `tests/` | Mirrors `src/` + `content/` |
| `docs/` | Architecture, ADRs, CODEMAPS (shared, at the repo root) |

Paths in this table are relative to `aero-1/`, except `data/`, `deploy/` and
`docs/`, which are shared and live at the repo root.

## Development Commands

**Run these from `aero-1/`** (or `aero-2/` for the rewrite). There is no root
`package.json`, so `bun run test` at the top level fails with "Script not found".

| Command | What it does |
|---|---|
| `bun run dev` | Vite dev server (binds `0.0.0.0` for LAN; skips mDNS) |
| `bun run build` | Production build — route-split client + adapter-node |
| `bun run preview` | Preview production build |
| `bun run check` | Type-check with `svelte-check` |
| `bun run check:watch` | Type-check in watch mode |
| `bun run test` | Run all tests (alias: `bun x vitest run`) |
| `bun x vitest run tests/lib/world/sky.test.ts` | Run single test file |
| `bun x vitest run -t "memoises sun"` | Run tests matching a pattern |
| `bun run serve` | Full LAN server via Bun (`server.ts` — starts mDNS peer discovery) |
| `bun run start` | `build` + `serve` (production-like, what the Pi runs) |

`bun run dev` (Vite) skips mDNS — `/api/devices` only shows self. Use `bun run serve` for real fleet discovery.

## Code Conventions & Common Patterns

### Language & Framework

- **Svelte 5** with runes: `$state`, `$derived`, `$effect`, `$bindable()`, `createContext`/`getContext`
- **SvelteKit 2** with SSR disabled (`export const ssr = false` in `+layout.ts`)
- **TypeScript** strict mode — all strict flags enabled, `noUnusedLocals`/`noUnusedParameters`

### State Management

```typescript
// Flat $state, NOT classes per namespace
const config = {
  atmosphere: $state({ clouds: { density: 0.85, speed: 0.6, layerCount: 3 } }),
  camera: $state({ orbit: { driftRate: 0.01 }, parallax: { role: 'solo' } }),
  // ...
};

// Context DI
const model = createAeroWindow();  // only in +page.svelte
const model = useAeroWindow();     // in any descendant
```

### Critical Naming Rule: NEVER name a variable `state` when using `$state`. Use `model`, `engine`, `config`.

### Type SSOT Pattern

Const-array-derived unions for compile-time + runtime validation:
```typescript
export const WEATHER_TYPES = ['clear', 'cloudy', 'rain', 'overcast', 'storm'] as const;
export type WeatherType = (typeof WEATHER_TYPES)[number];
```

### Cesium Subsystem Pattern (`src/lib/world/`)

Each Cesium concern (imagery, buildings, terrain, atmosphere, lightning,
cloud billboards) is a **module of functions over module-private state**, not
a class. `compose.ts` (`CesiumManager`) is the only class: it owns the viewer,
the tick loop, and the post-process stage enumeration, and fans out to the
subsystem modules.

The uniform lifecycle is three exported functions:

```typescript
type C = typeof CesiumType;

// module-private Cesium state + idempotency caches
let _cs: C;
let _viewer: CesiumType.Viewer;
let _layer: CesiumType.ImageryLayer | null = null;
const _alphaGate = new EpsilonGate<number>(0.001, -1);

/** Dependency injection. Called once by CesiumManager before setup. */
export function initThing(Cesium: C, viewer: CesiumType.Viewer): void {
  _cs = Cesium; _viewer = viewer;
}

/** One-time Cesium work. async only when it touches I/O (network, terrain). */
export async function setupThing(): Promise<void> { /* … */ }

/** Per-tick, idempotent, takes a flat slice. Guard writes with EpsilonGate. */
export function syncThing(slice: ThingTickInput): void { /* … */ }
```

Rules:
- **`init*` takes only `Cesium + Viewer`.** No service locator, no global `$state`.
- **`sync*` is sync, idempotent, and takes a flat readonly slice** (`ImageryTickInput`
  is the reference shape). No DI, no side effects beyond Cesium mutations.
- **State stays module-private in the subsystem, not on the orchestrator.**
- **`init*` must reset every piece of viewer-scoped module state.** The module
  is a process singleton; the viewer is not. On remount (auto-retry, HMR, page
  nav) any retained `EpsilonGate` value makes the first write look redundant and
  get skipped, and any retained Cesium handle (layer, tileset, shader) points at
  a destroyed scene, so later syncs write into nothing. Neither case throws —
  the globe simply renders wrong. Null the handles and `.reset()` the gates.
- **`getViewer()` / `getCesium()` are escape hatches.** Kiosk paths should use typed
  APIs (`getCameraRead()`). `NightVariantPanel` is the deliberate exception: it
  mutates raw Cesium for live experimentation.

Why modules rather than classes: each subsystem is a singleton in practice
(one viewer per page), so a class buys only ceremony. If a second viewer ever
has to coexist, that is the moment to promote these to instantiable classes.

Adding a new engine-side concern:
1. Create `src/lib/world/<name>.ts` exporting `init<Name>` / `setup<Name>` / `sync<Name>`.
2. Call them from `CesiumManager`'s `start()` and `#tick()`.
3. If other libs need its data, expose a typed read-only getter (`getCameraRead()` pattern).

### Three.js Side: Declarative Svelte Subsystems

The Three.js overlay (`src/lib/world/three/`) deliberately does NOT use
the imperative init/setup/sync form. Instead:

- `ThreeOverlay.svelte` is the orchestrator — `<Canvas>` + scene mount +
  camera setup + lifecycle. Same role as `CesiumManager`, but a `.svelte`.
- Each visual subsystem (CameraMirror, Clouds, Wing, …) is a
  sibling `.svelte` component. Each owns its own Three objects via
  `$state` and ticks itself with `useTask`. Mounting = including the
  component in the template; destruction = removing it.
- Shared state lives in `lib/world/three/state.ts` (constants +
  geo helpers; no runes, hence no `.svelte.ts`). CameraMirror reads Cesium via the
  typed `getCameraRead()` API.

This is the Svelte 5 idiomatic equivalent of the subsystem pattern —
declarative lifecycle instead of imperative setup/sync/destroy. Three
and Cesium can use the same conceptual pattern (subsystem per
concern, orchestrator fan-out) without using the same *form*.

If the Three overlay grows to >30 effects, revisit whether the
`component-per-effect` model still scales, and consider hoisting shared
per-frame work into a typed `ThreeOrchestrator` class with a tick loop.

### Effect Pattern

There is no effect registry. DOM effects are plain Svelte components composed
directly in `shell/Pane.svelte` (`GlobeLayer`, `RainGlass`, `Glass`, `Blind`),
each of which:
- Owns its own `$state` — no global mutation
- Takes `model` (or a narrow prop slice) as its only input
- Subscribes to the game-loop via `$effect(() => subscribe(...))`
- Mounts/unmounts via an `{#if}` predicate on `model.*`

Z-order is local to `Pane.svelte`, not a shared table.

### Geo-Positioned Effects (Cesium-Native)

```typescript
import { activeCesium } from '$lib/world/active.svelte';

$effect(() => {
  const mgr = activeCesium.manager;
  if (!mgr) return;
  const viewer = mgr.getViewer();
  const ds = new Cesium.CustomDataSource('my-effect');
  viewer.dataSources.add(ds);
  return () => viewer.dataSources.remove(ds, true);
});
```

### Architectural Invariants

1. **Cesium isolation** — only `world/CesiumViewer.svelte` does runtime `import('cesium')`
2. **Flat DTO boundary** — config DTOs are flat; extend additively, never nest or reshape
3. **`untrack()` in reactive hot paths** — a tick body must not create reactive
   dependencies. This applies where the tick runs *inside* a reactive scope
   (`$effect`, `$derived`, `$effect.pre`): wrap model reads in `untrack(() => ...)`,
   as `flight.svelte.ts`, `motion.svelte.ts`, and `autopilot.svelte.ts` do.
   It does **not** apply to Threlte `useTask` callbacks: those are invoked from
   `renderer.setAnimationLoop`, outside any tracking scope, so reads there create
   no dependency (`Wing.svelte` relies on this and reads directly). `Clouds.svelte`
   still wraps its reads in one `untrack` — harmless, but not required. Do not
   "fix" `useTask` bodies by adding `untrack`; verify the call site's scope first.
4. **Deterministic 3-Pi panorama** — use `createSeededRng(daySeed())` from `world/prng.ts`, not `Math.random()`
5. **Sun-direction memo aliasing** — `computeSunDirection()` returns a shared mutated array; read-and-derive synchronously, never store the reference
6. **Shared blast radius** — `compose.ts`, `flight.svelte.ts`, `config-tree.svelte.ts` affect every surface; change them deliberately


## Important Files

| File | Role |
|---|---|
| `src/lib/model/aero-window.svelte.ts` | Root simulation state — `createAeroWindow()` / `useAeroWindow()` |
| `src/lib/model/config-tree.svelte.ts` | All tunable config — the SSOT for every number |
| `src/lib/shell/pane/Pane.svelte` | Layer compositor + window chrome |
| `src/lib/shell/pane/GlobeLayer.svelte` | RAF host + Cesium + dynamic Three |
| `src/lib/game-loop.ts` | Single RAF loop — subscriber pattern, visibility-aware |
| `src/lib/flight/flight.svelte.ts` | FlightSimEngine — orbit + cruise FSM (pose is plain fields) |
| `src/lib/world/compose.ts` | CesiumManager — imports cesium as type |
| `src/lib/world/curves.ts` | Time-of-day response curves — cross-renderer SSOT |
| `src/lib/director/autopilot.svelte.ts` | Weather randomiser + location cycler |
| `src/lib/fleet/client.svelte.ts` | DeviceClient — SSE + REST fleet communication |
| `src/routes/+page.svelte` | Main kiosk display |
| `svelte.config.js` | adapter-node, CSP, `$content`, **route-split** client output |
| `vite.config.ts` | Cesium static copy; optional three/cesium manualChunks |
| `package.json` | Dependencies + scripts |
| `tsconfig.json` | Strict TypeScript — extends `.svelte-kit/tsconfig.json` |

## Runtime/Tooling Preferences

- **Runtime**: Bun (lockfile: `bun.lock`). Do NOT use npm, yarn, or pnpm.
- **Build**: Vite 7 + SvelteKit 2 + `@sveltejs/adapter-node` (v5). Route-split client output (SvelteKit default) — `/` no longer parses the admin/lab UI at kiosk boot. Was `bundleStrategy: 'single'`; see the note in `svelte.config.js` for why it was reverted.
- **3D stack**: Cesium v1.143, Three.js v0.183, @threlte/core v8, postprocessing v6.
- **Styling**: hand-rolled component-scoped `<style>` blocks — no Tailwind. Shared design tokens + global chrome (focus ring, selection, scrollbars) live in `src/app.css`; the kiosk's brand `--sw-*` set is declared on the `/` route body in `src/routes/+page.svelte`.
- **Environment variables** (see `.env.example`):
  - `VITE_CESIUM_ION_TOKEN` — required for terrain/imagery at dev time
  - `TILE_DIR` — offline tile cache (default `/opt/zyeta-aero/tiles` on Pi)
  - `AERO_ADMIN_TOKEN` — bearer auth for admin routes (fail-closed: 503 if unset)
  - `AERO_WIFI_RESET_TOKEN` — bearer auth for WiFi reset (fail-closed)
  - `AERO_FLEET_TOKEN` — bearer auth for the telemetry heartbeat (fail-closed).
    Lower privilege than the admin token: reports metrics, cannot push scenes or
    trigger OTA. Auto-generated per device by `install.sh`; set it explicitly to
    share one value fleet-wide.
- **CSP**: Locked-down Content-Security-Policy with `unsafe-eval` (required by Cesium protobufjs), `blob:` workers, and connections to all major tile providers.

## Multi-Pi parallax

Three Pis side-by-side form one continuous panoramic window: same shared
state (location / altitude / weather / time / flightMode), per-device camera yaw.

Role assignment, in priority order:
1. `?role=left|center|right|solo` URL parameter
2. `localStorage['aero.device.role']` persisted from a prior URL param
3. Default `'solo'` (zero offset — identical to single-Pi mode)

| Role | Yaw offset | Frame | Autopilot | Receives `director_decision` | Open HUD whisper | SidePanel tab |
|---|---|---|---|---|---|---|
| `solo` | 0° | on\* | yes | — | yes if `hudVisible` | yes |
| `center` | 0° | off | yes (leader) | — | yes if `hudVisible` | yes |
| `left` | −(arc/2 − arc/6)° | off | no (follower) | yes, at `transitionAtMs` | no | only `?ops=1` |
| `right` | +(arc/2 − arc/6)° | off | no (follower) | yes, at `transitionAtMs` | no | only `?ops=1` |

\*Default `shell.windowFrame` is `false`; solo can toggle frame on for cabin chrome.

The leader emits `{v:2, type:'director_decision', locationId, transitionAtMs: now+2500}`;
followers schedule it for that wall-clock instant. The 2.5 s window absorbs ~±200 ms NTP drift.

### Chrome role SSOT

Shell must not re-inline left/right checks. Use helpers in
`src/lib/fleet/parallax.svelte.ts`:

- `isGroupLeader` / `isEdgePane` — flight leadership vs edge pane
- `showsOpsChrome(role, opsMode)` — SidePanel tab visibility
- `showsOpenPassengerHud(role, hudVisible)` — open-blind destination whisper
- `isOpsModeParam(search)` — `?ops=1|true` escape hatch for edge ops

**Rule:** scene state syncs fleet-wide; operator chrome is local; passenger
chrome on edge panes stays empty so the wall reads as one window. See
`docs/ARCHITECTURE.md` § *Shell: passenger vs operator vs multi-window*.

**Human flyTo (blind pull / LocationPicker):** only leaders call
`AeroWindow.flyTo()` productively — it broadcasts `director_decision`
(`scenarioId: 'manual'`) then cruises. Edge followers no-op; they move only via
`applyScene()` when the fleet client applies a scheduled decision.

## Tile caching (ADR-002)

Every external tile source is cached locally at build time, with the remote
origin as fallback, so a fielded device ships without an Ion token. Packaged
via `tools/tile-packager/`: `eox-sentinel2` (z3-12), `cesium-terrain` (Ion
quantized-mesh, token needed at BUILD time only), `terrarium` (AWS PNG
heightmap fallback), `viirs-night-lights` (packaged, not currently wired),
and per-location Overpass → GeoJSON buildings served at `/api/buildings/:city`.
Budget: ~1.2 GB per Pi. See `docs/ADR-002-zero-cost-caching-strategy.md`.

## Pi 5 deployment

- **Deploy gate**: the fleet updater (`deploy/aero-updater.sh`, daily timer) tracks
  the **`release`** branch, which CI fast-forwards only after check + tests + build
  pass on `main`. A red commit never deploys. The updater rolls back (reset +
  rebuild + restart) on install/build/post-restart-probe failure. `release` is
  CI-owned — never push to it by hand.
- **Version stamp**: `__APP_COMMIT__` (vite define) → `$lib/version` → `/api/status`
  heartbeat → admin device cards. Never import `$lib/version` from `server.ts`
  (not Vite-built).
- **Liveness watchdog**: `src/lib/world/lifecycle-liveness.ts` — 30 s context-lost /
  fps-stall check with bounded page reloads (3/hour sessionStorage budget shared by
  ALL self-healing reload paths via `tryConsumeReloadBudget()`).
- Hostname `aero-display-00.local`; systemd services `aero-xserver`, `aero-app`
  (:5173), `aero-kiosk` (Chromium), auto-started on boot.
- Chromium: `--kiosk --use-gl=angle --use-angle=gles --enable-webgl`; 2 GB disk
  cache at `/home/pi/.cache/aero-tiles`. CMA 512 MB.

## Repo hygiene scanners

Heuristic dev utilities — verify hits before deleting:

| Command | Finds |
|---|---|
| `node tools/reachability-scan.mjs` | modules unreachable from any entrypoint |
| `node tools/config-key-scan.mjs` | config-tree keys nothing reads |
| `node tools/doc-path-scan.mjs` | file paths in docs that no longer exist |
| `node tools/dead-export-scan.mjs` | exported symbols with no non-test, non-barrel consumer |

## Route smoke test

```bash
bun run build && node build/index.js &          # or: bun run start
"$CHROME" --headless=new --remote-debugging-port=9335 --enable-webgl about:blank &
bun run smoke --base http://127.0.0.1:5401 --port 9335
```

Loads every page route and asserts it actually rendered (non-empty body, no
init-time exception, canvas present on the kiosk route).

**Run this before shipping UI or state changes.** `/admin` once shipped as a
completely blank page: `check` was green, all 489 unit tests were green, and the
kiosk route looked perfect, because a single throw during component init
produces an empty `<body>` that no type check or non-mounting unit test can see.
Component tests can now mount (vitest resolves Svelte's browser condition), but
only a real page load covers the whole route.


## Testing & QA

- **Framework**: Vitest 4.x with `happy-dom` environment (configured inline in `vite.config.ts`)
- **Test locations**: `tests/` mirroring `src/` and `content/` structure
- **File patterns**: `**/*.{test,spec}.{ts,svelte.ts}` (includes `.test.svelte.ts` for component tests)
- **No globals**: explicit `import { describe, it, expect } from 'vitest'` required
- **Assertion style**: `expect(value).toBe(expected)` — standard Vitest matchers
- **Server endpoint tests**: Directly import SvelteKit `+server.ts` handler functions, call with synthetic `Request` objects and mock `getClientAddress`
- **No global setup file** — each test file is self-contained
- **Coverage**: snapshot counts go stale fast — run `bun x vitest run` for the current number. No formal coverage threshold configured.
- **Run**: `bun run test` (alias: `bun x vitest run`)

### Test Patterns

```typescript
// Pure logic test
import { describe, it, expect } from 'vitest';
import { clamp } from '$lib/utils';

describe('clamp', () => {
  it('clamps below min', () => {
    expect(clamp(-1, 0, 10)).toBe(0);
  });
});

// Svelte module test (.test.svelte.ts)
import { describe, it, expect } from 'vitest';
import { AeroWindow } from '$lib/model/aero-window.svelte';

describe('AeroWindow', () => {
  it('boots with default config', () => {
    const model = new AeroWindow();
    expect(model.config.camera.parallax.role).toBe('solo');
  });
});

// Server endpoint test
import { GET } from './+server';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('GET /api/internal/peer-token', () => {
  beforeEach(() => { vi.stubEnv('AERO_ADMIN_TOKEN', 'test-token'); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('returns token for localhost', async () => {
    const res = await GET(new Request('http://localhost'));
    const json = await res.json();
    expect(json.token).toBe('test-token');
  });
});
```
