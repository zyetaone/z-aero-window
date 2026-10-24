# aero-3

A spike, not the ship path: can full Babylon.js 9 on Bun beat aero-2 on a Pi 5?
The fleet still runs aero-1. Nothing here is wired into `deploy/`.

## Shape

MRAX by folder, one reason to change per file. Dependencies point down the list: nothing in
`flight/` imports Babylon, and `world/` never reads the URL or the wall.

```
src/main.ts      boot: visit → world → render loop. Wiring only.
src/math.ts      the shared seeded noise and smoothstep: the one util
src/flight/      MODEL + RULES, pure and tested: params (URL), places, weather, path, plan.ts
src/world/       ACTIONS, Babylon: lighting.ts (pure, tested), wing.ts, sky/, ground/, city/
src/cabin/       EXPERIENCE on the glass: rim, rain, blind, drone, credits, hud.ts (lone pane)
src/ops/         the operator and the kiosk: wall, fleet, /admin, kiosk.ts (recover, watchdog, shed)
server.ts        Bun.serve: the page, data routes, /api/*
tools/           build, smoke, pi-bench, fetch-terrain, ship-pack
../deploy/       Pi OS: units, install, updater, health-check (shared with aero-1/2)
```

Cross-folder imports use the package `imports` alias (`#flight/weather.ts`, `#math.ts`: `#*` → `./src/*`,
native to Bun and TypeScript); same-folder imports stay `./`. `bun run coverage` covers the pure layers.

Where things not built yet go: remote actions in `ops/`, a camera-pose model in `flight/path.ts`. A folder appears with its first file.

**`src/flight/`, `src/cabin/` and the frame's light** — the flight this pane is on, and how it is shown:

- `src/flight/plan.ts` — `planFlight(params, wall, now)`: the place, path, weather, seat row, pane yaw
  and pinned clock for this 10-min slot, one plain object (tested: three roles, one visit).

- `src/flight/params.ts` — every URL knob, read once and typed: the one list of them (tested).
- `src/world/lighting.ts` — one frame's light from the sun's and moon's height: darkness, exposure, every
  emissive gain divided back out of the night lift, lamp alpha held under 1 (tested; main.ts applies it).
- `src/main.ts` — scene, light, the wiring and the render loop. Each visit deals a cruise band (~3.5, 6.5 or 10 km AGL, jittered,
  all over the cloud deck) and a climb or descent of up to 2 km; never under 2 km over the highest
  ground within 4 km of the track. `?alt=` pins it.
- `src/flight/path.ts` (`pathFor`) — the aircraft at a wall-clock second, pure in (seed, second): an elliptical
  orbit (radius per place, default 9 km; Dubai 13, Himalayas 24) whose direction, start and tilt
  are seeded per visit, a slow climb, bank into the turn, the seat on the inside, the gaze panning
  ±18°. The camera is aircraft × seat quaternions. Tested.
- `src/flight/weather.ts` (`weatherFor`) — one object per place and UTC day: regime (clear, fair, scattered, towering,
  cirrus, hazy, overcast, storm), sun strength, haze, rain, cloud deck height and wind, heap and grey,
  night-light gain. `?weather=` pins the regime.
- `src/flight/motion.ts` (`rideAt`) — the ride under the seat, pure in (visit seed, wall second):
  rough air as slow noise in pitch, roll and heave, a bump some 12 s windows that rings down, the
  22 s breathing swell. Today's regime sets the turbulence (`weather.turbulence`, 0.6 clear to 2
  storm), thinned above 12 km. Hashed off the wall clock so three panes bump on one second with one
  sign (aero-1 rolled the sign per pane). main.ts folds it into the aircraft quaternion, so the wing
  rides with the airframe and the world moves. `?ride=0` holds the path (shots, the bench).
- `src/flight/storm.ts` (`strikeAt`) — lightning on a storm day, pure on the wall clock (aero-2's): one
  chance a second, a return stroke, a dip and a re-strike, 4-30 km from the pin, so all panes flash on
  the same frame. `cabin.ts` `lightning()` turns it into a faint #flash on the glass (brighter at night),
  the strike's light in the clouds (`clouds.ts` `boltTerm`) and thunder on the drone at 343 m/s.
  Screenshots of a strike need a frozen `Date.now` (it is gone before a live screenshot lands).
- `src/cabin/cabin.ts` — aero-2's synthesised cabin drone (centre or solo pane only, `?audio=0` off,
  cutoff falls with altitude; a rain hiss on rainy days, thunder in storms), and DOM over the canvas (CSS in index.html): the window rim darkening with the
  light, rain on rainy days (still drops painted once to a canvas, seeded per pane, plus five
  runners; no backdrop-filter), and the blind. The blind is closed in the markup, lifts after 30
  frames and 12 s after the later of the slot start and the wall push it loaded into (so panes lift
  together), and comes down 6 s before every 10-min slot boundary, where main.ts reloads; while
  it closes it reads "here → next" when the rotation moves on.
  A pane that boots inside a push's 10 s lead waits for its applyAt before building.
- `src/cabin/hud.ts` — the time-of-day slider, the Lights panel, the place picker. The HUD is off on a wall pane (any `?role=`), on elsewhere; `?hud=0|1` overrides.
- `/api/status` answers 503 (`page: building|failed`) until the server has bundled the page once
  at startup, so a page that fails to build fails the updater's probe and rolls back.
  `?blind=0` holds one visit (screenshots, smoke).
- `src/flight/places.ts` — the place table, each place's mood (`MOODS`, aero-2's PLACE_MOODS: night glow,
  cloud base offset, cloud count, dust and window pitch, folded into `weatherFor`'s one object and the
  plan's `seatPitch`; direction left out, the seat is on the inside of the turn either way), and aero-2's rotation, ported as is: 600 s per city, the day's
  order a Fisher-Yates shuffle seeded by the day number. Each slot is a visit: with no `?place=`
  a new city, either way a new flight. The Himalayas are `?place=` only.
- One sea (ground/maps.ts `paintSea`): where the terrain says sea floor, cloud and no-data in the
  imagery become the near patch's own water colour, and the far ring's two sources (Sentinel z8
  over an older z7) are pulled toward it. A cloudy Sentinel scene over the Gulf read as a snowy
  plateau with straight edges; z8 no-data drew black wedges (now transparent, `clearNoData`).
- `src/flight/weather.ts` deals per place per day: regime, cloud layout (scatter, streets along the wind,
  a front, clumps), wind direction, contrast (`scene.imageProcessingConfiguration`) and Mie scale
  (deep blue to milky sky). The atmosphere's own exposure is 1.7 by day (`?sky=`): at 1 a clear
  afternoon sky rendered dark slate. Image-processing exposure does not reach the sky.
- **Roads by day**: the place's OSM road pack is stroked into the near imagery canvas before it
  becomes a texture (asphalt, 8-32 m by class, sub-pixel roads at partial alpha), so Sentinel's
  smeared streets read crisp. The same pack lights the lamps at night, and a white mask of it
  composes into the night ground: road × VIIRS radiance × ~430 m breakup noise = sodium on the
  asphalt of lit districts only. Lamps are soft 3 px discs, so they slide between pixels, not snap.
- **Ground detail**: a tiling 256² PBR detail map (`material.detailMap`, raw bytes: R albedo,
  G/A normal, B roughness) repeats every 350 m on the near patch for grain the imagery can't hold.
- **Water** comes from the imagery too: dark, green-or-teal pixels get a smooth roughness map
  (ground/maps.ts `waterMask`), broken up by fractal noise into ruffled patches and calm slicks, so lakes
  and sea catch the sun as glitter rather than a mirror.
- `src/world/wing.ts` — aero-2's 737 wing (CC-BY-4.0, credited in the file; served from
  `../aero-2/static/models`, `MODELS_DIR`) on a seat node that follows heading and bank but not
  the gaze or the pane's yaw. Drawn 10× size 10× further out, so it clears the 10 m near plane.
  Mirrored for left-side windows; nav light (green starboard, red port) and aero-2's double-pulse
  strobe on the wall clock. It sits in the glow pass so the city's bloom stops at its edge.
  `?wing=0` to skip. Merged by material at load: 28 draw calls, not the export's 65.
  Each visit deals a seat row (`plan.ts` `seatFor`, from the visit seed so the panes agree): behind the wing
  half the time, over it a third, ahead of the leading edge the rest (the wing behind you: only the
  aft-looking pane sees it). `?seat=behind|over|ahead` pins one. Verified in-frame with markers: the
  model's nose is +z (root chord z -2..7, tip -5..-3, winglet leans to -z) and follows the travel.
- `src/math.ts` — `RAD`, `smoothstep`, and the seeded noises (`hash`, `mulberry32`, `noise1`, `noise2`, `fbm`) every module shares.

**`src/world/sky/`** — what is above: sun, moon and star positions, the stars, the moon, the clouds.

- `src/world/sky/clouds/` — `clouds.ts` and its three sprite sheets. aero-2's cloud cluster model on one SpriteManager: near cumulus, horizon
  systems, flat banks on the horizon, cirrus; per-tier wrap so wind never blows the deck off the
  place. weather.ts sets the cover, deck height, wind, how far cumulus heap up and how grey each
  cluster runs. No card reaches below the ground, or the terrain
  clips it flat. At night (`nightTerms`, tested) the moon takes the sun's place on each puff (its
  cool white, a body term plus a moon side) and the city's lamps light the deck from below,
  falling off over ~30 km from the pin: night cumulus over a lit city read grey, not black.
- `src/world/sky/moon.ts` — a phase-lit disc (each fragment a point on a sphere, lit toward the sun, faint
  earthshine) 600 km out along `sky/ephemeris.ts` `moonAt` (aero-2's series), 3.5× true size, after the sky
  like the stars.
- `src/world/sky/stars.ts` — aero-2's Yale catalogue (copied as is into `star-catalogue.ts`) turned by sidereal time.
- `src/world/sky/ephemeris.ts` — sun position (with the equation of time) and sidereal angle from UTC + longitude
  (no time zones). Tested.

**`src/world/ground/`** — the earth: terrain patches, their baked maps, the tile grid, the trees.

- `src/world/ground/terrain.ts` — the ground. A 3×3 z10 detail patch (terrarium + z12 Sentinel-2, 3072 px: the
  Pi's 4096 px texture limit is the ceiling) inside a 5×5 z8 ring (~750 km, past the horizon), both
  bent by Earth's curvature. Night is NASA's VIIRS radiance (GIBS, capped at z8) through aero-2's
  luminance knee as a faint glow, and as a mask that shows the real imagery warm under lit
  districts. The far ring sinks 3 km under the detail patch (z8's coarse peaks overshoot z10's in
  the mountains). Textures upload from JPEG blobs, so no CPU canvas outlives boot;
  `scene.clearCachedVertexData()` drops the mesh copies after build.
- `src/world/ground/maps.ts` — the maps baked from those tiles, pure canvas in, canvas out: night ground
  (VIIRS × imagery × road mask × noise), light dome (haze), water mask, far-ring town lights, the
  imagery crop trees sample, roads painted into the imagery, the tiling detail map.
  `src/world/ground/mercator.ts` is the one home of the tile grid both read. Code copied from aero-2 (so aero-3 builds
  alone) lives beside its one user: `cabin/qr.ts`, `world/sky/star-catalogue.ts`.
- `src/world/ground/trees.ts` — low-poly crowns, cones and bushes in clumps of 1-6 wherever the imagery within
  5 km of the pin reads green, tinted by that pixel: thin instances, a draw call per shape
  (`?trees=0` to skip).

**`src/world/city/`** — what people built: buildings, every light, the night haze.

- `src/world/city/buildings.ts` — OSM footprints extruded at boot into one white mesh (an architect's model:
  painted facades, window grids and glass tints aliased into dark specks from cruise height),
  a shade off white per building, roofs a touch darker; rooms lit in runs at night from one
  emissive texture. Lit-window points on buildings 12 m and up, and one house light on 60% of the
  rest (villa districts like the Palm's fronds were dark). It carries a baked ambient-occlusion
  lightmap (UV2, `useLightmapAsShadowmap`) so walls darken toward the street, and a generated
  normal map that recesses every window on the lit-room grid (mipmaps flatten it with distance, so
  it reads as relief close in and never aliases). Moonlight reaches the buildings and the ground.
  Small buildings: a lit house's door wall maps onto a lamp-pool cell of the lit-room texture
  (bright at the foot, gone by the eaves), and 20% of small roofs onto a soft roof-pool cell. Same
  texture, same draw call; those two cells are flat in the normal map. Not 3D Tiles on purpose — that format
  earns its traversal cost for photogrammetry, not boxes. Fetch with
  `python3 ../aero-2/tools/fetch-buildings.py <place> --lat <pin> --lon <pin> --radius 13000 --max-features 40000 --out .`
  (the pin from places.ts; 13 km covers the orbit, and the cap keeps the biggest footprints).
  Terrain: `bun tools/fetch-terrain.ts [place]` fills each place's near z10 and far z8 terrarium
  tiles from AWS Open Data; without the far ones the far ring is flat and its sea goes unpainted.
- `src/world/city/lights.ts` — every light is a single point from map data, in three groups: street lamps
  every 32–55 m along the road pack (`../data/roads`), with only a share of each class lit (back
  streets 50%), dark stretches where the road's own 1D noise dips, and per-lamp brightness jitter; building lights, one per ~3,000 m² on 45% of flat
  roofs and a few lit windows on walls of buildings 12 m and up (city/buildings.ts); and far-ring towns
  from bright NASA VIIRS pixels past the roads (ground/maps.ts). One additive point cloud on a small
  shader: each light fades and reddens toward the horizon and twinkles faintly. Mix: sodium 65%,
  warm white 15%, white 10%, red 5%, blue 5%. The HUD's Lights panel sets each group's gain and
  the bloom live. `GlowLayer` blooms the lamps and the buildings' lit windows, at night only.
- `src/world/city/haze.ts` — the amber murk over a lit city: one additive sheet 450 m up carrying ground/maps.ts's
  light dome (VIIRS downsampled into a blur, kneed so only the city domes, × fbm noise from math.ts).
  Gain = Haze slider × darkness ÷ exposure.

**`server.ts` + `src/ops/`** — the operator side: the wall, fleet health, `/admin`.

- `server.ts` — `Bun.serve` with HTML-import bundling and `{ dir }` tile routes. No Vite, no SvelteKit.
- `server.ts` fleet: `/api/status` carries `fps` (the page POSTs `/api/fps` from loopback every 30 s)
  and `commit` for `deploy/pi/health-check.sh`; `/api/fleet/heartbeat` takes its heartbeat (bearer
  `AERO_FLEET_TOKEN`, fail-closed; dev loopback open) into an in-memory table `/admin` shows,
  headed by `fleet.ts` `rollUp` (live panes only: count, hottest, throttling, average fps).
  `src/ops/kiosk.ts`: the same 30 s tick posts fps, reloads a visible page that drew no frame
  (through `recover()`'s budget) and polls `/api/thermal` to shed pixels on a hot Pi.
  `src/cabin/credits.ts` is the one attribution list: the blind (while down) and `/admin`'s footer.
  The page's last thrown error (window errors, unhandled rejections, a lost GL context) goes to
  `/api/error` on its own server (loopback only), rides `/api/status` as `lastError`, and
  health-check.sh carries it in the heartbeat ahead of the journal line: `/admin`'s note column is
  how a dark pane is diagnosed without ssh.
- `src/ops/live-weather.ts` + `/api/weather` — Open-Meteo through the server (aero-2's port): the
  wall server holds one cache (0.1° cell, 10 min fresh, stale to the hour, 64 cells), and every
  pane fetches it once per visit, at boot, from the wall origin — the reading APPLIES at the visit
  boundary, never at a fetch-resolve second. URL > wall > live > today (a pinned visit never asks).
  Offline is the premise: stale serves, nothing serves 503, the daily static stands. No mid-slot
  re-roll: the clouds are built once per visit, so live weather is per-visit by construction.
- `src/ops/wall.ts` + `/api/wall` + `/admin` — what an operator pushes to every pane: place, weather,
  clock (null = default). The server keeps it in `WALL_FILE` (`./data/wall.json`, written via a
  rename); `POST` needs `Authorization: Bearer $AERO_ADMIN_TOKEN` and is off (503) without one.
  Panes read it at boot (2 s timeout, then none) from `?wall=<origin>` or their own server, poll
  every 5 s, and on a new version lower the blind and reload on its `applyAt` second (10 s ahead).
  URL params beat the wall. Panes take `?role=left|center|right` (±24°).
  A push may also carry the six gains (street, building, far 0-2; haze, glow, volume 0-1), which
  REPLACE the pane's defaults (never multiply; a lone pane's sliders still edit them), and media.
  And `alt` (500-15000 m above ground, the pin `?alt=` makes; the clearance floor still clamps)
  and `scale` (1-3, the hardware scaling level `?scale=` sets; 2 is half the pixels): both read at
  the reload a push causes, both behind the URL knob. Scale is the remote perf lever for the Pi
  cutover. `PRESET_SUN` names a sun height for 'Golden hour' (6°, setting) and 'Alpine dawn' (-2°,
  rising); /admin solves today's hour for it at the place (`ephemeris.ts` `hourAtSunElevation`),
  falling back to the preset's clock when the sun never gets there. /admin also lists each role's
  URL on this wall's LAN address (from `/api/status` lan + port).
  And a `mode`: null flies; `blind` holds every blind down (place, time, credits); `standby` is black
  glass. Both draw one frame then only the blind's clock, silence the sound and the clip, and keep
  the render loop counting so the stall watchdog sees a live page. Standby skips the slot reload.
- `src/ops/media.ts` + `/api/media` + `/media/*` — the operator's music and clips in `MEDIA_DIR`
  (`./data/media`, gitignored; `AERO_MEDIA_MB`, 50). `GET` lists, `POST` uploads one multipart file
  (token-gated like the wall; length refused before the body is read; bare names, mp3/wav/ogg/mp4/
  webm only). A push carries at most eight store IDs, never URLs (the 1024-byte budget), and every
  pane resolves them against the wall origin it polls: the file lives on the uploader.
  `src/cabin/media.ts` plays them: the playlist on the centre or lone pane only (replacing the drone,
  skipping missing files), a clip muted on every pane under the blind.
- Lone pane only (no `?role=`; `cabin.ts` `loneGestures`): pull the open blind down past 120 px to
  depart for another city (a `?place=` reload), tap the glass for the clock (the sky's hour, so a
  pinned clock shows its own time; a solid pill, no backdrop-filter). A tap outside the admin QR
  dismisses it. A wall pane never acts alone: only /admin, with the token, changes shared state.

## Naming

Scene builders are `create<Noun>()` and main.ts binds the plain noun: `createTerrain` → `terrain`,
`createBuildings` → `buildings`, `createLights` → `lights`, `createClouds` → `clouds`, and so on.
Pure models are `<noun>At` / `<noun>For` (`sunAt`, `moonAt`, `slotAt`, `weatherFor`, `pathFor`, `planFlight`). Babylon mesh and
material names (`near`, `far`, `buildings`, `streetlights`, `stars`, `moon`, `trees`) are a contract:
`tools/smoke.ts` asserts them and main.ts looks some up by string. Rename exports freely, never those.

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
  the dusk sky white. It includes the lamp points, the buildings (lit-window halo) and the wing
  (its unlit meshes occlude the bloom), never the ground.
- **A StandardMaterial adds its emissive texture at `texture.level`**, not × `emissiveColor`: the
  haze sheet's gain is the level, or it washes the city flat orange.
- **An `ALPHA_ONEONE` material at `alpha = 1` draws in the opaque pass**, where the blend mode never
  applies: the haze sheet painted a black square over the near ground from dusk on. Additive
  materials set `alpha = 0.999` (city/haze.ts, sky/stars.ts).
- **The ground's atmosphere-plugin PBR takes a light ~30× weaker than plain PBR.** The moon light is
  scoped to the ground meshes (`includedOnlyMeshes`) so the wing does not blow out.
- **120k additive points sum to a white sheet**: per-lamp alpha is ~0.2.
- **The twilight exposure lift multiplies emissive too**, so emissive gains are divided by it:
  `?carpet=1` means 1 at night, not 9.

Units are metres, y up, x east, z north.

## Run

```sh
bun install
bun run dev                 # http://localhost:3300/?place=hyderabad&clock=10
bun test && bun run check   # TypeScript 7
bun run smoke [places…]     # every place day + night in Bun.WebView (~4 min), checks every layer built, screenshots to dist/smoke/
bun run compile             # dist/aero-3: one linux-arm64 binary, page bundled in
```

On a Pi: `sudo bash deploy/pi/install.sh --app aero-3 --role left|center|right --wall
http://<centre-pi>:3000` (the centre Pi holds the wall; `/admin` there).

**Cutover runbook, one Pi first** (phase 5 has no numbers yet; aero-1 on a Pi 5 is 2-3 fps, so the
first aero-3 pane is the measurement): 1. `bun aero-3/tools/ship-pack.ts <kiosk-user>@<pi>` (the
data, ~320 MB, resumable). 2. On the Pi, `install.sh --app aero-3 --role <role> --wall
http://<centre-pi>:3000`; it keeps the tokens, writes `AERO_APP_SUBDIR=aero-3` and the kiosk URL.
3. `curl http://<pi>:3000/api/status`: `ok`, `page ok`, `data` lists imagery/terrain/lights/
buildings/roads/models/media. 4. Open `/admin` on the centre Pi from a phone: the pane's heartbeat
row appears within five minutes with an fps; push `scale 2` if it is under 10. 5. The other two
panes only after that number reads well. The updater then tracks `release` as before, installing
the CI prebuilt for each sha. The data folders the server
finds at startup are served, the rest 404, so a Pi without a pack still boots. Measure with
`tools/pi-bench.ts` (usage in its header). Or run the binary from a directory where `../data/tiles/sentinel2`,
`../aero-2/data/tiles/terrarium` and `../aero-2/data/tiles/viirs` exist, or set
`IMAGERY_DIR` / `TERRAIN_DIR` / `LIGHTS_DIR`; buildings come from `./data/buildings`
(`BUILDINGS_DIR`).

## Measuring

`aero-2/tools/frame-cost.mjs` works on any page with a canvas. Pin the scene:
`?place=hyderabad&clock=10&hud=0`. Also `?scale=2` (half resolution), `?gpu=webgpu`,
`?yaw=<deg>` (pane offset), `?lamps=1` (lamp gain), `?lift=8` (twilight exposure), `?clouds=0..1`
(cover), `?glow=0` (no bloom), `?debug` (exposes `scene`, `camera`, `terrain`, `atmosphere`, `aim` for ablations). Compare against aero-2 on the same Pi.

**The Pi bench, on site** (`tools/bench-kit.ts`): no Bun, `bun install` or checkout change on the Pi.
1. `bun aero-3/tools/ship-pack.ts <kiosk-user>@<pi>`: the data, once (~390 MB).
2. `bun aero-3/tools/bench-kit.ts <kiosk-user>@<pi>`: builds the server and `pi-bench` for
   linux-arm64 plus `run-bench.sh`, copies them to `~/aero-bench`.
3. `ssh -t <kiosk-user>@<pi> bash aero-bench/run-bench.sh [--quick]`: pauses the kiosk and the
   updater timer, serves aero-3 on :3300 from `/opt/aero-window/aero-3` (`AERO_DIR=` to change),
   benches in the kiosk's Chromium flags, restores both on exit, writes `bench-<host>-<date>.txt`.
   Ssh as the kiosk's user: the X server (xinit, no cookie) only takes that user's windows.
Rehearsed on a Mac (compiled server and bench, headless Chrome on :9455): runs end to end.

## Roadmap

Each phase is small and lands with screenshots, `bun test`, and `bun run smoke`. Plain TS over
Svelte; copy aero-2's pure modules where they exist, rewrite its components.

1. **Window** — done: flight, day character, blind, rim, rain, white buildings, house lights.
2. **Wall** — done: pane roles, the operator push, `/admin`, error-reload budget.
3. **Cabin** — done: the wing, the cabin drone, the moon, the ride (`flight/motion.ts`), the Milky
   Way (`sky/stars.ts`, 9k faint points in the star mesh), the cabin volume as a wall gain, a mood per
   place (`places.ts` MOODS), a pushed clip on the wall clock (`cabin/media.ts` `playheadAt`), live weather (Open-Meteo through the
   server, applied per visit — `ops/live-weather.ts`; only when the fleet has internet, which is
   exactly the offline-first premise: no fetch, the daily static stands).
4. **Ship** — done: aero-3 fits the existing deploy contract unchanged (`bun run build` writes a
   two-line `build/index.js`, `bun run serve` runs it, `/api/status` answers the updater's probe),
   so `aero-app.service` and `aero-updater.sh` need no edits. `install.sh --app aero-3 --wall
   http://<centre-pi>:3000` stores `AERO_WALL_URL` (validated, kept across re-runs) and the kiosk
   URL carries `&wall=`. CI's `aero-3` job gates `release`. Thermal shedding reads
   health-check.sh's `/run/aero/thermal.json` via `/api/thermal`. `bun tools/ship-pack.ts <user@pi>` rsyncs
   the ~320 MB aero-3 reads (Sentinel-2 z7/8/11/12, Terrarium z8/10, VIIRS z8, roads, OSM
   buildings), restarts the app and checks `/api/status` `data` lists every route. CI packages
   `prebuilt-aero-3` (build/ + production node_modules, 17 MB) like aero-1/2, so a cut-over Pi
   installs the CI build instead of a `bun install` of Babylon over the wall LAN; the updater reads
   the Bun floor from package.json `engines.bun` (1.4.0, what CI pins). Cutover runbook: Run, below.
5. **Pi gate** — `frame-cost.mjs` on a Pi 5 for every place, day and night, before phase 6.
   Levers if it is slow: `?caps=1` (built, off by default: `capFootprints` keeps 25k footprints
   by distance then area, `thinStreetLamps` 150k street lamps; measured, the building cap ends
   the city 3.7-5.7 km from the pin under a 9-13 km orbit, so an area-first cap may be the
   better shape),  lower the glow's texture ratio, haze off, `?scale=1.5`, WebGPU.
6. **Content** — presets done (`ops/wall.ts` PRESETS: five named scenes that fill `/admin`'s form).
   Left: more places (a pin, an orbit radius, a buildings pack), after the Pi numbers. Admin QR done: hold the glass 15 s for the wall Pi's `/admin` (`src/cabin/qr.ts`).

## Not built yet

Reviewed against aero-1 and aero-2 (2026-10-23) and left out on purpose:
- **Authored scenario routes** (aero-1's 21 waypoint paths): a content project that changes the
  flight model's shape, not a port. The seeded orbit is the model until the Pi numbers are in.
- **More places** (Pacific, Sahara, above the clouds): each needs its own imagery, terrain and
  lights pack; none exists. Add with `tools/fetch-terrain.ts` and a Sentinel-2 pull, after Phase 5.
- **Destination whisper, oval frame toggle, flight readout panel, boot lockup**: the blind already
  reads "here → next", the rim is the frame, the HUD is the readout, the closed blind is the boot frame.
- **Engine vibration** (aero-1's 7 Hz sines): at the Pi's frame rate it aliases to noise.
- **Downtown pass** (aero-2's 2-min low loop over the pin): the clearance floor is 2 km over the
  highest ground and the cloud base is 1.3-2.5 km, so a low pass flies into the sprite deck. Needs a
  deck-aware descent and a real-Chrome look first; the low cruise band (3.5 km, a quarter of visits)
  is the near view until then.
- **Screensaver slideshow, look controls, minimap, destination card, night CSS grade**: aero-2
  surfaces for a lone pane or a MapLibre workaround; the grade wants a side-by-side before porting.
- **Dusk sun glare** (aero-2's CSS radiance): the atmosphere already paints the dusk horizon band,
  and a screen-space bloom would have to track the sun across three pane yaws. Not the small port
  it looks like. **Glass reflection and night vignette**: already here (`#frame::before/::after`).
- **Per-device targeted push, operator quality mode, kiosk telemetry panel, hotkeys, wiki**: the
  wall is one server and roles already differ; the `scale` push is the quality lever; `?debug`
  and /admin's fps column are the telemetry.
- **WiFi reset route** (aero-1/2): a brick risk whose portal guard aero-1's own notes say was never
  installed; the shared `deploy/` owns WiFi. **Memory-pressure guard**: a journal line, not a fix.
- **In-visit sky drift** (aero-1's tickRandomize): the ride and the cloud motion already animate
  the view; clouds are built once per visit by design (live weather applies per visit).
- **USB media import** (aero-2): worth it only at a site without internet; asked, not built.
- **Admin OTA trigger, mDNS discovery, device bindings, slideshow mode, wing alignment knobs**:
  operator tooling the shared updater, the centre-Pi wall and `?role=` already cover.

The Phase 5 Pi measurement, before more layers: Dubai is 1.1M building vertices and ~300k lights. Add them only
after the Pi numbers say this stack is worth growing.
