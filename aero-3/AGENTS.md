# aero-3

A spike, not the ship path: can full Babylon.js 9 on Bun beat aero-2 on a Pi 5?
The fleet still runs aero-1. Nothing here is wired into `deploy/`.

## Shape

- `server.ts` — `Bun.serve` with HTML-import bundling and `{ dir }` tile routes. No Vite, no SvelteKit.
- `index.html` → `src/main.ts` — one city's 5×5 z10 terrain patch (terrarium) draped with z11
  Sentinel-2 imagery, a flat skirt to the horizon, Babylon's physically based atmosphere, and
  a camera orbiting the place's pin at 9 km from the wall clock (so panes agree without talking).
- Night: aero-2's VIIRS tree as the ground's emissive texture — raw z8 radiance under the patch,
  baked z11 lamp dots over the core, through aero-2's luminance knee once at boot. Lamps and a
  twilight exposure lift ramp in with the sun's elevation (−8°..2°).
- `src/buildings.ts` — the place's OSM footprints (`data/buildings/<place>.geojson`, gitignored)
  extruded at boot into one flat-shaded mesh: one draw call. Not 3D Tiles on purpose — that
  format earns its traversal cost for photogrammetry, not boxes. Fetch with
  `python3 ../aero-2/tools/fetch-buildings.py <place> --radius 3500 --max-features 20000 --out .`
- `src/sun.ts` — solar position from UTC + longitude (no time zones). Tested.

Units are km, y up, x east, z north.

## Run

```sh
bun install
bun run dev                 # http://localhost:3300/?place=hyderabad&clock=10
bun test && bun run check   # TypeScript 7
bun run compile             # dist/aero-3: one linux-arm64 binary, page bundled in
```

On a Pi, run the binary from a directory where `../data/tiles/sentinel2`,
`../aero-2/data/tiles/terrarium` and `../aero-2/data/tiles/viirs` exist, or set
`IMAGERY_DIR` / `TERRAIN_DIR` / `LIGHTS_DIR`; buildings come from `./data/buildings`
(`BUILDINGS_DIR`).

## Measuring

`aero-2/tools/frame-cost.mjs` works on any page with a canvas. Pin the scene:
`?place=hyderabad&clock=10&hud=0`. Also `?scale=2` (half resolution), `?gpu=webgpu`,
`?yaw=<deg>` (pane offset), `?lamps=1` (lamp gain), `?lift=8` (twilight exposure). Compare against aero-2 on the same Pi.

## Not built yet

Clouds, wing, fleet sync, admin. Add them only
after the Pi numbers say this stack is worth growing.
