# aero-3

A spike, not the ship path: can full Babylon.js 9 on Bun beat aero-2 on a Pi 5?
The fleet still runs aero-1. Nothing here is wired into `deploy/`.

## Shape

One reason to change per file:

- `server.ts` — `Bun.serve` with HTML-import bundling and `{ dir }` tile routes. No Vite, no SvelteKit.
- `src/main.ts` — scene, light, camera orbiting the place's pin at 9 km on the wall clock (panes
  agree without talking), the time-of-day slider, the place picker, the render loop. Cruise
  altitude clears the highest terrain near the orbit by 1.2 km (the Himalayas), else 3.5 km AGL.
- `src/places.ts` — the place table and aero-2's rotation, ported as is: 600 s per city, the day's
  order a Fisher-Yates shuffle seeded by the day number. With no `?place=`, the page follows it
  and reloads into the next city (a reload frees every buffer). The Himalayas are `?place=` only.
- `src/world.ts` — the ground. A 3×3 z10 detail patch (terrarium + z12 Sentinel-2, 3072 px: the
  Pi's 4096 px texture limit is the ceiling) inside a 5×5 z8 ring (~750 km, past the horizon), both
  bent by Earth's curvature. Night is NASA's VIIRS radiance (GIBS, capped at z8) through aero-2's
  luminance knee as a faint glow, and as a mask that shows the real imagery warm under lit
  districts. The far ring sinks 3 km under the detail patch (z8's coarse peaks overshoot z10's in
  the mountains). Ground textures are map data only; the haze dome below is the one place noise
  breaks a map up. Textures upload from JPEG blobs, so
  no CPU canvas outlives boot; `scene.clearCachedVertexData()` drops the mesh copies after build.
- `src/buildings.ts` — OSM footprints extruded at boot into one mesh with a procedural window
  facade: concrete and glass by day, lit rooms at night, plus a baked ambient-occlusion
  lightmap (UV2, `useLightmapAsShadowmap`) so walls darken toward the street. Not 3D Tiles on purpose — that format
  earns its traversal cost for photogrammetry, not boxes. Fetch with
  `python3 ../aero-2/tools/fetch-buildings.py <place> --radius 3500 --max-features 20000 --out .`
- `src/lights.ts` — every light is a single point from map data, in three groups: street lamps
  every 32–55 m along the road pack (`../data/roads`), with only a share of each class lit (back
  streets 50%), dark stretches where the road's own 1D noise dips, and per-lamp brightness jitter; building lights, one per ~3,000 m² on 45% of flat
  roofs and a few lit windows on walls of buildings 12 m and up (buildings.ts); and far-ring towns
  from bright NASA VIIRS pixels past the roads (world.ts). One additive point cloud on a small
  shader: each light fades and reddens toward the horizon and twinkles faintly. Mix: sodium 65%,
  warm white 15%, white 10%, red 5%, blue 5%. The HUD's Lights panel sets each group's gain and
  the bloom live. `GlowLayer` blooms the lamps and the buildings' lit windows, at night only.
- `src/haze.ts` — the amber murk over a lit city: one additive sheet 450 m up carrying world.ts's
  light dome (VIIRS downsampled into a blur, kneed so only the city domes, × fbm noise from math.ts).
  Gain = Haze slider × darkness ÷ exposure.
- `src/trees.ts` — low-poly cones in clusters wherever the imagery within 5 km of the pin reads
  green: thin instances, one draw call (`?trees=0` to skip).
- **Water** comes from the imagery too: dark, green-or-teal pixels get a smooth roughness map
  (world.ts `waterMask`), so lakes and sea catch the sun as a glint.
- `src/clouds.ts` — aero-2's cloud cluster model on one SpriteManager: near cumulus, horizon
  systems, flat banks on the horizon, cirrus; per-tier wrap so wind never blows the deck off the
  place. Each place gets a weather regime per UTC day (clear, fair, scattered, towering, cirrus),
  the same on every pane; `?weather=` pins one. No card reaches below the ground, or the terrain
  clips it flat.
- `src/stars.ts` — aero-2's Yale catalogue (imported, not copied) turned by sidereal time.
- `src/sun.ts` — sun position (with the equation of time) and sidereal angle from UTC + longitude
  (no time zones). Tested.
- `src/math.ts` — `RAD`, `smoothstep`, and the seeded noises (`hash`, `mulberry32`, `noise1`, `noise2`, `fbm`) every module shares.

## Traps (each cost a debugging pass)

- **PBR `ambientColor` defaults to black**, which throws away the sky light the atmosphere writes
  to `scene.ambientColor`: shaded walls went near-black. Ground, buildings and trees set it white
  by day and fade it out with darkness, or the twilight exposure lift turns night ground grey.

- **`clearCachedVertexData` leaves nothing to rebuild a lost GL context from**, so a context loss
  reloads the page (main.ts), and so does a failed boot after 10 s: a kiosk has no one to press F5.

- **Units are metres.** Babylon's atmosphere reads scene units as metres (`scaleToRef(0.001)` in
  `atmospherePerCameraVariables.js`). In km it put the horizon at eye level (a dark 2° band) and
  aerial perspective vanished.
- **The sky composites after rendering group 0**, wherever depth is still far, blending over
  anything there. Clouds and stars write no depth, so they live in group 1, with group 1's depth
  clear turned off so the terrain still hides them.
- **Point clouds built at the origin get frustum-culled** (bounding box inside the near plane):
  stars set `alwaysSelectAsActiveMesh`.
- **A squashed sprite at a random angle reads as a flame.** Cloud cards stay near-upright.
- **Fragment output is clamped to 1 before blending**: an additive shader that puts its gain in
  alpha (`ALPHA_ADD`, src·α) can never exceed the gain. Fold the gain into the colour (`ALPHA_ONEONE`).
- **GlowLayer re-renders whatever it includes**; including the atmosphere-plugin PBR ground blew
  the dusk sky white. It includes the lamp points only.
- **A StandardMaterial adds its emissive texture at `texture.level`**, not × `emissiveColor`: the
  haze sheet's gain is the level, or it washes the city flat orange.
- **120k additive points sum to a white sheet**: per-lamp alpha is ~0.2.
- **The twilight exposure lift multiplies emissive too**, so emissive gains are divided by it:
  `?carpet=1` means 1 at night, not 9.

Units are metres, y up, x east, z north.

## Run

```sh
bun install
bun run dev                 # http://localhost:3300/?place=hyderabad&clock=10
bun test && bun run check   # TypeScript 7
bun run smoke               # boots day + night in Bun.WebView, checks every layer built, screenshots to dist/smoke/
bun run compile             # dist/aero-3: one linux-arm64 binary, page bundled in
```

On a Pi, run the binary from a directory where `../data/tiles/sentinel2`,
`../aero-2/data/tiles/terrarium` and `../aero-2/data/tiles/viirs` exist, or set
`IMAGERY_DIR` / `TERRAIN_DIR` / `LIGHTS_DIR`; buildings come from `./data/buildings`
(`BUILDINGS_DIR`).

## Measuring

`aero-2/tools/frame-cost.mjs` works on any page with a canvas. Pin the scene:
`?place=hyderabad&clock=10&hud=0`. Also `?scale=2` (half resolution), `?gpu=webgpu`,
`?yaw=<deg>` (pane offset), `?lamps=1` (lamp gain), `?lift=8` (twilight exposure), `?clouds=0..1`
(cover), `?glow=0` (no bloom), `?debug` (exposes `scene`, `camera`, `world` for ablations). Compare against aero-2 on the same Pi.

## Not built yet

Wing, fleet sync (beyond the wall-clock rotation), admin, live weather. Add them only
after the Pi numbers say this stack is worth growing.
