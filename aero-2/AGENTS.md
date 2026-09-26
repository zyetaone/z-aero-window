# Aero 2 — agent notes

The rewrite: SvelteKit 2 + Svelte 5 runes, MapLibre (not Cesium), no CRDT.
Pre-ship. `aero-1/` is what the Pi fleet runs today.

Canonical architecture: **`docs/ARCHITECTURE.md`** (repo root, shared).
Root `AGENTS.md` describes **aero-1** — most of its Cesium, fleet-SSE and
`$lib/model` material does not apply here.

```sh
bun run dev · bun run check · bun run test · bun run build · bun run smoke
```

Run from `aero-2/`. The repo root has no `package.json`.

## Three checks, and what each one cannot see

| Command | Covers | Blind to |
|---|---|---|
| `bun run check` | types + `tools/check-repo.mjs` | anything that only fails at runtime |
| `bun run test` | vitest, `tests/` | routes — no test loads one |
| `bun run smoke` | every route, real browser, real server | needs `bun run build` first |

`bun run smoke` is the only check that loads a page. Run it before shipping a
route or state change. Its own docstring records the parent repo shipping
`/admin` as an empty `<body>` with a 200 and 489 green tests; here it has caught
a `+server.ts` that returned 500 on every request while the unit test that
imported the same module directly passed. A unit test that imports a route
module bypasses SvelteKit's validation of it.

Single test file: `bunx vitest run tests/wall-sync.test.ts`.
Single case: `bunx vitest run -t "applies at the named second"`.

## Imports

`#lib/*` (package.json `imports`), not `$lib`. `check-repo.mjs` enforces three
rules: no import cycles, **no tracked file importing an untracked one**, and
never naming a variable `state` when using `$state`.

## The wall: no sync protocol (ADR-007)

Three panes form one window and **never talk to each other**. Each derives its
state from wall-clock time alone. A snapshot carries `applyAtWallSec`; every
pane applies it at that second, not on receipt.

What this forbids, throughout `src/lib/display/`:
- `Math.random()` — use `daySeed()` + `mulberry32()` from
  `display/flight/flight-path.ts`
- `+= dt` accumulation — derive from the clock, never integrate
- `performance.now()` or any private clock in a rendering path

A pane that reboots and applies a snapshot an hour late must land on the same
config as one that applied on time. `tests/wall-sync.test.ts` asserts this at
30 s, 300 s, 3600 s and 86400 s late.

## Build-time configuration, which fails silently

`src/env.ts` declares the public vars via `defineEnvVars` with `static: true`
— they are **inlined at build time**. `AERO_MEDIA_ORIGINS` and
`PUBLIC_WALL_ORIGIN` also feed the CSP directives in `vite.config.ts`. So:

- Writing one into `/etc/aero/config.env` and restarting changes **nothing**.
  `deploy/pi/install.sh` reads them back out of that file and passes them into
  the build; a new one must be added in both places.
- A CSP-blocked media URL produces no console error and no `error` event on the
  element. It is indistinguishable from a push that never landed.

Server-side config is **injected as a parameter**, not read from `$env` —
`lib/server/tiles.ts` takes `env` so its tests can assert the fail-closed path.
Follow that shape for new server modules.

## Route modules

A `+server.ts` may only export handlers (`GET`/`POST`/…/`prerender`/`config`/
`entries`, or `_`-prefixed). Any other export makes the module refuse to load
at runtime, with a green typecheck. Constants belong beside the schema they
bound — `MAX_WALL_BYTES` lives in `#lib/wall.ts` for exactly this reason.

Mutating routes are bearer-gated and **fail closed** (503 when unset), on three
tokens with three blast radii: `AERO_ADMIN_TOKEN` (wall push off-loopback, media
upload, update), `AERO_FLEET_TOKEN` (heartbeat POST), `AERO_WIFI_RESET_TOKEN`
(purge Wi-Fi and reboot). `lib/server/fs-guard.ts` (`safeResolveWithin`) guards every
path built from a name the process did not generate; `media-store.ts` is
exempt because it generates its names (content hash + extension).

## Shared working tree

Multiple sessions edit this tree at once. Before committing:

- Stage explicit paths. `git add -A <dir>` has swept a peer's WIP twice.
- `git commit -- <path>` commits **disk** content — including a peer's edit
  inside a file you also touched.
- A green `check` in this tree proves nothing while someone else is editing.
  Verify on a detached worktree: `git worktree add --detach <tmp> HEAD`.
- Never `git push` without explicit human confirmation.
