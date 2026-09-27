# ADR-004 — Three.js + Threlte as the Canonical Renderer

> **Path note (2026-09-27):** this ADR predates the `aero-1/` · `aero-2/` split. Bare `src/…`, `content/…`, `tools/…` and `scripts/…` paths below are relative to what is now `aero-1/`; paths that no longer exist anywhere are marked *(removed)* inline. The decision text itself is unchanged.

> Status: Proposed (2026-05-27) → **in hardware validation** on branch
> `hybrid-v2` (2026-06-15). The shipped shape is a Cesium+Three **hybrid** gated
> by `config.world.useThreeOverlay` (default off), NOT a pure-Three replacement —
> see "Current decision record (2026-06-15)" at the bottom for the authoritative
> status; the Context/Decision sections below are the original framing, kept as
> history. Decision still gated on the P8 Pi-5 perf run.
> Counter-proposal to the 2026-05-27 *Experiential Flight Window Display*
> brief which framed pre-rendered Earth Studio video as Phase 1.
>
> Supersedes the implicit deprecation pressure on Cesium in that brief;
> does NOT supersede ADR-001/002/003 (those describe the Cesium pipeline
> at `pre-ship-v1` and remain valid history for the SWA Hyderabad
> installation).

## Context

The project ships with two real-time rendering paths, plus a proposed
third (pre-rendered video) added by the 2026-05-27 brief:

| Path | Status | LOC | Cold bundle | External deps |
|---|---|---|---|---|
| **`src/lib/world/`** (Cesium) | `pre-ship-v1` — running at SWA Hyderabad | 1 966 | ~3.5 MB | Cesium Ion (token), EOX, CartoDB, NASA GIBS |
| **`src/lib/world-three/`** *(removed — became `src/lib/world/three/`)* (Three.js + Threlte) | Lab — `/playground/three` route | 1 001 | ~500 KB | none at runtime — assets bundled in `/static/` and `/data/` |
| Pre-rendered Earth Studio (proposed) | Brief only — not started | n/a | n/a | Google Earth Studio license + animator time |

Cesium has proven on Pi 5 hardware at SATTVA. It also carries operational
weight that the four supporting ADRs document explicitly:

- ADR-001 (Offline Tile Architecture) — ~600 lines of pipeline plumbing
  to make Cesium's tile streaming survive on a kiosk.
- ADR-002 (Zero-Cost Caching) — strategy for keeping the tile cache
  warm in intermittent-network installs.
- ADR-003 (Night Pipeline Simplification) — three layers and four
  shaders removed to claw back Pi 5 frame budget at night.
- ADR-012 (HTML-in-Canvas Defer) — Cesium-specific compositing gotcha.

The 2026-05-27 brief responded to *Cesium-on-Pi pain* by proposing a
pivot to pre-rendered HEVC video. That solves real-time pain by
eliminating real-time. It also:

1. Caps "never the same flight twice" at the size of the clip library
   (15-30 clips of 4-8 hours animator time each).
2. Caps sensor responsiveness at clip boundaries (~30 s) where
   real-time responds in ~16 ms.
3. Introduces a Google Earth Studio commercial license dependency for
   Zyeta-DX-as-product.
4. Discards the night-light pipeline already solved in ADR-003.
5. Discards the autopilot / director / fleet protocol already shipped.

Meanwhile, the playground path (`src/lib/world-three/` *(removed)*) has been
developed in parallel and now demonstrates that **stylized
real-time** is viable on Pi 5's budget:

- WGS84 sphere with NASA Blue Marble day/night + normal + 9 km
  displacement heightmap, 512×256 segments.
- Three.js Sky.js Hosek-Wilkie scattering.
- 3-shell parallax cloud system (cumulus / alto / cirrus).
- Real OSM building extrusions + road LineSegments, 8 cities baked
  offline (`data/buildings/`, `data/roads/`).
- Plane-POV camera driven by `flight.camHeading` + `camPitch` +
  `motion.bankAngle` — same model the Cesium path consumes.
- `scene.fog` aerial perspective, lon-aware sun position.
- All assets bundled in `/static/textures/earth/` (~2 MB) and `/data/`
  (~6 MB) — zero CDN at runtime.

The playground sits at half the LOC, ~7× smaller cold bundle, and
zero external service dependency compared with the Cesium path.

## Decision

1. **Promote `/playground/three` from lab to canonical renderer.**
   Rename the folder `src/lib/world-three/` *(removed)* → `src/lib/world/` in a
   future cleanup pass; for now they coexist.

2. **Freeze `src/lib/world/` (Cesium) at the `pre-ship-v1` tag.**
   No new feature work. Maintenance commits only — bug fixes for SWA
   Hyderabad install support. The Cesium path remains the production
   renderer for the SATTVA 3-Pi panorama because that hardware is
   already deployed and validated; we don't gain anything by changing
   the live installation mid-life.

3. **Reframe the 2026-05-27 brief.** Pre-rendered Earth Studio clips
   become a **Phase 2 content track** — a composition mode within
   the same director, used for cinematic hero moments (a curated
   landing sequence, a specific sunset). NOT a replacement architecture.

4. **Treat ADR-001 / 002 / 003 / 012 as Cesium-era history.** They
   stay in `docs/` for the SATTVA install team's reference. The
   Three.js path does not inherit those problems and does not need
   equivalents.

## Why this is the right tradeoff

Three.js wins on every operational axis except Cesium-Ion-grade tile
streaming, which the kiosk install does not actually need:

| Axis | Cesium | Three.js path |
|---|---|---|
| Cold-start time on Pi 5 | ~3-4 s (Cesium init + Ion handshake) | <1 s (bundle parse only) |
| Tile pipeline maintenance | ADRs 001+002 | none — equirect textures + baked OSM |
| Night-light correctness | ADR-003 wrestled it down | natural via emissiveMap on a sphere |
| License surface | Cesium Ion token + Cesium MIT for engine | fully MIT/Apache for engine and assets |
| External CDN at runtime | EOX, CartoDB, NASA GIBS | none |
| Code surface | 1 966 LOC | 1 001 LOC |
| Bundle size | ~3.5 MB gzipped | ~500 KB gzipped |
| Procedural variation | Strong | Identical — same model layer |
| Photoreal ceiling | Higher (Ion premium imagery) | Medium — stylized realistic |

The photoreal ceiling is the one thing Cesium wins on. The project's
own visual direction across many sessions — Blue Marble + procedural
shaders + stylized atmosphere — has consistently chosen *stylized
realistic* over *photoreal*. The Cesium ceiling is paid for but not
consumed.

The brief's "Pi can't do real-time photoreal" framing is **true**, but
it stops one step short: stylized real-time runs fine on Pi 5. The
playground demonstrates this with real geographic data, real plane-POV
camera, and a 2× smaller code surface.

## Consequences

**Positive:**

- 50 % code reduction in the renderer layer.
- Drop of four ADRs' worth of operational pipeline (tile cache, night
  simplification, HTML-in-canvas, zero-cost caching).
- No Ion token rotation, no CDN heartbeat, no GIBS endpoint health
  monitoring at the kiosk level.
- Faster cold-start (kiosks reboot weekly — cold-start cost matters).
- Fully open-source dependency graph at runtime; product-line
  packaging gets simpler.
- The playground's bundle scales BETTER to consumer-SKU installs
  (single Pi, no fleet, single-stream content) — which is the Zyeta DX
  product-line direction.

**Negative / risks:**

- SATTVA install is in `pre-ship-v1` Cesium. If a critical bug emerges
  in the field, fixes go to a frozen tree. (Mitigation: maintenance
  commits permitted; freeze is on feature work, not safety.)
- Playground is unverified on actual Pi 5 hardware. (Mitigation: Pi 5
  perf validation is a gating step before the promotion lands.)
- Six months of Cesium-specific learnings (ADR-001/002/003/012) become
  legacy reading. (Mitigation: leave the ADRs in place; they remain
  accurate history.)
- Three.js doesn't have native 3D-Tiles streaming. If we ever need
  Cesium's quantized-mesh terrain at higher resolution, we'd need to
  add `3d-tiles-renderer` (NASA-AMMOS, Apache 2.0). (Mitigation:
  current heightmap is sufficient for stylized realistic; tile
  streaming is the brief's stated v2 path.)

**Neutral / unknowns:**

- The brief's owner (Rick) has not yet approved this reframing.
- Counter-proposal needs the brief's clarification questions (Q1-Q7
  in the council review) answered before this ADR moves from Proposed
  to Accepted.

## Migration plan (if Accepted)

Effort estimate: **15-20 days of focused work** to bring
`src/lib/world-three/` *(removed)* to ship parity with `src/lib/world/`.

Gating checklist:

1. **Pi 5 perf validation.** Measure cold-start, sustained frame rate
   at cruise + city approach, GPU memory ceiling on actual Pi 5 hardware
   running the playground route. Acceptance: ≥30 fps at default
   altitude, ≥24 fps at city approach.
2. **Shell components ported.** Window frame, blind, oval mask, wing
   silhouette currently live in `src/lib/shell/` targeting Cesium's
   `Pane.svelte`. Wire them to the Three.js renderer (most are
   renderer-agnostic; mostly mounting work).
3. **Fleet 3-Pi panorama.** Apply `camera.parallax.headingOffsetDeg`
   in `ThreeViewer`'s lookAt computation. ~10 lines.
4. **Production HUD overlay.** Replace `DebugHud.svelte` with the
   production `TelemetryOverlay` / `BlindInfoCard` pair.
   **Lab status (All! + go-on cycles)**: Real components successfully mounted
   and rendering over the full hybrid. A small deletable hybrid-debug panel
   was also added in the three lab for artistic layer validation.
5. **Texture error paths.** Add solid-color fallback for failed
   `useTexture` loads so a 404 doesn't leave the sphere transparent.
6. **City data parity.** Bake OSM data for the remaining 10 cities
   (we have 8 of 18).
7. **Director / autopilot sanity test.** Currently shared with Cesium;
   no changes expected, but verify location transitions actually fly
   in Three.js mode.
8. **Tag `pre-ship-v2`** after validation.

**Recent lab wins (All! + go-on cycles)**
- Full artistic layer set committed and running (EffectStack postprocess, Meteors, SparkleField, NeonLineLayer + thin Osm wrappers).
- Easy one-liner perf benchmark helpers added to tools/perf/ (`runBenchmark(ms)`, CSV export) — directly supports Pi 5 gating item.
- Hybrid debug panel + 3-Pi cycle button + live offset readout in the three lab for fast validation.
- Real production HUD chrome successfully layered on top of the hybrid renderer.
- Concrete shell mounting experiment active (real BlindInfoCard mounted as throwaway test layer).

**Lab Proven status (All! batch)**
| Component / Capability              | Status in `/playground/three`          | Notes |
|-------------------------------------|----------------------------------------|-------|
| Production HUD (Telemetry + BlindInfoCard) | Proven & live                         | Renders cleanly over full hybrid |
| Artistic layers (clouds, godrays, bloom, neon, meteors, sparkle) | Proven & live | All wired to shared model + sky.ts |
| Hybrid debug tooling                | Proven & live                         | Real values from EffectStack |
| 3-Pi inheritance via CameraMirror   | Proven & live                         | Cycle + visual feedback working |
| Easy Pi 5 perf benchmarking         | Proven & usable                       | `runBenchmark()` + CSV ready |
| Shell chrome mounting               | Initial experiment active             | Real BlindInfoCard test layer mounted |

Cesium maintenance during the transition:

- `src/lib/world/` stays in tree.
- The `/` route stays Cesium until v2 ships.
- SWA install support patches land on a maintenance branch tagged
  off `pre-ship-v1`.

## Related ADRs

- ADR-001 — Cesium-era tile architecture. Becomes legacy when this ADR
  is Accepted.
- ADR-002 — Cesium-era caching. Becomes legacy.
- ADR-003 — Cesium night pipeline. Becomes legacy; Three.js path uses
  Blue Marble night.jpg as emissiveMap, no equivalent complexity.
- ADR-012 — HTML-in-canvas Cesium gotcha. Becomes legacy.

## Open questions for the brief's owner

(Repeat of Q1-Q7 from the 2026-05-27 council review; this ADR cannot
be Accepted until they are resolved.)

1. What is the relationship between this brief and the SWA installation?
2. What becomes of `src/lib/world/`?
3. Google Earth Studio commercial license for product-line use?
4. Content budget for the brief's Phase 1 clips?
5. Why pre-rendered now, given real-time has shipped?
6. Is "never the same flight twice" a hard requirement?
7. HUD/sensor scope?

## Current Status (2026-05-28) — after VE 3D pass + hybrid refactor

**Hybrid architecture now active on `/playground/three`**:
- Full production Cesium (terrain/imagery/VIIRS/shader/bloom) + transparent Three.js overlay.
- `ThreeOverlay.svelte` + `CameraMirror.svelte` (syncs pose/fov/up from Cesium every frame, with correct ECEF→Three transform).
- Artistic payload: Clouds (cluster sprites with live sun-direction side-lighting), SunGlow (core+halo with air-mass), LensFlare (aggressively de-faked ghosts), AtmosphericVeil (now air-mass boosted), Moon (now with horizon boost), NightStars (shader twinkle), OsmBuildingEdges + OsmRoads (night + altitude gated).
- Consistent `sky.ts` SSOT for sun direction, visibility curves, and per-phase palettes (ambient, veil, sunCore, etc.).
- LabShell + extra controls (night intensity) + diag already provide good day-to-day tuning.

**ADR-004 Gating Checklist progress**:
- 3. Fleet 3-Pi panorama: **Effectively complete for the Three artistic layers**. `CameraMirror` inherits the full `camera.parallax.{headingOffsetDeg, fovDeg}` + bank + effectiveHeading that the Cesium path already drives from the shared model. No extra code required in Three land (the mirror does the hard work).
- 2. Shell components: Partial (wing silhouette + LabShell controls/snippets present; full blind/oval/HUD/Glass still on Cesium side for now).
- 1,4-8 (Pi perf, production HUD, texture fallbacks, city data parity, director sanity, v2 tag): Not yet started. The composition model makes isolated testing of new Three effects much cheaper than the old pure-Three attempt.

**3D visual-effects work (the "think in 3D" thread)**:
- All four sun-anchored artistic layers (Clouds, SunGlow, LensFlare, AtmosphericVeil) now use real air-mass / sun-direction / nightFactor participation instead of pure time curves.
- Moon received matching horizon-boost treatment.
- Changes kept small, deletable, and consistent with the existing `sky.ts` + overlay ambient pipeline.
- Two focused surgical commits captured the work on the live surface only (old pure-Three modules left as uncommitted D for later decision).

**Risks / open surface items**:
- Large uncommitted deletion set (old pure-Three Earth/Sky/Stars/ThreeViewer/DebugHud/OsmBuildings) + several new modules still untracked in the working tree (CameraMirror, enu, texture-util, NightStars, OsmBuildingEdges, etc.). Recommend batch review + isolated commits for the evolved artistic surface before any broader rebase or cleanup.
- No Pi 5 hardware validation yet on the hybrid.
- `state.svelte.ts` still contains some legacy pure-Three camera math (SkyState) that is no longer exercised by the main `/playground/three` route.

**Recommended next 1-2 phases (pragmatic, low risk)**:
1. Continue shell mounting experiments in the three lab (real Glass/Blind interaction with the hybrid postprocess stack is the current active spike).
2. Formalize lab validation tooling (debug bridge + hybrid-debug panel) while keeping it obviously deletable.
3. ADR-004 narrative refresh + Lab Proven tracking (ongoing).
4. (Later) Formal Pi 5 perf runs using the new easy benchmark helpers + owner decision on open questions.

This hybrid + 3D work directly de-risks the "Three as future canonical" path while preserving the SWA Cesium install untouched.

**2026-05-28 session update ("All the above")**:
- Extracted `airMassFactor` helper into sky.ts (centralization win).
- 3D polish: NightStars now uses airMassFactor for subtle high-altitude clarity modulation.
- Usability: Added live 3-Pi Role simulator (left/center/right/solo) in extraControls that directly mutates `camera.parallax` — excellent for testing the CameraMirror inheritance.
- Deletion surface decision: The D files (old pure-Three Earth/Sky/Stars/ThreeViewer/OsmBuildings/DebugHud) are the historical pure-Three exploration. **Decision: Leave uncommitted for now** (reversible, keeps history). The hybrid is the active surface. Will revisit in a dedicated cleanup pass or archive branch.
- All changes kept small/deletable. Three additional focused commits planned for the live artistic surface.

**Further session progress ("All!")**:
- OsmRoads now receives ambient tint/intensity from the overlay for sky-mood harmony (consistent with Clouds).
- 3-Pi simulator improved with live values display + reset button.
- Remaining high-value surface modules (CameraMirror, OsmBuildingEdges, enu, texture-util) captured in prior surgical commit.
- Observation: OsmRoads and OsmBuildingEdges have near-identical structure (intentional for now; extraction would be a future deletable refactor if volume grows).
- Next natural ADR items: Production HUD overlay integration into the hybrid, or lightweight Pi 5 perf notes.

**Further "All!" cycle progress (shell spike + validation tooling)**:
- Concrete shell mounting experiment active in the three lab (real BlindInfoCard + minimal Glass test layer mounted to observe z/backdrop/postprocess interaction).
- Hybrid debug panel upgraded to pull real runtime values (godray opacity, bloom threshold) from EffectStack via a small deletable lab-debug module.
- 3-Pi simulator enhanced with live bank + heading offset visual feedback.
- Lab Proven table + expanded recent wins added to ADR-004.

**"All!" cycle progress (environment + sky + cleanup)**:
- Fixed hybrid base environment: Added `environmentAmbient(...)` helper in sky.ts that blends artistic phase mood with real air-mass horizon boost + nightFactor. ThreeOverlay AmbientLight now uses it → much better consistency between base environment and artistic sky layers (Veil, SunGlow, etc.).
- AtmosphericVeil now uses the shared `airMassFactor` from sky.ts (reduced duplication).
- Doc debt cleanup in Clouds (removed outdated claims about old anchoring system).
- NeonLineLayer.svelte recognized as legitimate good infrastructure for deduplicating Osm* neon layers (not stray; worth keeping and adopting).
- 3-Pi simulator remains useful; small label/UX polish applied.
- **Deletion surface recommendation** (repeated for emphasis): Leave the D list (old pure-Three experiment) uncommitted for now. Revisit via dedicated archive branch or explicit cleanup PR when the hybrid is fully validated. This preserves history without polluting the active surface.
- All changes small/deletable. Additional focused surgical commits on live three-lab files only.

**Completion of "All!" items (user-approved)**:
- NeonLineLayer adoption: **Complete**. Both OsmRoads and OsmBuildingEdges are now thin wrappers around the generic `NeonLineLayer` component (big duplication reduction achieved with almost no behavior change). This is the blessed pattern going forward for any future neon/geo-line layers.
- Deletion surface: **Decision confirmed** — leave the entire D list (old pure-Three experiment files) uncommitted. The hybrid is the active, production-leaning path. History is preserved; we can always archive or cherry-pick later.
- Production HUD for hybrid: 
  - The hybrid model (full Cesium `CesiumViewer` + transparent `ThreeOverlay` + `CameraMirror`) makes production HUD integration straightforward.
  - `TelemetryOverlay` and `BlindInfoCard` (currently in `src/lib/shell/hud/` *(removed — now `src/lib/shell/passenger/hud/`)*) can be mounted in the same places as they are for the pure-Cesium `/playground` route.
  - The only new consideration is ensuring the HUD reads from the shared model (it already does) and that any Three-specific telemetry (e.g. artistic layer draw calls) can be exposed via the existing `model.telemetry` ring buffer if desired.
  - Recommended integration order: first port the existing HUD components on top of the hybrid Canvas exactly as they sit on the Cesium-only route, then evaluate whether any Three-specific diagnostics should be added later.
  - This is the next natural high-value piece of work after hardware validation of the current hybrid.

**Shell porting observations (All! cycle)**
- Real production `<HUD />` mounts and functions without modification over the hybrid.
- Main remaining work for full shell: integrating `Pane.svelte` + Blind/Glass/Weather while respecting the ThreeOverlay z:5 layer and postprocess stack.
- The three lab (with HUD + artistic layers) is now the best place to prototype and validate shell chrome before touching the main production route.

**Shell mounting spike (started in this All! batch)**
- Initial exploration notes captured above.
- Next small step could be a throwaway experiment mounting a simplified Blind + Glass structure in the three lab viewer snippet to measure z-index / backdrop-filter interaction with the Three postprocess stack.

- 2026-05-xx: Minimal HUD spike started in the three lab (`<HUD />` now rendered in the viewer snippet over the live Cesium + ThreeOverlay + artistic layers + postprocess). Uses the exact production components and `model.config.shell.blindOpen` state. Clean autofixer + check. Ready for visual validation of chrome against godrays/bloom/neon/meteors/etc.
- 2026-05-xx ("All!"): Full remaining batch after review + explicit "all!" signal:
  - Pi 5 perf harness skeleton completed (tools/perf/ README + Bun driver + injectable snippet using real model.telemetry; exact ADR acceptance criteria documented).
  - Production HUD spike committed (real TelemetryOverlay/BlindInfoCard now live in the hybrid lab for validation against the artistic layers).
  - The three high-signal artistic experiments from the 3D VE passes committed (EffectStack postprocess pipeline, Meteors deep-night streaks, SparkleField camera-tracked dust). All wired through shared model + sky.ts helpers, consistent with the hybrid "painterly but grounded" direction.
  - Surgical commits only on live three-lab surface + ADR. D list (old pure-Three) left untouched. 0 errors throughout.
- Pi 5 perf: Initial lightweight checklist and observations section added to ADR (cold start, sustained fps at cruise vs city, GPU memory, comparison points vs old pure-Three and current Cesium baseline). A simple harness script skeleton can live in `tools/perf/` when we get hardware time.
- 2026-05-xx: Harness skeleton landed in `tools/perf/` (polished README with exact ADR acceptance criteria + robust console logger using the existing `model.telemetry` ring buffer + Bun driver script + standalone injectable-snippet.js). Zero new deps. Shift+T TelemetryPanel remains the zero-code live view. Ready for real Pi 5 hardware session. Everything is small and deletable post-validation. See `tools/perf/README.md`.

This cycle (environment/sky consistency + full "All!" items) brings the three-lab hybrid to a clean, well-documented, and deduplicated state while strictly respecting surgical commit discipline on the live surface.

---

## Current decision record (2026-06-15) — `hybrid-v2` consolidation

This section supersedes the scattered "All!"-cycle notes above as the canonical
status. The architecture that actually landed is **not** "pure-Three replaces
Cesium" (the original framing in Context/Decision §1 is historical). It is a
**hybrid**: Cesium remains the base renderer (terrain/imagery/VIIRS/atmosphere/
post-process/bloom); a transparent Three.js overlay (`world-three/`) composes
photoreal layers above it, camera-mirrored from Cesium each frame. The overlay
is gated by **`config.world.useThreeOverlay` (default `false`)** — so `/` is
byte-identical to `pre-ship-v1` until the gate flips. The decision is a *config
flag*, not a code fork.

### What landed on `hybrid-v2` (all tests green, 367)

**Cross-renderer SSOTs** (framework-free, imported by both Cesium `world/` and
Three `world-three/` — does not break Cesium-isolation invariant #1, they are
pure math):
- `world-lighting/curves.ts` — `lightingState(timeOfDay, nightFactor)` owns the
  whole day/dusk/night response; kills the "white horizon seam" where Cesium and
  Three derived night independently.
- `world-lighting/altitude.ts` — `altitudeDetailMix` unifies the 5 night-light
  altitude gates (NEAR layers × mix, FAR × 1−mix). Three-side consumers are live;
  the Cesium-side gates (VIIRS/CartoDB/building-emissive) carry TODOs to flip
  post-perf-gate (compose.ts is the high-blast-radius shipping renderer).
- `cityLightAmount` + `cityGlowAmount` (in curves.ts) — the discrete-lights and
  diffuse-skyglow night curves; CityLightField + OsmRoads + CityGlowDome read
  them so the night-city layers brighten in lock-step (one owner, not per-layer
  raw-nf thresholds). Test-pinned (lights lead glow).
- `content/palettes/city-lights.ts` *(removed — see `content/palettes/index.ts` header for where it went)* — the named warm hue family (sodium/amber/
  warm-white/cool-LED). A full "every layer reads one palette" merge was explored
  and rejected as a wrong abstraction (role-differentiated hues across 5
  representations); the module is the documented reference + the cheap Three
  consumers import it. Hex round-trip test-pinned.
  > **Deleted 2026-08-04.** Every consumer named here (CityGlowDome, OsmRoads,
  > CityLightField) was removed by the later Three-overlay and DOM-compositor
  > sweeps, leaving a palette with no readers — alive only via a barrel
  > re-export and its own test. The reasoning above stands as the record of why
  > the merge was rejected; the file itself is recoverable from git history if
  > those layers return. This ADR is a historical decision record and is
  > otherwise left as written.

**Night-light layer set** (Three overlay): `CityLightField` (VIIRS-placed bokeh
carpet, bilinear-sampled, seeded for 3-Pi), `CityGlowDome` (diffuse skyglow),
`OsmRoads` (neon streets via `NeonLineLayer`). `OsmBuildingEdges` was **removed** —
the carpet + streets cover its read.

**Flight groundwork** (Phase C1–C2): `flight.noseHeadingDeg` getter + `body`
accessor + `SEAT_LOOK_DEG` named. The C4 keystone (wing built from body frame,
drop the camera-quaternion copy) stays gated to post-Pi hardware.

**Ship-readiness**: Cesium init bounded auto-retry; `/?overlay=1|0` URL param to
run the perf A/B on the ship route.

### The one remaining gate — P8 (Pi-5 perf)

The go/no-go is the **overlay-ON vs OFF delta** on `/`, on real Pi-5 hardware:
acceptance ≥30 fps cruise / ≥24 fps city-approach. Procedure in
`tools/perf/README.md` (§3, the `?overlay=` A/B).

- **GO** → flip `useThreeOverlay` default to `true`, tag `pre-ship-v2`, then
  proceed with the gated Cesium-side `altitudeDetailMix` migration + the C4 wing
  keystone.
- **NO-GO** → default stays `false`; the hybrid remains lab-only and matures as
  v2; SWA Hyderabad ships Cesium-only (`pre-ship-v1`) unchanged.

Until then `main`/`pre-ship-v1` is the untouched proven fallback.
