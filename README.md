# Aero Dynamic Window

Circadian-aware digital airplane window display built with SvelteKit, Cesium, and CSS effect layers for Raspberry Pi kiosk deployments.

**Zyeta product · engineered by [rdtect](https://github.com/rdtect)** — attribution SSOT: `credits.ts` in each app's `src/lib/`. Stakeholder docs (architecture, terms, lifecycle, credits): **`/wiki`**.

## Two apps

This repo holds two applications, and the root is neither — **there is no root
`package.json`**, so every `bun run ...` below must be run from one of them.

| Path | What it is |
| --- | --- |
| `aero-1/` | v1 — Cesium + Threlte. Feature-complete, and **what the Pi fleet runs today**. |
| `aero-2/` | The rewrite — MapLibre + Three, ADR-007 wall sync. Pre-ship. |
| `data/` `deploy/` `docs/` | Shared, at the root. `data/` is symlinked into `aero-1/`. |

A measured comparison of the two is in `docs/AERO-1-VS-AERO-2.md`.

## Quick start

```bash
cd aero-1          # or aero-2
bun install
cp .env.example .env   # each app has its own
bun run dev
```

## Commands

Run from `aero-1/` or `aero-2/`. At the root they fail with "Script not found".

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the Vite dev server on the LAN |
| `bun run check` | Run `svelte-check` |
| `bun run test` | Run Vitest unit tests |
| `bun run build` | Build the production client/server bundle |
| `bun run preview` | Preview the production build |
| `bun run serve` | Run the custom Bun server from `server.ts` |
| `bun run start` | Build, then run the custom Bun server |

## Environment

aero-1's variables. aero-2 declares its public ones in `aero-2/src/env.ts`
(inlined at build time) — see `aero-2/AGENTS.md`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_CESIUM_ION_TOKEN` | Build-time | Cesium terrain and Ion-backed assets. Stays on the build machine; never shipped to Pis. |
| `VITE_MAPBOX_TOKEN` | No | Mapbox Satellite imagery override |
| `VITE_TILE_SERVER_URL` | No | Local offline tile server for Pi deployments |
| `VITE_SENTINEL2` | No | Experimental Sentinel-2 imagery mode (requires a tiling proxy) |
| `AERO_ADMIN_TOKEN` | Pi runtime | Bearer-token gate for mutating admin routes (`/api/config` PATCH, `/api/content` POST, `/api/assets` POST, `/api/content/[id]` DELETE). Set per-Pi via `/opt/zyeta-aero/config.env`. Routes return 503 when unset (fail-closed). |
| `AERO_WIFI_RESET_TOKEN` | Pi runtime | Bearer-token gate for `POST /api/wifi/reset`. Same fail-closed pattern. |
| `AERO_PUSH_WORKER_URL` | No | Optional Cloudflare Worker URL for OTA bundle/config push |

## Layout

At the repo root:

- `aero-1/`, `aero-2/` — the two apps; each holds its own `src/`, `static/`,
  `scripts/`, `server.ts` and `package.json`
- `docs/` — ADRs, codemaps, standards, and reference notes
- `deploy/` — Raspberry Pi provisioning and updater scripts
- `data/` — tiles and generated assets (gitignored; symlinked into `aero-1/`)
- `AGENTS.md`, `CLAUDE.md`, `.agent/`, `.claude/`, `.serena/` — agent instructions
  and repo-local automation

## Key docs

- **`/wiki`** — living stakeholder page: architecture, **terms of operation**, lifecycle, **credits (Zyeta · rdtect)**, Pi performance process. SSR-only (`csr=false`), not on the kiosk cold path.
- `docs/ARCHITECTURE.md` — canonical engine architecture
- `docs/PI-PERF-PROCESS.md` — how to measure and improve Pi frame rate without lying to yourself
- `docs/PERF-2026-07-27-fps-investigation.md` — measured 2–4 fps baseline and ruled-out causes
- `docs/SHIP-READINESS.md` — install triage (✅ / ⚠ / ❓ / 🔴)
- `docs/ARCHITECTURE-original-framing.md` — v1 framing (historical)
- `docs/ADR-001-offline-tile-architecture.md` — offline tile ADR
- `docs/standards.md` — Rules 0–10
- `docs/CODEMAPS/INDEX.md` — module map
- `deploy/README.md` — Pi provisioning
- `AGENTS.md` — agent / contributor architecture rules
