/**
 * FlightSimEngine - Flight position, orbit, scenario, and cruise state machine.
 *
 * Phase 5 migration: all AIRCRAFT constants replaced with ctx.camera.orbit.*,
 * ctx.camera.altitude.*, and ctx.camera.cruise.* reads.
 */

import { untrack } from 'svelte';
import { clamp, normalizeHeading, shortestAngleDelta } from '$lib/utils';
import type { LocationId, SkyState, SimulationContext, FlightMode, FlightPatch, FlightScenario } from '$lib/types';
import { LOCATION_MAP } from '$content/locations';
import { pickScenario } from '$lib/director/scenarios';
import { createSeededRng, daySeed, hashString } from '$lib/world/prng';
import { CRUISE_SPEED_DEFAULTS } from '$lib/model/config-tree.svelte';

/**
 * Default position of the `flightSpeed` knob, and the reference the scenario
 * playback rate normalises against — authored waypoint `duration` values are
 * SECONDS at this speed. Re-exported from config-tree cruise literals so the
 * two can never drift apart.
 */
export const DEFAULT_FLIGHT_SPEED = CRUISE_SPEED_DEFAULTS.defaultSpeed;

/**
 * Slow climb/descent offset in feet, to add to a location's preferred altitude.
 *
 * Phase is taken from the WALL CLOCK rather than an accumulating local timer,
 * which is the whole reason this is safe on a 3-pane wall: every Pi evaluates
 * the same sine at the same instant and gets the same number, so no broadcast
 * or seed rendezvous is needed, and a Pi that reboots mid-cycle rejoins at the
 * correct phase instead of restarting it at zero and drifting from its
 * neighbours for the next several minutes.
 *
 * `now` is injectable so this is testable without waiting seven minutes.
 */
export function altitudeDriftFt(
	amplitudeFt: number,
	periodSec: number,
	now: number = Date.now(),
): number {
	// Finite-checked, not just `<= 0`: an older persisted config or a partial
	// SimulationContext delivers `undefined` here, and `undefined <= 0` is
	// false — so a bare sign test lets it through and every altitude downstream
	// becomes NaN, which silently freezes the camera rather than erroring.
	if (!Number.isFinite(amplitudeFt) || !Number.isFinite(periodSec)) return 0;
	if (amplitudeFt <= 0 || periodSec <= 0) return 0;
	return Math.sin((now / 1000) * (2 * Math.PI / periodSec)) * amplitudeFt;
}

/**
 * Uniform Catmull-Rom interpolation of a scalar through 4 control points,
 * evaluated at local parameter t∈[0,1] between p1 and p2.
 *
 * Why: a per-segment smoothstep (the old `raw*raw*(3-2*raw)`) eases velocity to
 * ZERO at p1 AND p2 — so the camera visibly decelerates to a STOP at every
 * waypoint, then re-accelerates ("moves and stops"). Catmull-Rom is
 * C1-continuous across the join (the tangent leaving one segment matches the
 * tangent entering the next), so a LINEAR time parameter carries the camera
 * THROUGH each waypoint at steady speed. p0/p3 are the neighbouring waypoints
 * that shape the tangents.
 */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
	const t2 = t * t;
	const t3 = t2 * t;
	return 0.5 * (
		2 * p1 +
		(-p0 + p2) * t +
		(2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
		(-p0 + 3 * p1 - 3 * p2 + p3) * t3
	);
}

export class FlightSimEngine {
	// --- Position (plain — pull model for engines; no 60Hz reactive fan-out) ---
	// UI/HUD only needs flightMode, altitude, flightSpeed, warpFactor, cruise*.
	// Cesium/Three read pose imperatively each frame (syncCamera, useTask).
	lat = 25.2048;
	lon = 55.2708;
	heading = 45;
	pitch = 60;
	// Operator-facing: sliders + readout (keep reactive).
	altitude = $state<number>(5_000);

	// --- Smoothed camera pose (plain SSOT for Cesium + Three pull) ---
	camLat = 25.2048;
	camLon = 55.2708;
	camAlt = 5_000;
	camHeading = 45;
	camPitch = 60;
	#camInitialized = false;

	// --- Flight mode (reactive — shell HUD / blind / fleet) ---
	flightMode = $state<FlightMode>('orbit');
	cruiseTargetId = $state<LocationId | null>(null);
	warpFactor = $state(0);
	flightSpeed = $state(DEFAULT_FLIGHT_SPEED);

	// --- Orbit (plain; tests read bearing/angle for 3-Pi determinism) ---
	orbitCenterLat = 25.2048;
	orbitCenterLon = 55.2708;
	orbitRadiusMajor = 0.15;
	orbitRadiusMinor = 0.06;
	orbitBearing = 0;
	orbitAngle = 0;
	// Rotation sense around the orbit ellipse: +1 or -1. Randomised
	// (deterministically) per location so the camera doesn't always sweep
	// the same way — some passes go left-to-right, others right-to-left.
	orbitDirection = $state(1);

	// --- Internal state (#private) ---
	// Night-city flyover override. When set (feet), #tickAltitude drives the
	// camera down to this altitude instead of the location's nightAltitude,
	// and descends a bit faster so the descent reads within a ~45s beat.
	// null = off (normal altitude logic). Deterministic (no random) so all 3
	// Pis descend identically. Set/cleared by AeroWindow.enter/exitFlyover.
	#flyoverAltitudeFt: number | null = null;
	#cruiseElapsed = 0;
	#arrivalHoldElapsed = 0;
	#arrivalHoldTargetSec = 0;
	#preWarpSpeed = 1.0;
	#currentScenario: FlightScenario | null = null;
	#scenarioWaypointIndex = 0;
	#scenarioProgress = 0;
	#scenarioLoopCount = 0;
	static SCENARIO_MAX_LOOPS = 3;
	// Scenario direction — toggled randomly on loop so the flight doesn't
	// always trace the same waypoints in the same order.
	#scenarioForward = true;
	// ── Absolute-derivation epochs (multi-Pi self-heal) ────────────────────
	// Integrating angle/progress with wallDelta alone drifts if a pane drops
	// frames or NTP steps. Re-derive from (epoch, wallT) each tick so all
	// Pis that share the seed + wall clock reconverge.
	#orbitEpochWallT: number | null = null;
	#orbitEpochAngle = 0;
	#scenarioLegStartWallT: number | null = null;

	// --- Derived ---
	// Single source of truth for travel direction. Everything downstream that
	// needs "which way are we going" (world drift, wing mirror, wing turn-lean)
	// derives from this one value via screen-conventions.ts — see that file for
	// why the old four-separate-sign-sites design kept the wing fighting the
	// movement. Currently the orbit rotation sense; cruise/scenario modes can
	// override it here later without touching the consumers.
	get travelSign(): number {
		// During scenarios, direction comes from #scenarioForward (toggled on loop).
		// During orbit, direction comes from orbitDirection (randomised per location).
		if (this.#currentScenario) return this.#scenarioForward ? 1 : -1;
		return this.orbitDirection;
	}

	isTransitioning = $derived(this.flightMode !== 'orbit' && this.flightMode !== 'arrival_hold');
	cruiseDestinationName = $derived(
		this.cruiseTargetId ? (LOCATION_MAP.get(this.cruiseTargetId)?.name ?? this.cruiseTargetId) : null
	);

	// ====================================================================
	// PUBLIC API
	// ====================================================================

	flyTo(locationId: LocationId, skyState: SkyState): void {
		if (this.cruiseTargetId === locationId) return;
		const target = LOCATION_MAP.get(locationId);
		if (!target) return;
		this.cruiseTargetId = locationId;
		// Snapshot the pre-warp speed only when NOT already cruising. A mid-cruise
		// flyTo (LocationPicker re-target) would otherwise capture the WARPED speed
		// (preWarp + 100), and #tickTransit would restore that as the permanent
		// orbit speed — the orbit then runs ~25x fast forever. Must read
		// isTransitioning BEFORE flipping flightMode below (it derives from it).
		if (!this.isTransitioning) {
			this.#preWarpSpeed = this.flightSpeed;
		}
		this.flightMode = 'cruise_departure';
		this.#cruiseElapsed = 0;
		this.warpFactor = 0;
		// Real sky state, not a hardcoded 'day' — a night departure should
		// play a night-picked scenario for the ~2s departure window too.
		this.#initScenario(locationId, skyState);
	}

	setLocationWithSky(locationId: LocationId, skyState: SkyState): void {
		const loc = LOCATION_MAP.get(locationId);
		if (!loc) return;
		this.lat = loc.lat;
		this.lon = loc.lon;
		this.orbitCenterLat = loc.lat;
		this.orbitCenterLon = loc.lon;
		// Deterministic orbit seed — daySeed() ^ location hash. All 3 Pis in a
		// panorama share daySeed and the broadcast location, so they compute
		// an IDENTICAL orbit (bearing + start angle + rotation direction) and
		// stay position-locked (only their yaw offset differs). Was raw
		// Math.random(), which diverged each Pi's camera position and broke
		// the panorama. The day component keeps the orbit fresh day-to-day.
		const rng = createSeededRng((daySeed() ^ hashString(locationId)) >>> 0);
		this.orbitBearing = this.#computeOrbitBearing(loc.lat, loc.lon) + (rng() - 0.5) * 0.6;
		this.orbitAngle = rng() * Math.PI * 2;
		// Randomise rotation sense so the camera sweep isn't always the same
		// direction. Deterministic via the seeded rng → identical across Pis.
		this.orbitDirection = rng() < 0.5 ? -1 : 1;
		// Fresh orbit epoch — first #tickOrbit latches wallT against this angle.
		this.#orbitEpochWallT = null;
		this.#orbitEpochAngle = this.orbitAngle;
		this.#initScenario(locationId, skyState);
	}

	setAltitude(alt: number, bounds: { min: number; max: number }): void {
		if (!Number.isFinite(alt)) return;
		this.altitude = clamp(alt, bounds.min, bounds.max);
	}

	/** Engage the night-city flyover altitude override (feet). #tickAltitude
	 *  descends here instead of the location's nightAltitude until cleared. */
	setFlyoverAltitude(ft: number): void {
		if (!Number.isFinite(ft)) return;
		this.#flyoverAltitudeFt = ft;
	}

	/** Release the flyover override — altitude returns to normal night logic. */
	clearFlyoverAltitude(): void {
		this.#flyoverAltitudeFt = null;
	}

	// ====================================================================
	// TICK
	// ====================================================================

	tick(delta: number, ctx: SimulationContext): FlightPatch {
		const patch: FlightPatch = {};
		untrack(() => {
			if (this.flightMode === 'cruise_departure') {
				// Warp ramp only — do NOT advance the scenario path. Departure
				// used to call #tickFlightPath while flightSpeed warps toward
				// ~100, so authored legs wrapped many times in ~2 s; arrival's
				// #initScenario then left mid-leg #scenarioProgress and the
				// orbit resumed with a jump. Transit already freezes the path.
				this.#tickDeparture(delta, patch, ctx);
			} else if (this.flightMode === 'cruise_transit') {
				this.#tickTransit(delta, patch, ctx);
			} else if (this.flightMode === 'arrival_hold') {
				this.#tickArrivalHold(delta, patch, ctx);
			} else {
				this.#tickFlightPath(delta, ctx);
			}
			this.#tickAltitude(delta, ctx);

			this.#tickSmoothing(delta);
		});
		return patch;
	}

	// ====================================================================
	// PRIVATE
	// ====================================================================

	#tickSmoothing(delta: number): void {
		if (!this.#camInitialized) {
			this.camLat = this.lat; this.camLon = this.lon; this.camAlt = this.altitude;
			this.camHeading = this.heading; this.camPitch = this.pitch;
			this.#camInitialized = true;
			return;
		}

		// Heavy camera feel: lerp toward logical state.
		// k = 0.12s time constant (same as previous Cesium lerp for continuity).
		const k = Math.min(1 - Math.exp(-delta / 0.12), 0.3);

		this.camLat += (this.lat - this.camLat) * k;
		this.camLon += (this.lon - this.camLon) * k;
		this.camAlt += (this.altitude - this.camAlt) * k;

		this.camHeading = normalizeHeading(this.camHeading + shortestAngleDelta(this.camHeading, this.heading) * k);
		this.camPitch += (this.pitch - this.camPitch) * k;
	}

	/** Wall-clock step when available — same class as orbit/director/bank. */
	#wallDt(delta: number, ctx: SimulationContext): number {
		const w = ctx.wallDeltaSec;
		return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : delta;
	}

	#tickDeparture(delta: number, patch: FlightPatch, ctx: SimulationContext): void {
		const dt = this.#wallDt(delta, ctx);
		this.#cruiseElapsed += dt;
		const cruiseCfg = ctx.camera.cruise;
		const warpDuration = cruiseCfg.departureDurationSec;
		const t = clamp(this.#cruiseElapsed / warpDuration, 0, 1);
		this.warpFactor = t * t * (3 - 2 * t);
		this.flightSpeed = this.#preWarpSpeed + this.warpFactor * 100;

		// Exit on the DEPARTURE knob, which is the one the ramp above is scaled
		// to. This used to read transitDurationSec: identical today (both 2.0s)
		// so the bug is invisible, but raising departureDurationSec alone would
		// cut the smoothstep off mid-ramp — at departure=4s the phase ends with
		// warpFactor ≈ 0.5 and #tickTransit's decay starts from there, so the
		// warp visibly snaps instead of easing. A duration knob must gate its
		// own phase.
		if (this.#cruiseElapsed > warpDuration) {
			patch.blindOpen = false;
			this.flightMode = 'cruise_transit';
			this.#cruiseElapsed = 0;
		}
	}

	#tickTransit(delta: number, patch: FlightPatch, ctx: SimulationContext): void {
		const dt = this.#wallDt(delta, ctx);
		this.#cruiseElapsed += dt;
		const decay = clamp(this.warpFactor - dt * 2.5, 0, 1);
		this.warpFactor = decay * decay;
		this.flightSpeed = this.#preWarpSpeed + this.warpFactor * 100;

		if (this.#cruiseElapsed > ctx.camera.cruise.transitDurationSec && this.cruiseTargetId) {
			const arrivedAt = this.cruiseTargetId;
			this.cruiseTargetId = null;
			this.flightMode = 'arrival_hold';
			this.#arrivalHoldElapsed = 0;
			this.#arrivalHoldTargetSec = ctx.camera.cruise.arrivalHoldMs / 1000;
			this.warpFactor = 0;
			this.flightSpeed = this.#preWarpSpeed;
			patch.locationArrived = arrivedAt;
			patch.blindOpen = true;
			patch.resetDirector = true;
		}
	}

	#tickArrivalHold(delta: number, _patch: FlightPatch, ctx?: SimulationContext): void {
		// ctx optional so existing call sites that only pass delta still compile;
		// when present, wall clock keeps arrival hold honest on a slow Pi.
		const dt = ctx ? this.#wallDt(delta, ctx) : delta;
		this.#arrivalHoldElapsed += dt;
		if (this.#arrivalHoldElapsed >= this.#arrivalHoldTargetSec) {
			this.flightMode = 'orbit';
			this.#arrivalHoldElapsed = 0;
		}
	}

	#tickFlightPath(delta: number, ctx: SimulationContext): void {
		if (this.#currentScenario) this.#tickScenario(delta, ctx);
		else this.#tickOrbit(delta, ctx);
	}

	#tickOrbit(_delta: number, ctx: SimulationContext): void {
		const orbit = ctx.camera.orbit;
		// Wall clock, not ctx.time/delta: sim time is boot-relative and advanced
		// by the dt-clamped delta, so on a slow Pi it runs slower than wall
		// clock and panorama panes decorrelate (breathe radius alone mismatches
		// up to majorMax−majorMin ≈ 19 km ground). wallTimeSec/wallDeltaSec come
		// from Date.now() — identical across Pis within NTP drift.
		//
		// Absolute derivation: re-integrate orbitAngle from a latched epoch
		// (angle0, wallT0) to the current wallT with fixed substeps. Missed
		// frames / different FPS no longer leave panes at different phases —
		// they reconverge on the next tick that shares wallT.
		const wallT = ctx.wallTimeSec ?? ctx.time;
		const breathePhase = (wallT / orbit.breathePeriod) * Math.PI * 2;
		const breathe = (Math.sin(breathePhase) + 1) * 0.5;
		this.orbitRadiusMajor = orbit.majorMin + breathe * (orbit.majorMax - orbit.majorMin);
		this.orbitRadiusMinor = this.orbitRadiusMajor * (0.35 + breathe * 0.15);

		const a = this.orbitRadiusMajor;
		const b = this.orbitRadiusMinor;

		if (this.#orbitEpochWallT === null) {
			this.#orbitEpochWallT = wallT;
			this.#orbitEpochAngle = this.orbitAngle;
		}
		// NORMALISE THE SPEED KNOB — same contract as #tickScenario.
		// Authored rates are seconds at the default knob position; passing the
		// raw knob (default 6.0) multiplies every rate by 6. The scenario path
		// learned this the hard way (legs ran 4x fast); the orbit never did,
		// so it lapped a 20 km ellipse in ~11 s (~8 km/s, Mach 23).
		this.orbitAngle = integrateOrbitAngle({
			angle0: this.#orbitEpochAngle,
			wallT0: this.#orbitEpochWallT,
			wallT,
			a,
			b,
			direction: this.orbitDirection,
			driftRate: orbit.driftRate,
			flightSpeed: this.flightSpeed / DEFAULT_FLIGHT_SPEED,
		});

		const tx = a * Math.cos(this.orbitAngle);
		const ty = -b * Math.sin(this.orbitAngle);

		const ex = a * Math.sin(this.orbitAngle);
		const ey = b * Math.cos(this.orbitAngle);
		const cb = Math.cos(this.orbitBearing);
		const sb = Math.sin(this.orbitBearing);
		const cosLat = Math.cos(this.orbitCenterLat * Math.PI / 180);

		const newLat = this.orbitCenterLat + (ex * cb - ey * sb);
		const newLon = this.orbitCenterLon + (ex * sb + ey * cb) / Math.max(cosLat, 0.1);
		if (Number.isFinite(newLat)) this.lat = newLat;
		if (Number.isFinite(newLon)) this.lon = newLon;

		// Heading follows the actual direction of travel: negate the tangent
		// when orbiting in reverse so a reversed orbit banks the opposite way
		// (turn rate → bank coupling in motion.svelte stays correctly signed).
		const vtx = tx * this.orbitDirection;
		const vty = ty * this.orbitDirection;
		const baseHeading = normalizeHeading((Math.atan2(vtx * sb + vty * cb, vtx * cb - vty * sb) * 180) / Math.PI);
		const wander = Math.sin(wallT * 0.05) * 0.25 + Math.sin(wallT * 0.031) * 0.15 + Math.sin(wallT * 0.017) * 0.1;
		this.heading = normalizeHeading(baseHeading + wander);
	}

	#tickScenario(_delta: number, ctx: SimulationContext): void {
		if (!this.#currentScenario) return;
		const waypoints = this.#currentScenario.waypoints;
		const n = waypoints.length;
		const idx = this.#scenarioWaypointIndex;
		const fwd = this.#scenarioForward;
		// Forward: nextIdx = (idx+1)%n, control points wrap forward.
		// Reverse: nextIdx = (idx-1+n)%n, control points wrap backward.
		const nextIdx = fwd ? (idx + 1) % n : (idx - 1 + n) % n;
		const p0 = fwd ? waypoints[(idx - 1 + n) % n] : waypoints[(idx + 1) % n];
		const p1 = waypoints[idx];
		const p2 = waypoints[nextIdx];
		const p3 = fwd ? waypoints[(nextIdx + 1) % n] : waypoints[(nextIdx - 1 + n) % n];

		const duration = p2.duration > 0 ? p2.duration : 30;
		// Wall-clock absolute progress — same multi-Pi self-heal as #tickOrbit.
		// Progress is (wallT − legStart) × speedNorm / duration, not a running
		// sum of wallDelta, so missed frames reconverge.
		const wallT = ctx.wallTimeSec ?? ctx.time;
		if (this.#scenarioLegStartWallT === null) this.#scenarioLegStartWallT = wallT;
		// NORMALISE THE SPEED KNOB — DO NOT PASS IT RAW.
		// Authored `duration` is SECONDS at the default knob position. The raw
		// 4.0 knob was multiplied straight in, so every authored leg ran 4x
		// fast: dubai-approach's 225 s circuit finished in 56 s, bleeding
		// 28,000 -> 6,000 ft in ~25 s (~53,000 ft/min, against ~2,000 ft/min
		// for a real airliner). The waypoints were plausible; the playback rate
		// was eating them. Same bug class as the 0..5 night-light knob — see
		// nightLightGain in world/altitude.
		const speedNorm = this.flightSpeed / DEFAULT_FLIGHT_SPEED;
		const elapsed = Math.max(0, wallT - this.#scenarioLegStartWallT);
		this.#scenarioProgress = (elapsed * speedNorm) / duration;

		// LINEAR param (was smoothstep) — Catmull-Rom now supplies the smoothing,
		// so a steady param advances the camera THROUGH each waypoint instead of
		// easing to a halt at it.
		const t = clamp(this.#scenarioProgress, 0, 1);

		const js = 0.0003;
		const jLat = Math.sin(wallT * 0.13) * js + Math.sin(wallT * 0.31) * js * 0.5;
		const jLon = Math.sin(wallT * 0.17) * js + Math.sin(wallT * 0.37) * js * 0.5;

		const newLat = catmullRom(p0.lat, p1.lat, p2.lat, p3.lat, t) + jLat;
		const newLon = catmullRom(p0.lon, p1.lon, p2.lon, p3.lon, t) + jLon;
		if (Number.isFinite(newLat)) this.lat = newLat;
		if (Number.isFinite(newLon)) this.lon = newLon;

		// A passenger override OR an active flyover beat suppresses the
		// scenario's authored altitude — #tickAltitude then owns altitude
		// (holds the manual value / drives the flyover descent). Without the
		// flyover guard the scenario re-wrote the waypoint altitude every
		// frame and the descent never happened.
		if (!ctx.userAdjustingAltitude && this.#flyoverAltitudeFt === null) {
			this.altitude =
				catmullRom(p0.altitude, p1.altitude, p2.altitude, p3.altitude, t) +
				Math.sin(wallT * 0.07) * 50;
		}

		// Heading: smooth the AUTHORED waypoint headings with the same Catmull-Rom,
		// but UNWRAP them first (shortestAngleDelta chain anchored on p1) so the
		// 359°→0° seam interpolates the short way, not a full spin.
		const u1 = p1.heading;
		const u0 = u1 + shortestAngleDelta(u1, p0.heading);
		const u2 = u1 + shortestAngleDelta(u1, p2.heading);
		const u3 = u2 + shortestAngleDelta(u2, p3.heading);
		this.heading = normalizeHeading(catmullRom(u0, u1, u2, u3, t) + Math.sin(wallT * 0.05) * 0.25);
		this.pitch = this.#altitudePitch(ctx) + Math.sin(wallT * 0.04) * 1.0;

		if (this.#scenarioProgress >= 1) {
			this.#scenarioProgress = 0;
			this.#scenarioLegStartWallT = wallT;
			this.#scenarioWaypointIndex = nextIdx;
			if (nextIdx === 0) {
				this.#scenarioLoopCount++;
				// loop:false runs exactly once then hands back to the orbit —
				// without this the modulo indexing above would wrap the
				// waypoints and a run-once scenario would fly forever.
				// loop:true expires after SCENARIO_MAX_LOOPS.
				if (!this.#currentScenario.loop || this.#scenarioLoopCount >= FlightSimEngine.SCENARIO_MAX_LOOPS) {
					this.#currentScenario = null;
					this.#scenarioLoopCount = 0;
				} else {
					// Mix the loop counter into the seed. Re-seeding with the
					// plain daySeed ^ location hash redraws the SAME stream on
					// every loop, so the flip and the re-pick below returned
					// identical results each time. The counter is deterministic
					// per day, so all 3 Pis still compute the same sequence.
					const rng = createSeededRng(
						(daySeed() ^ hashString(ctx.locationId) ^ Math.imul(this.#scenarioLoopCount, 0x9E3779B9)) >>> 0
					);
					// Randomly flip direction on each loop — the flight doesn't
					// always trace the same waypoints in the same order.
					this.#scenarioForward = rng() < 0.5;
					const fresh = pickScenario(ctx.locationId, ctx.skyState, rng);
					if (fresh && fresh.id !== this.#currentScenario.id) {
						this.#currentScenario = fresh;
					}
				}
			}
		}
	}

	#tickAltitude(delta: number, ctx: SimulationContext): void {
		if (ctx.userAdjustingAltitude) return;
		const altCfg = ctx.camera.altitude;
		// Flyover beat override — descend to the beat's low altitude, a touch
		// faster than the normal settle so it lands within the beat window.
		// Clamped to the camera bounds. Deterministic → identical on all Pis.
		if (this.#flyoverAltitudeFt !== null) {
			const target = clamp(this.#flyoverAltitudeFt, altCfg.min, altCfg.max);
			this.altitude += (target - this.altitude) * Math.min(delta * 0.12, 1);
			return;
		}
		const loc = LOCATION_MAP.get(ctx.locationId);
		const baseAlt = ctx.nightFactor > 0.5
			? (loc?.nightAltitude ?? altCfg.default)
			: (loc?.defaultAltitude ?? altCfg.default);
		// Breathe slowly around that altitude so the ground changes scale
		// between hops instead of holding one number (see the config comment on
		// driftAmplitudeFt). Phase comes from the WALL CLOCK, so every pane
		// computes the same offset at the same instant and a rebooted pane
		// rejoins mid-cycle rather than restarting it.
		const targetAlt = clamp(
			baseAlt + altitudeDriftFt(altCfg.driftAmplitudeFt, altCfg.driftPeriodSec),
			altCfg.min,
			altCfg.max,
		);
		// Lerp toward the location's preferred altitude. Rate softened
		// 0.1 → 0.04 (10s → ~25s time constant) so the initial descent
		// from config default 35kft to a city nightAltitude doesn't
		// perceptibly shrink the FOV and "switch off" city lights at the
		// frame edges. Slower descent reads as "settling cruise" rather
		// than "elevator dropping".
		this.altitude += (targetAlt - this.altitude) * Math.min(delta * 0.04, 1);
	}

	#altitudePitch(ctx: SimulationContext): number {
		const altCfg = ctx.camera.altitude;
		const altNorm = clamp((this.altitude - altCfg.min) / (altCfg.max - altCfg.min), 0, 1);
		return 70 + altNorm * 10;
	}

	#computeOrbitBearing(lat: number, lon: number): number {
		return (Math.abs(lat * 37 + lon * 59) % 180) * Math.PI / 180;
	}

	#initScenario(locationId: LocationId, skyState: SkyState): void {
		const rng = createSeededRng((daySeed() ^ hashString(locationId)) >>> 0);
		this.#currentScenario = pickScenario(locationId, skyState, rng);
		this.#scenarioWaypointIndex = 0;
		// Always zero progress. flyTo() / setLocationWithSky() used to leave
		// whatever fractional leg was running (or leftover from a warped
		// departure that wrapped many legs), so the new scenario started
		// mid-Catmull-Rom and the camera jumped after every city change.
		this.#scenarioProgress = 0;
		this.#scenarioLegStartWallT = null;
		this.#scenarioLoopCount = 0;
		this.#scenarioForward = true;
	}
}

/**
 * Re-integrate elliptical orbit angle from (angle0, wallT0) → wallT.
 * Pure / exported for tests. Fixed 50 ms substeps bound cost and keep
 * multi-Pi results identical for the same inputs.
 */
export function integrateOrbitAngle(opts: {
	angle0: number;
	wallT0: number;
	wallT: number;
	a: number;
	b: number;
	direction: number;
	driftRate: number;
	flightSpeed: number;
	/** Substep size (seconds). Smaller = closer to continuous integral. */
	stepSec?: number;
}): number {
	const { angle0, wallT0, wallT, a, b, direction, driftRate, flightSpeed } = opts;
	const stepSec = opts.stepSec ?? 0.05;
	if (!(wallT > wallT0) || !Number.isFinite(wallT) || !Number.isFinite(wallT0)) {
		return wrapAngle(angle0);
	}
	let angle = angle0;
	let t = wallT0;
	// Cap work: 60 s of catch-up max (NTP jump / tab background). Beyond that
	// we skip in one coarse step so a multi-minute suspend cannot spin the CPU.
	const end = Math.min(wallT, wallT0 + 60);
	while (t < end - 1e-9) {
		const dt = Math.min(stepSec, end - t);
		const tx = a * Math.cos(angle);
		const ty = -b * Math.sin(angle);
		const localSpeed = Math.sqrt(tx * tx + ty * ty);
		angle += direction * ((driftRate * flightSpeed) / Math.max(localSpeed, 0.001)) * dt;
		t += dt;
	}
	// Remaining span after the 60 s cap (rare) — single coarse step.
	if (wallT > end) {
		const dt = wallT - end;
		const tx = a * Math.cos(angle);
		const ty = -b * Math.sin(angle);
		const localSpeed = Math.sqrt(tx * tx + ty * ty);
		angle += direction * ((driftRate * flightSpeed) / Math.max(localSpeed, 0.001)) * dt;
	}
	return wrapAngle(angle);
}

function wrapAngle(a: number): number {
	const twoPi = Math.PI * 2;
	let x = a % twoPi;
	if (x < 0) x += twoPi;
	return x;
}
