# Aero 2 Architecture

Three Raspberry Pi 5s stand side by side behind one window. They exchange
nothing. Everything below follows from that.

> MapLibre is the canonical renderer as of 2026-08-25. See
> [ADR-005](../../docs/ADR-005-aero-2-threlte-renderer.md).

## 1. The shape

Two feature slices under `src/lib/`, plus server-only tile streaming:

```text
settings/   the config SSOT and the operator drawers
display/    the kiosk window — world/, flight/, cabin/, media/
server/     the offline tile proxy; imports nothing from the two above
```

**There is deliberately no file listing here.** The previous version of this
document enumerated the tree, and by the time anyone read it the tree had
`Relief.svelte` and `Air.svelte` in it — files that were renamed a long time
ago — while `Clouds`, `Blind`, `RainGlass`, the media stage and the director
were missing. A diagram that has to be hand-updated on
every rename is a diagram that will be wrong, and a wrong map is worse than no
map. `ls` is accurate; this file holds the rules `ls` cannot show you.

Naming, so `ls` reads well:

- **`.svelte.ts` means the file holds runes.** `settings.svelte.ts` and
  `display.svelte.ts` do; the pure maths in `flight/` and `world/` does not.
- **No folder stuttering.** `world/Stage.svelte`, not `WorldStage.svelte`.
- **Each slice has one parent component** — `Display.svelte`, `Settings.svelte`
  — that owns its internals.

## 2. The invariants

Ten rules, and all ten are now enforced by something that fails.

Three of them (#3, #6, #7) were marked "—" for most of this project's life.
All three were TRUE the whole time, which is the most expensive state for a
rule to be in: it reads as settled, so it gets cited in review and relied on in
design, while nothing stops the commit that ends it. This repo has recorded
that exact shape twice already — "no import cycles" was documented while `sim`
and `stage` imported each other, and determinism was claimed in a docstring by
a cloud deck integrating frame deltas in three places. An unenforced invariant
is an aspiration; these three are now checks, each verified by breaking the
code it covers and confirming the run goes red.

| #   | Invariant                                                                                  | Enforced by                                                                                    |
| --- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1   | No import cycles                                                                           | `tools/check-cycles.mjs`, in `check` and `test`                                                |
| 2   | The world is a pure function of (wall clock, place, `daySeed`)                             | `tests/integration.test.ts` — scans for `Math.random` and for `+= dt`                          |
| 3   | Context DI: `createDisplay()` at the root, `useDisplay()` below                            | `tests/regressions.test.ts` — exactly one call site may construct the model                    |
| 4   | The pure simulation modules import no renderer                                             | `tests/integration.test.ts`                                                                    |
| 5   | All tiles flow through `/api/tiles`; `server/tiles.ts` is the only file naming an upstream | `tests/tiles.test.ts`, `tests/regressions.test.ts` — templates AND every file under `display/` |
| 6   | The 3D world runs inside `<svelte:boundary>`                                               | `tests/regressions.test.ts` — a WebGL throw must degrade the pane, not blank the page          |
| 7   | No barrel files (`index.ts`)                                                               | `tests/regressions.test.ts` — no `index.ts` anywhere under `src/`                              |
| 8   | A renderer projects the pose; it never sources it                                          | `tests/regressions.test.ts` — same second ⇒ same pose, on a cold model                         |
| 9   | Every page route renders, and the kiosk is actually flying                                 | `tools/smoke-routes.mjs` (`bun run smoke`)                                                     |
| 10  | A dataset the server offers has a renderer that asks for it                                | `tests/regressions.test.ts` — every `/api/<kind>/[city]` has a consumer under `display/`       |

**#2 is the product.** No accumulated `dt`, no per-process epoch, no unseeded
randomness anywhere the window can see. Both failure shapes have bitten:
the director rolled an unseeded 2–5 minute interval AND integrated a clamped
`dt`, so three panes sat over three different cities; the cloud deck integrated
frame deltas in three places while its own docstring claimed determinism. The
fix in both cases was the same — derive from the wall clock, remember nothing.
Per-pane randomness is allowed only where it is genuinely per-pane and cosmetic
(cabin audio, rain on this pane's own glass), and that list lives in the test.

**#4 is narrower than it sounds, on purpose.** It does not say "only `world/`
touches MapLibre" — `flight/MiniMap.svelte` renders a map and needs one. It
says the _pure_ modules stay pure: `flight-path`, `view`, `parallax`,
`atmosphere`, `sun`, `settings`, `locations`. That layer is what a second
renderer reuses unchanged, and what the suite can exercise without a GPU. One
renderer import in any of them and a swappable engine quietly stops being
swappable. `import type` is exempt — it is erased at build time, so a renderer
bridge can name its engine's types and still cost the pure layer nothing.

**#8 is what makes #2 hold at the edges.** `AeroDisplay.advanceTo(wallSec)` is
the only place a pose comes from. Everything downstream — the stage, the
clouds, the wing, the rain, the HUD — reads `display.view` and draws it. The
moment a component reaches for `Date.now()` itself it has become a second
clock, and two clocks on one pane cannot be made to agree by making each of
them deterministic: the storm's lightning ran its own RAF sampling its own
`Date.now()`, so the flash landed on a millisecond the drawn frame was never
derived from. Determinism is a property of the graph, not of each node.

The one thing a renderer is allowed to source is terrain, because only it has
the DEM — and that is exactly why the clearance policy lives in
`world/clearance.ts` and reports whether the sample was real. See the
diagnostics readout in the admin drawer; a `0% sampled` reading means the
window is flying over a mean, not over ground.

**#9 is the only check that loads a page.** Everything above reasons about
source or calls a function; none of it mounts a route, so a component that
throws during init is green in `check`, green in the suite, and serves an empty
`<body>` with a 200. The parent repo shipped `/admin` in exactly that state with
489 passing tests. `curl` cannot see it either — `ssr = false` means the static
shell returns 200 whether or not the app boots inside it, so the guard on
`/admin` has to be checked on `__data.json`.

It also asserts the pose CHANGED between two samples, because a frozen window
is the failure that survives every other check: a stalled render loop leaves a
live canvas holding its last frame at a plausible altitude with a clean
console, which is a photograph of an aeroplane window and indistinguishable
from the product in a screenshot. Both assertions were verified by breaking the
code they cover — an init throw in `/admin`, and a disabled
`requestAnimationFrame` in `Stage` — and confirming the run goes red.

`bun run smoke` runs the built server with `NODE_ENV` UNSET, which is the Pi's
own configuration: the dev-only remote tile fallback is off, so the run sees
the real offline archive instead of quietly proxying NASA and passing on any
machine with internet.

That sentence is also what exposed the `/admin` guard. It read
`NODE_ENV === 'production'` — open by DEFAULT, closed only on one string — so
either this line was wrong or the cockpit was public on every unprovisioned
device. It was the latter, verified against the built server. The gate is now
`AERO_ADMIN_UI=1`, fail-closed like every other one here, and smoke asserts it
with the DEFAULT env rather than forcing production, which only ever tested
the configuration that was already safe.

**#10 is the packaged-and-inert rule.** `data/roads/` was 46 MB of OSM
geometry, served by `/api/roads/[city]` with ETags and covered by its own
endpoint test, and drawn by nothing — no component under `display/` ever
referenced it. Every part worked except that no one asked, so nothing could go
red: the endpoint answered 200, the suite passed, the health check does not
look at `data/`, and the kiosk drew a city with no lights on it and no error.
This is `REQUIRED_TILE_ASSETS` pointed at the GeoJSON endpoints — assert NAMED
assets, never count directories. It is a source scan, so it strips comments
first: the first version passed against a deliberately broken fetch because the
test's own docstring named the path.

Roads now draw as vector night lights, which is the same fix twice over: VIIRS
caps at z8 (~468 m/px at lat 40), so the raster blurs exactly as the window
descends, and a road network is the shape of city lighting from the air.
`tools/probe-layers.mjs` is what proves it paints — smoke would stay green with
the source 404ing or the layer at zero opacity.

**#6 and #7 are unenforced.** Both were violated within a day of being written
down: `Clouds` ran its own WebGL context outside the boundary until 2026-08-26,
so a Three.js context loss took the page down while the identical MapLibre
failure was caught and offered a retry. If either matters enough to keep, it is
a three-line source scan alongside the two already in `integration.test.ts`.

**#9's blind spot was the operator UI, and it cost two bugs.** Every check in
this repo reaches a page by URL, and the settings drawer is not reachable that
way — it is component state behind an `s` keypress. So the entire panel sat
outside `check` (a runtime throw is invisible to it), outside the suite
(nothing mounts it) and outside smoke (which loaded `/` and pressed nothing).
Both failures found there were of the shape this document keeps naming: the
kiosk rendered perfectly, and the operator surface was broken one keystroke
away. `smoke` now presses `s` and `a` and asserts each drawer rendered its own
contents.

**A live value is not a wired one.** `cloudDensity` was a `$derived` read by
exactly one consumer that was not reactive — `buildCloudDeck()`, called once
from inside a texture-loader callback — so the deck was fixed at mount and the
slider moved nothing. Reads inside an async callback are outside the
attachment's tracking scope AND outside any effect: no rune, no dependency, no
re-run. When an attachment owns a long-lived resource, the resource's lifetime
and its CONTENTS are different lifetimes and need different mechanisms; taking
the value as an attachment argument would rebuild the WebGL context on every
slider tick. `tools/probe-layers.mjs` measures this the only way it can be
measured, by driving the real input and counting what changed.

## 3. Engines

**There is one.** MapLibre GL, mounted unconditionally by `Display.svelte`.

There were two until 2026-08-31. `config.engine` switched between MapLibre and
Cesium, and Cesium came in through a runtime `import('cesium')` so the engine
you were not running cost nothing to boot. It was deleted rather than fixed:
no terrain provider was ever set, so it flew the regional mean — below the
local peak at five of eleven locations — and it named two upstream tile hosts
directly, which invariant 5 forbids and the scan of the day could not see.
`../docs/ADR-005` proposes Threlte as the eventual second renderer; Cesium was a
third option that was nobody's plan.

What survives the deletion is the shape, and it is worth keeping if a second
renderer arrives: the bridge owns the engine, `import type` keeps the pure
layer clean, and a source scan asserts the new stage advances the clock —
mounting a stage is not the same as driving one.

`three` — the cloud deck and the wing — is a static import and is always in the
main chunk. That asymmetry was not a decision; measure it on a Pi before
treating it as one.

## 4. Layers, outside in

```text
Stage                  the world              inside <svelte:boundary>
Clouds                 the deck               inside <svelte:boundary>
Wing                   the airframe           z 5
RainGlass, Frame, Blind  the cabin            z 10
MiniMap, Hud           instruments
Settings               operator drawers       z 100 (a snippet, injected)
```

Component visibility is gated in exactly one place: the config knob the
component itself reads. `Display.svelte` briefly had five boolean props
duplicating those knobs, of which its single caller passed one.

## 4b. The night stack, and why order is physics

Layer order in MapLibre follows MOUNT order, so `Stage.svelte`'s child order
is the compositing order. It is not cosmetic:

```text
gibs / sentinel2   the photograph          shaded by hillshade
hillshade          how the ground faces the sun
viirs              emitted light           NOT shaded  (NightLights.svelte)
roads              emitted light, sharp    vector, below the z8 VIIRS blur
buildings          extrusions
```

The rule that fixes the ordering questions is **reflected vs emitted**.
Hillshade models how a surface reflects sunlight, so it belongs over the
photographs, which are exactly that. City lights are emitted and do not dim
because the slope under them faces away from a sun that set hours ago. VIIRS
sat inside `Ground` and therefore under the hillshade, which removed 15% of the
luminance of every lit city — unevenly, according to terrain invisible at
night. That is why `NightLights.svelte` is its own file: the split is the fix,
and merging it back into `Ground` would silently undo it.

Two layers share the `night ** 1.5` ramp on purpose. `roads` sharpens `viirs`
where VIIRS runs out of resolution, and two lighting layers on different ramps
read as one of them lagging.

## 4c. Weather is a light model, not an overlay

`weather` used to reach the window twice: turbulence, and droplets on the
glass. Everything photometric was identical between `clear` and `storm`.
`weatherLightLoss` is now the one scalar behind all of it, and the three things
it drives are the three things cloud does to light: it **dims**, it
**flattens** (diffuse light casts no shadows, so the hillshade goes with it),
and it **desaturates**.

Two lessons from getting it wrong first:

- **Cloud colour must be relative to the current light.** A fixed grey is the
  obvious implementation and it measured backwards — it is used as fog, fog
  thickens with the weather, so at storm strength the constant was most of the
  lower frame and _brighter_ than the night scene it was dimming. A storm came
  out 32% brighter than clear. `cloudedRgb` desaturates toward the colour's own
  luma and multiplies, so it is circadian for free and can only subtract.
- **Measure by row band, with the clock frozen.** A frame mean averages a
  collapsing sky against a foreground that correctly stays lit, and reports
  "no effect". And without freezing `Date.now`, the sun moves between samples,
  so the measurement is of sunset rather than of weather.

## 4d. Time, weather and the pass: everything is a function of the wall second

- **Rotation.** `DWELL_SEC` (600 s) slots; the day's order of `ROTATION` is a
  seeded shuffle (`director.svelte.ts: orderFor`), so the sequence differs by
  day and agrees across panes. The blind closes at every slot boundary
  (`blindClosedAt`), and every boundary is a new place.
- **Weather.** A pinned `?weather=` or a pushed non-clear weather wins;
  otherwise `scheduledWeather(wallSec)` (`flight/view.ts`) gives one slot in
  six overcast and one in six broken cloud. Consumers read `display.weather`,
  never `config.weather`. Camera params take the frame's weather from the
  second being computed (`weatherAt`), so a fresh pane equals a running one.
- **Downtown pass.** One pose whose loop scale, altitude and clock warp follow
  the blend (`downtown.ts`): spiral in 30-120 s, downtown 120-180 s, out
  180-270 s. The altitude gate is read once per slot at the pass midpoint;
  the thread clock is the closed-form integral of the ramp and the big loop
  flies the same clock, so nothing jumps when the pass lets go.
- **Composition per place.** `Location.moodFor(id)` is the painter's table:
  pitch bias, deck offset, coverage bias, loop direction, dust, night glow.
  Render-path biases, never config writes.
- **Motion.** Turbulence is two slow octaves plus three slot-seeded bumps on a
  20 Hz grid (exact across panes). Clouds are fixed to the ground and stream
  past (displacement from `view.lat/lon`, per-sprite wrap with an edge fade);
  the deck seen from above is a CSS band in `Sky.svelte`; the celestial
  overlay (stars, moon, haze band) rolls with the world by `WORLD_ROLL_GAIN`.
- **Gestures.** `cabin/glass-gestures.ts`: drag nudges azimuth/pitch (pane
  knobs, this pane only), double-tap toggles `GlassClock`. Chrome excluded by
  selector.

## 5. Known-sharp edges

- **Bank sign is not self-evident; check it geometrically.** `bankAt` negated
  its own result, so the aircraft banked AWAY from every turn. `headingAt`
  returns a COMPASS bearing (clockwise-positive), so a left turn gives a
  negative rate and the negation made it right-wing-down. It reaches the
  passenger three ways at once — wing model, sightline pitch, cloud counter-
  rotation — so nothing looks broken frame to frame, it just never feels like
  an aircraft. The suite had a test named "banks INTO the turn" that was green
  throughout, because it only asserted the two directions DISAGREE, which an
  inverted sign also satisfies. Verify with the 2D cross product of successive
  velocity vectors on the real ground track: positive is counterclockwise, and
  owes nothing to any bearing convention.
- **The sightline must never cross the horizon.** Bank was folded into pitch
  additively (+/-15.3 deg against a default -10), so every turn drove the
  effective pitch positive and the 0.5 deg depression clamp caught it — pinned
  for 28.6% of each roll cycle. Depression and range are related by a tangent,
  so the visible cost was distance: the look-at point ran from 10 km to 516 km
  at 4,500 m AGL, panning from a city block to half a continent and back, over
  ground no tile pack covers. A real window holds a roughly constant slant
  range while the ground rotates past it. The swing is a RATIO now, which
  cannot cross zero; `tests/display.test.ts` asserts the property rather than
  the formula, so a re-tune is free but cannot leave the world.
- **Tile URL shape is load-bearing:** `/api/tiles/xyz/{layer}/{z}/{x}/{y}.{ext}`.
- **"Packaged and inert" is this repo's recurring failure, four times over.**
  `data/roads/` (46 MB, served, drawn by nothing), `data/tiles/water/` (packs,
  serves, mounted by nothing), `/api/internal/thermal` (endpoint + decoder +
  policy + writer, consumed by nothing) and `/api/fleet/heartbeat` (records and
  summarises the whole wall, rendered by nothing). Every one is present,
  plausible and inert: each part works in isolation, so no check can go red,
  and the gap is invisible to `check`, to the suite and to smoke. **When adding a producer, add its consumer in the
  same change** — a docstring in the present tense is a claim, and
  `/api/internal/thermal`'s said "the display polls this" for as long as it took
  someone to look. All four are wired as of 2026-09-04.
- **Clock sync is correctness telemetry, not health telemetry.** Pose, sun, the
  director's slot and a wall push's `applyAtWallSec` are each derived per pane
  from `Date.now()`; that only agrees while the clocks do. An unsynced Pi flies
  a different part of the orbit and lights a different hour while every other
  number reads green. The heartbeat carries `clockSynced` and `/admin` counts
  it. Note the tri-state: health-check sends `-1` for "no timedatectl", which
  must stay UNKNOWN rather than collapsing to "drift".
- **Water is a GLINT, not a tint.** `data/tiles/water/` is a Sentinel-2 Scene
  Classification mask (class 6), white on water and transparent elsewhere,
  because MapLibre draws a photograph of water where Cesium drew a surface — and
  a raster grade cannot recover that. `Water.svelte` drives its opacity from
  `specularGlint`, so it is bright only when the sun is LOW and the pane is
  pointed at it, and unmounted otherwise. That per-pane response is the point on
  a wall: the three panes face different bearings, so one can look across a
  blazing lake while another sees the same water dark. It shares
  `facingSunAmount` with the sunward haze deliberately — two components
  deriving the same specular geometry independently is how a sheen and a haze
  end up disagreeing about where the sun is.
  Only `chicago_midway` is packed, to z11 (the manifest, not the tool's z13
  default — z12/z13 are empty and declaring 13 would 404 every tile on
  approach). `_water-work/` is 12 MB of build intermediates, gitignored and
  reported under `unused`.
- **A present archive is not a working one.** `terrarium/` is build INPUT for
  `pack-pmtiles`; the kiosk never requests it. A pack holding only terrarium
  renders a white sheet, and the health endpoint called that `ok` for as long
  as it counted directories rather than asserting named assets. If you add a
  raster source, add it to `REQUIRED_TILE_ASSETS` in `server/tiles.ts` or
  nothing will ever tell you it is missing.
- **The packager must write the extension the client asks for.** GIBS ignores
  the extension in the request, so fetching `viirs` as `.jpg` returns 200 and
  writes a valid PNG at a path the server never looks up: "542 downloaded, 0
  failed", 4,534 dead files, and a kiosk that 404s on every one. `LAYER_EXT` in
  `download-tiles.ts` is the SSOT, and `integration.test.ts` asserts it against
  `tileTemplates()`.
- **A kiosk-visible tile radius is ~1,250 km, not ~50.** At cruise altitude on
  a globe projection the camera reaches most of a continent, so per-location
  corridors packed at a city radius leave holes that only appear at certain
  points in the orbit. Measure it — drive every location and log 404s — rather
  than reasoning about the bounding box.
- **Two colour photographs, deliberately.** `sentinel2` (packed to z13, 19 m/px,
  cloudless, per-location boxes) is laid over `gibs` (z9, 306 m/px, global,
  ~40% cloud). The
  overlay is what the window shows wherever it is packed; MODIS is the
  everywhere-layer beneath it, so a Sentinel-2 gap degrades instead of punching
  a hole. This is NOT the USGS/NAIP mistake that was deleted in 2026-08: that
  layer was a second photograph at a resolution the screen could not resolve.
  A 16x resolution gain is a different proposition.
- **Measured against v1, which is where this came from.** The parent repo's
  Cesium build looked better than aero-2 and the renderer was not the reason —
  it drew EOX s2cloudless while aero-2 drew MODIS. aero-2's pack is now the
  larger one: 16,352 tiles to z13 against v1's fielded 755 tiles to z12
  (`data/tiles/eox-sentinel2`, 15 MB). v1's code permits z14, but only from the
  REMOTE EOX service; its local path is capped at z12 and its offline pack
  stops there. Below z8 aero-2 has no Sentinel-2 and does not need it — MODIS
  is global to z9 and covers z0-7 outright.
- **The sharp basemap costs ~3-5 fps on a slow CPU, and the pack costs 312 MB.**
  Measured, because adding a second full-screen raster layer to a Pi kiosk is
  not obviously free. A/B at the same location under 6x CPU throttling (a rough
  Pi 5 stand-in): 17 fps with the layer visible, 22 with it hidden, repeated
  three times. Unthrottled it is 60 either way.
  Do NOT read the cross-location numbers as the layer's cost — packed locations
  measured 9-17 fps against 20-24 for unpacked ones, but that gap is mostly
  terrain: Denver and Phoenix are mountainous, Dubai and the Pacific are flat.
  Only the same-location A/B isolates the layer.
  Disk: 312 MB across 7 locations, against a 4.0 GB served total that the
  3.5 GB DEM dominates. If the SD budget ever binds, the DEM is the place to
  look, not the imagery.
- **Sentinel-2 imagery is licence-critical.** The convenient source (EOX
  s2cloudless) is CC BY-NC-SA and cannot ship on a paid install; v1 uses it and
  its own `upstream.ts` flags that as an open question. aero-2 builds the same
  pixels from `sentinel-cogs` under Copernicus terms, which permit commercial
  use AND REQUIRE attribution. `remoteTileUrl` returns null for this layer on
  purpose — a remote fallback would silently proxy the non-commercial service.
- **`{z}/{x}/{y}` and `{z}/{y}/{x}` are both called "XYZ".** `WMTS_TILE_PATH`
  in `server/tiles.ts` is the authority and reads `{z}/{y}/{x}`; `gdal2tiles
--xyz` emits the other one. On a square grid the two are indistinguishable by
  eye, and a wrongly-filed pack 404s every tile while the directory looks
  perfectly plausible and the packager reports success. Three of seven
  Sentinel-2 packs shipped this way — Hyderabad served 129 requests and 0 tiles
  with a complete archive on disk.
- **Never transpose a SHARED tile tree in place.** The layer directory holds
  every location, so a transpose that walks the whole tree flips the tiles a
  previous run already put right: with three places packed, whether any given
  one worked came down to parity. Tiles carry no record of their own
  orientation, so this cannot be made idempotent — stage per-run output
  elsewhere and MOVE it in. The test that catches it computes the tile each
  pack's own centre falls on and asks for it the way the server does;
  "listed" and "licensed" checks cannot see this.
- **The ground is ~30% cloud, and no date fixes it.** `GIBS_DATE` pins a single
  MODIS day, and MODIS true colour is a same-day swath: across the z6–z9 tiles
  the window requests, the best eligible day measures ~30% near-white and most
  measure 38–54%. Swapping dates moves it a few points. If the window looks
  washed out, that is the photograph, not the haze — verified by disabling the
  fog, the hillshade, the grade, the cloud deck, the CSS layers, the terrain and
  the sky itself and finding the ground still white. The real fix is a cloudless
  COMPOSITE (EOX s2cloudless measures 4.6% on the same metric) and is blocked on
  licensing, not on engineering. See the note above `GIBS_DATE`.
- **Rate imagery across every zoom the window DRAWS.** The camera reports zoom
  ~10 at 85° pitch, but `gibs` caps at maxzoom 9 and the frame is filled from
  z4–z9 at once. Two survey passes each measured the wrong slice — z8 near a
  location centre, then z6 alone — and the first scored a day at 13.1% that is
  really ~38%. Sampling z9 for the first time also revealed coverage holes that
  every earlier sweep missed: the previously pinned 2026-06-20 has no z9 tile
  east of Hyderabad, the fielded kiosk home.
- **A timeout is not a missing tile.** The survey counted both as absent
  imagery, so a flaky network fabricated coverage gaps and scored the same day
  11/11 and 10/11 minutes apart. 404 is authoritative; everything else is
  retried and reported separately.
- **Media modes need `media-src`, and it must be declared even when empty.**
  Without the directive, `<video>`/`<audio>` fall back to `default-src` and are
  blocked silently: the element fires `onerror`, MediaStage catches it, and the
  pane renders a tidy "Media failed to load" that reads as handled absence. All
  three non-flight modes shipped 100% broken this way. Extra origins go in
  `AERO_MEDIA_ORIGINS` at build time; the defaults are empty on purpose,
  because a kiosk that needs a CDN is a kiosk that goes blank with the WiFi.
- **`raster-opacity: 0` still fetches.** A faded-out source keeps requesting
  tiles at full rate; only unmounting stops it. `Ground.svelte` gates the VIIRS
  night-lights source behind `{#if nightLightOpacity > 0.01}` for that reason —
  it used to do the same for a USGS/NAIP layer that was deleted on 2026-08-26,
  where it was worth several hundred 404s a minute outside US coverage.
- **Nothing in the deploy path delivers tiles.** The updater tracks a git
  branch and `data/` is gitignored, so the archive reaches a device only by SD
  image or by rsync after install. `install.sh` points `TILE_DIR` at
  `${INSTALL_DIR}/data/tiles` and that survives the updater's reset, so a pack
  copied once persists — but nothing copies it the first time. Same in v1;
  ADR-002 lists OTA tile delivery as an open question. This matters more now
  than it did: `sentinel2/` needs GDAL and ~7 GB of scratch to build, so unlike
  `gibs`/`viirs` a device cannot self-provision it. `tools/ship-tiles.sh` is
  the manual route: it refuses a broken pack, skips build input, and verifies
  through the device's own `/api/tiles/health` rather than rsync's exit code.
  `GET /api/tiles/health` reporting `error` is how a fielded Pi says it never
  arrived.
- **The DEM's header bbox is not its coverage, and `terrainSampledPct` is.**
  `terrain.pmtiles` is a set of per-location boxes (~±1° around each pin), but
  its header is ONE rectangle around all of them — spanning 179°W–88°E and
  16–85°N while being empty across nearly all of it. The integration test
  checks the header, so it passes whatever the archive actually holds.
  Verified 2026-09-03 and the archive is fine: the running kiosk reports
  **100% terrain sampled** at every location tested. But note how that was
  established, because two cheaper checks both lied. Probing
  `queryTerrainElevation` at hand-picked points returned 0 for the Himalayas
  and read as a packaging gap — those points were simply outside the render
  frustum, and an absent tile is indistinguishable from sea level at the call
  site. Probing right after load also returns 0, because the DEM streams over
  range requests and decodes late. The runtime counter is the only signal that
  is neither: it counts real samples against fallbacks over thousands of
  frames. Press `a` for the diagnostics drawer.
- **A DEM source without `minzoom`/`maxzoom` reads as sea level.** MapLibre
  assumes z0–22, requests tiles the archive does not hold, never decodes one,
  and `queryTerrainElevation` returns a literal `0` — indistinguishable from
  the ocean at the call site. Declare the range every time.
- **Altitude is metres above ground, and terrain is drawn at `exaggeration`×.**
  Mixing raw and drawn metres flies the camera through mountains.

## 6. Reactivity and memory — what was audited, and why there is no event bus

Audited against Svelte 5 guidance on 2026-09-05. Recorded here because the
useful output was mostly "this is already right, and here is the evidence",
which is exactly the kind of finding that gets re-litigated otherwise.

### Communication: context and callback props, not a bus

The natural instinct on a codebase this size is to reach for an event bus. It
would be wrong here, and the numbers say why:

| mechanism                                  | count                                      |
| ------------------------------------------ | ------------------------------------------ |
| `useDisplay()` — context                   | 50 components                              |
| callback props (`onselect`)                | the Segmented control and its 5 call sites |
| `$bindable`                                | 1 (drawer open/closed)                     |
| `dispatchEvent` / `CustomEvent` / emitters | **0**                                      |
| mutable global singletons                  | **0** (only debug hooks)                   |

Nothing dispatches an event because nothing needs to. A bus solves "A must tell
B something happened when A does not know B exists". This app has no such
relationship: every component reads one context object and derives from it, so
B already sees the change without being told. Adding a bus would introduce the
one thing the architecture is built to avoid — a second path by which state can
change, with its own ordering and its own subscription lifetimes to leak.

`$bindable` is used once, for drawer visibility, which is genuinely two-way UI
state. Everything else flows one direction: context down, callback props up.
That is the Svelte 5 idiom that replaced `createEventDispatcher`, and it is
already what this code does.

### Effects: 15, and each one owns a resource

Effects are an escape hatch, so the count matters. All 15 are lifecycle —
`requestAnimationFrame` loops (3), pollers (2), intervals (3), canvas and audio
mount, the cloud rebuild. Every one returns a teardown, and the teardowns were
verified by counting allocations against frees: 6 `setInterval` against 4
`clearInterval` (two are inside `createPoller`, which owns its own), 3 rAF loops
against 3 `cancelAnimationFrame`.

The rule that keeps this number low is elsewhere in this document: derive, do
not synchronise. The `$effect : $derived` ratio is 0.11 here against 0.60 in v1.

### `$state.raw` where the object is replaced, not mutated

Every hot or wholesale-replaced value: the per-frame `view` (with the measured
2.2x write cost recorded beside it), `place`, the three playlists, the buffered
wall snapshot, the liveness probe. The two plain `$state` objects left are
`terrain` and an admin clock, both genuinely mutated field-by-field.

### GPU memory is not JS memory

The one real defect the audit found, and the reason it survived so long:

> Measured across ten mount/unmount cycles driven through the real operator
> toggle, the JS heap held flat at ~40 MB and the canvas count stayed at 4.
> That is precisely the reading a CORRECT teardown gives.

`Clouds` disposed its materials but not its three textures; `Wing` disposed
nothing of its glTF. `scene.clear()` detaches children from the graph and frees
no GPU buffer. None of it appears in `performance.memory` or a heap snapshot,
so the only symptom is a WebGL context loss weeks later on a device that never
reboots — which reads as "the Pi crashed".

**If you add a renderer-owning component, dispose geometries, materials AND
every texture slot, and walk the scene with `traverse` — a glTF is a tree, and a
flat loop over `scene.children` misses the nested nodes that hold the data.**
