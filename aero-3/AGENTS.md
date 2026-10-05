# aero-3

A spike, not the ship path: can full Babylon.js 9 on Bun beat aero-2 on a Pi 5?
The fleet still runs aero-1. Nothing here is wired into `deploy/`.

## Shape

- `server.ts` — `Bun.serve` with HTML-import bundling and `{ dir }` tile routes. No Vite, no SvelteKit.
- `index.html` → `src/main.ts` — one city's 5×5 z10 terrain patch (terrarium) draped with z11
  Sentinel-2 imagery, a flat skirt to the horizon, Babylon's physically based atmosphere, and
  a camera orbiting the city from the wall clock (so panes agree without talking).
- `src/sun.ts` — solar position from UTC + longitude (no time zones). Tested.

Units are km, y up, x east, z north.

## Run

```sh
bun install
bun run dev                 # http://localhost:3300/?place=hyderabad&clock=10
bun test && bun run check   # TypeScript 7
bun run compile             # dist/aero-3: one linux-arm64 binary, page bundled in
```

On a Pi, run the binary from a directory where `../data/tiles/sentinel2` and
`../aero-2/data/tiles/terrarium` exist, or set `IMAGERY_DIR` / `TERRAIN_DIR`.

## Measuring

`aero-2/tools/frame-cost.mjs` works on any page with a canvas. Pin the scene:
`?place=hyderabad&clock=10&hud=0`. Also `?scale=2` (half resolution), `?gpu=webgpu`,
`?yaw=<deg>` (pane offset). Compare against aero-2 on the same Pi.

## Not built yet

Night (VIIRS lights, twilight exposure), clouds, wing, fleet sync, admin. Add them only
after the Pi numbers say this stack is worth growing.
