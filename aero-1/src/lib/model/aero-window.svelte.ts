/**
 * AeroWindow — authoritative reactive simulation state + Svelte context DI.
 *
 * Product: Zyeta Aero Dynamic Window. Engine / architecture: rdtect
 * (see `$lib/credits`). This class is the SSOT for kiosk simulation state.
 *
 * Usage:
 *   Root component: const model = createAeroWindow()
 *   Child components: const model = useAeroWindow()
 */

import { getContext, setContext, hasContext } from 'svelte';
import { clamp, getSkyState, nightFactor as nightFactorAt, dawnDuskFactor as dawnDuskFactorAt } from '$lib/utils';
import { WEATHER_EFFECTS } from '$content/weather';
import { isValidWeather, type SkyState, type LocationId, type WeatherType, type QualityMode, type DisplayMode, type SimulationContext, type VantageBeat } from '$lib/types';
import { type SlideshowSpec } from '$lib/fleet/display-payload';
import { loadDisplayMode } from '$lib/fleet/display-mode-persist';
import { applyDisplayMode } from '$lib/model/aero-window-display';
import {
	applyPersistedToHost,
	buildPersistedSnapshot,
} from '$lib/model/aero-window-persist-map';
import {
	broadcastAmbientJitter,
	broadcastLocationDecision,
} from '$lib/model/aero-window-fleet';
import { loadPersistedState, hasPersistedState, type PersistedState } from '$lib/model/persistence';
import { pickNextLocation } from '$lib/director/scenarios';
import { lightingState } from '$lib/world/curves';
import { LOCATIONS, LOCATION_MAP } from '$content/locations';
import { pickDailyShow } from '$content/shows';
import { applyShowOpening } from '$lib/director/show-opening';
import { FlightSimEngine } from '$lib/flight/flight.svelte';
import { motion as motionState, motionStep, motionReset } from '$lib/flight/motion.svelte';
import { directorTick, directorReset } from '$lib/director/autopilot.svelte';
import {
	config as _config,
	syncAtmosphereWeather,
	applyConfigPatch as _applyConfigPatch,
	type ConfigPatchOpts,
} from '$lib/model/config-tree.svelte';
import { Telemetry } from '$lib/model/telemetry.svelte';
import { effectiveCloudDensityFor } from '$lib/model/atmosphere-rules';
import { isGroupLeader, resolveBinding } from '$lib/fleet/parallax.svelte';
import { createSeededRng, daySeed, hashString } from '$lib/world/prng';
import { resolveLocalHours } from '$lib/model/local-time';
// TRANSITION_DELAY_MS comes from the fleet protocol so sender + receiver share
// one number: the receiver bounds incoming schedules against it (transitionDelayMs).
import { TRANSITION_DELAY_MS } from '$lib/fleet/protocol';
import { SceneTimers } from './aero-window-timers';
import { SimulationContextBuilder } from './aero-window-context';
import { decideBoot, DEV_NIGHT_HOUR } from './aero-window-boot';


// ─── User override state ──────────────────────────────────────────────────────

/** Expiry timestamps (performance.now()) per override kind. 0 = inactive. */
const OVERRIDE_COOLDOWN_MS = 8000;
const _overrides = $state({ altitude: 0, time: 0, atmosphere: 0 });

function trackOverride(kind: keyof typeof _overrides): void {
	_overrides[kind] = performance.now() + OVERRIDE_COOLDOWN_MS;
}

function hasActiveOverride(kind: keyof typeof _overrides): boolean {
	return performance.now() < _overrides[kind];
}

// ─── AeroWindow ──────────────────────────────────────────────────────────────

export class AeroWindow {
	// ── Engines ───────────────────────────────────────────────────────────────
	// flight is the only remaining class (public methods called outside
	// tick, in-class $derived for cruise state). motion + director are
	// modules of pure functions with state in module scope. `model.motion`
	// is a getter returning the module's singleton state object — keeps
	// existing `model.motion.*` call sites untouched across Window.svelte
	// and compose.ts.
	readonly flight = new FlightSimEngine();
	get motion() { return motionState; }

	// ── Config tree ──────────────────────────────────────────────────────────
	// Flat reactive config — single-file state with generic path dispatcher.
	// Fleet v2 config_patch messages route through applyConfigPatch(path, value).
	readonly config = _config;

	// ── Observability (Phase 5.6) ────────────────────────────────────────────
	// Ring-buffer telemetry — per-frame durations (p50/p95), lifecycle events,
	// counters. Instrumentation batches so the 60 Hz tick path only touches a
	// plain non-reactive buffer. Surfaced to UI via TelemetryPanel (Shift+T).
	readonly telemetry = new Telemetry();

	// Phase 7 — leader broadcast hook. Set by the fleet client on connect
	// (see setFleetBroadcast). When this device is a panorama leader, the
	// director calls this hook to notify followers of scenario changes so
	// all three Pis flip to the same location at the same wall-clock
	// instant (via the transitionAtMs schedule on the receiver side).
	#fleetBroadcast: ((msg: { v: 2; type: string; [k: string]: unknown }) => void) | null = null;
	setFleetBroadcast(fn: ((msg: { v: 2; type: string; [k: string]: unknown }) => void) | null): void {
		this.#fleetBroadcast = fn;
	}

	// True during the constructor. Boot-time config applications (persisted
	// restore, weather sync, boot setLocation jitter) must NOT stamp the CRDT
	// with the current wall-clock: an admin push issued while the Pi was
	// offline carries an OLDER timestamp and would lose LWW to a fresh
	// local-default stamp on every reboot. applyConfigPatch consults this
	// flag; genuine user/fleet interactions after boot stamp normally.
	#booting = true;

	// ── Core state ────────────────────────────────────────────────────────────
	location     = $state<LocationId>('hyderabad');
	timeOfDay    = $state(12);
	syncToRealTime = $state(true);

	// Environment
	weather = $state<WeatherType>('cloudy');

	// Passenger route watermark (closed blind "Dallas → Dubai"). Stamped when
	// a cruise starts (blind pull / autopilot / fleet applyScene); holds until
	// the next hop so the blind still names the leg after arrival.
	routeFromName = $state<string | null>(null);
	routeToName = $state<string | null>(null);

	// Display — fleet-controlled mode (admin set_mode). Consumed by Pane →
	// MediaStage. $state so templates re-render when the fleet flips mode.
	displayMode = $state<DisplayMode>('flight');
	/** Active video URL when displayMode === 'video'. */
	videoUrl = $state('');
	/** Active slideshow when displayMode === 'screensaver'. */
	slideshow = $state<SlideshowSpec | null>(null);

	// Apply-ack — id of the most recent admin-pushed command/config patch the
	// fleet client applied, echoed back in the /api/status heartbeat so the
	// admin dashboard can tell "published to SSE" apart from "applied by the
	// kiosk". Plain (non-reactive): nothing renders it; only the heartbeat
	// reads it, and the DeviceClient is the only writer.
	lastAppliedCommandId: string | null = null;

	// Performance. Derived from the telemetry median frame period rather than
	// counted per wall-second: at the 2–4 fps the Pi panel actually runs, a
	// per-second counter divides ~3 frames by a ~1 s window, so it lands on
	// integers only (observed: 0/2/3/5/15) and over-reports by one frame
	// (N frames span N-1 intervals). Perf work needs sub-integer resolution.
	measuredFps = $derived(this.telemetry.fps);

	// User-interaction override accessors (pauses auto-behavior for 8 s)
	get userAdjustingAltitude()   { return hasActiveOverride('altitude'); }
	get userAdjustingTime()       { return hasActiveOverride('time'); }
	get userAdjustingAtmosphere() { return hasActiveOverride('atmosphere'); }

	// qualityMode stays as a getter because CesiumModelView takes a narrowed
	// typed interface — dropping it would push the narrowing into every
	// consumer. autoQuality is gone (no more silent FPS-driven demotion).
	get qualityMode() { return this.config.world.qualityMode; }

	// High-frequency animation time (not reactive — updated each tick).
	// Read internally via #createContext to feed engines; no external consumer.
	#time = 0;

	// Private perf counters. 0 = no frame seen yet, so the first frame only
	// establishes the baseline and contributes no period sample.
	#fpsLastTime   = 0;
	// Auto-quality demotion is removed. qualityMode stays as a manual ops
	// pick via model.config.world.qualityMode — no silent FPS-driven switches
	// that fight the color-grade / bloom stages.

	// ── Derived ───────────────────────────────────────────────────────────────
	currentLocation = $derived(LOCATION_MAP.get(this.location) ?? LOCATIONS[0]);
	/** Closed-blind / whisper line: "Dallas → Dubai", else current place name. */
	routeLabel = $derived(
		this.routeFromName
			&& this.routeToName
			&& this.routeFromName !== this.routeToName
			? `${this.routeFromName} → ${this.routeToName}`
			: this.currentLocation.name,
	);
	// timeOfDay IS the local civil time at the depicted location — the whole
	// sky pipeline assumes it (computeSunDirection maps t=12 to sun-overhead,
	// skyState/nightFactor key on local dawn/dusk, and compose's #syncClock
	// converts to UTC via longitude). localTimeOfDay stays as a display alias
	// for the HUD/readouts. It previously ADDED utcOffset on top, which
	// double-counted the offset: a kiosk standing in the depicted city read
	// +5.5 h out, and the time slider (reads this, writes timeOfDay) snapped
	// by the offset on every drag.
	localTimeOfDay = $derived(this.timeOfDay);

	skyState = $derived<SkyState>(getSkyState(this.timeOfDay));

	sceneFog = $derived(this.currentLocation.scene.fog);
	terrainExaggeration = $derived(this.currentLocation.scene.terrain.exaggeration);

	nightFactor = $derived(nightFactorAt(this.timeOfDay));
	dawnDuskFactor = $derived(dawnDuskFactorAt(this.timeOfDay));

	// Rename alias — nightLightScale is the reactive reading used by
	// compose.ts shader uniforms. Plain getter (not $derived) because
	// wrapping a $state in $derived just adds a signal-graph node.
	get nightLightScale() { return this.config.world.nightLightIntensity; }

	effectiveCloudDensity = $derived(
		effectiveCloudDensityFor(this.weather, this.config.atmosphere.clouds.density, this.skyState),
	);

	// ── Constructor ───────────────────────────────────────────────────────────
	constructor() {
		// motion is a process singleton with module-scope state, the
		// AeroWindow is not — on remount (HMR, page nav, liveness reload) the
		// retained _prevHeading made the first tick derive a turn from the
		// PREVIOUS model's last heading, re-introducing the boot bank-slam
		// (same remount-staleness class as the director's module timers,
		// reset via directorReset on flightPatch.resetDirector).
		motionReset();
		// Precedence at boot:
		//   1. Show opening — pickDailyShow(showRotationSeed()) every 2 h UTC
		//      slot; all Pis agree; reloads within a slot match (multi-Pi safe)
		//   2. Persisted operator prefs (altitude, ambient, toggles) — NOT
		//      location/weather (those always come from the rotation seed)
		//   3. Dev-mode night override (only if no persisted state AND DEV)
		//   4. Real-time wall-clock when syncToRealTime
		// URL params and admin/autopilot come later in the page lifecycle.
		applyShowOpening(this, pickDailyShow());
		const persisted = loadPersistedState();
		this.#applyPersisted(persisted);
		this.#syncWeatherConfig();

		// Dev-mode: when iterating in `bun run dev` with nothing persisted yet,
		// default to deep night (22:00) instead of the show's dawn opening, so
		// the night-light pipeline (VIIRS / shader / warm glow) is visible by
		// default while developing. Production install ships with the show's
		// dawn opening; this branch is gated on import.meta.env.DEV so it never
		// reaches the Pi.
		// hasPersistedState(), not `Object.keys(persisted).length === 0`: load
		// strips fields it refuses to restore, so a dev box that had only ever
		// stored one of those loads as {} and would otherwise look like a browser
		// that had never run the app — firing this branch and forcing Real Time
		// off for someone who does have state.
		// Gates resolved together in ./aero-window-boot — each one below has
		// broken before, and each failed silently as "the wall is showing the
		// wrong thing" rather than as an error.
		const boot = decideBoot({
			isDev: import.meta.env.DEV,
			hasWindow: typeof window !== 'undefined',
			hasPersisted: hasPersistedState(),
			syncToRealTime: this.syncToRealTime,
		});
		if (boot.applyDevNightOverride) {
			this.syncToRealTime = false;
			this.timeOfDay = DEV_NIGHT_HOUR;
		}

		// Move the flight to the resolved boot location. applyShowOpening only
		// writes the `location` FIELD (no side-effect hooks by design), and
		// #applyPersisted moves the flight only when a location was persisted —
		// so a fresh boot orbited FlightSimEngine's class-field default (Dubai)
		// while `location` said otherwise, showing the wrong city until the
		// director's first flight (found in the Jul 8 visual A/B). Idempotent:
		// the orbit seed is deterministic per location+day, so re-syncing after
		// a persisted setLocation() recomputes the identical orbit.
		this.flight.setLocationWithSky(this.location, this.skyState);

		// Gated on syncToRealTime (matching the recurring sync in +page.svelte)
		// AND on the dev override, which would otherwise be overwritten by the
		// real hour one line after being set. Previously that exclusion was
		// implicit — it worked only because the override had just mutated
		// syncToRealTime and this re-read it.
		if (boot.syncTimeFromSystem) {
			this.updateTimeFromSystem();
		}

		// Boot complete — from here on, applyConfigPatch stamps the CRDT
		// with the wall-clock again (see #booting).
		this.#booting = false;

		// Restore last media mode after boot so Chromium reload keeps video/
		// slideshow (not daily-rotated; separate storage key). force+savedAt
		// keeps a later stale SSE command from winning without a fresher stamp.
		const storedMode = loadDisplayMode();
		if (storedMode && storedMode.mode !== 'flight') {
			this.setDisplayMode(storedMode.mode, storedMode.payload, {
				decidedAtMs: storedMode.savedAt || Date.now(),
				force: true,
			});
		}
	}

	/** Sync AtmosphereConfig.weather fields from WEATHER_EFFECTS on weather change. */
	#syncWeatherConfig(): void {
		const fx = WEATHER_EFFECTS[this.weather];
		// Unstamped during boot (see #booting) — the weather recipe is a local
		// default, not a fleet decision.
		syncAtmosphereWeather(fx, this.#booting ? { stamp: false } : undefined);
	}

	#applyPersisted(saved: Partial<PersistedState>): void {
		// location/weather/syncToRealTime ignored — boot policy (see persistence.ts).
		// applyConfigPatch is unstamped while #booting so offline admin LWW wins.
		applyPersistedToHost(this, saved);
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	setLocation(id: LocationId): void {
		this.location = id;
		this.flight.setLocationWithSky(id, this.skyState);
		// Real Time follows the depicted city — without this, a hop from
		// Hyderabad to Dallas kept IST hours as timeOfDay and the sky/HUD
		// local clock stayed wrong until the next minute tick.
		if (this.syncToRealTime) this.updateTimeFromSystem();
		const scene = this.currentLocation.scene;
		// Deterministic jitter — same daySeed() ^ location-hash seed as the
		// orbit (flight.setLocationWithSky). All 3 Pis in a panorama compute
		// IDENTICAL cloud/haze settings on arrival, so the seam stays aligned
		// and the peer-synced writes converge instead of fighting via LWW.
		// Was Math.random(): each Pi jittered independently per pane.
		const rng = createSeededRng((daySeed() ^ hashString(id)) >>> 0);
		const jitter = (base: number, amp: number, lo: number, hi: number) =>
			clamp(base + (rng() - 0.5) * amp, lo, hi);
		// Route through applyConfigPatch so the CRDT stamps the writer + the
		// new value lands in the timestamp index. Earlier this wrote
		// config.atmosphere.* directly, which propagated to peers via the
		// peer-sync $effect but left the originator's CRDT timestamp stale —
		// any subsequent admin push (with timestamp > 0) would silently win.
		this.applyConfigPatch('atmosphere.clouds.density', jitter(scene.clouds.density, 0.24, 0.1, 1.0));
		this.applyConfigPatch('atmosphere.clouds.speed', jitter(scene.clouds.speed, 0.24, 0.2, 1.6));
		this.applyConfigPatch('atmosphere.haze.amount', jitter(this.config.atmosphere.haze.amount, 0.03, 0, 0.18));
	}

	setAltitude(alt: number): void {
		const { min, max } = this.config.camera.altitude;
		this.flight.setAltitude(alt, { min, max });
		this.onUserInteraction('altitude');
	}

	setTime(t: number): void {
		this.timeOfDay = clamp(t, 0, 24);
		this.onUserInteraction('time');
	}

	setWeather(w: WeatherType, opts?: { trackUserOverride?: boolean }): void {
		if (!isValidWeather(w)) return;
		this.weather = w;
		this.#syncWeatherConfig();
		// Autopilot weather rolls pass trackUserOverride:false — a machine
		// decision must not arm the 8 s user-override that gates the
		// director's own tickRandomize (it would pause the very randomiser
		// that issued the roll).
		if (opts?.trackUserOverride !== false) this.onUserInteraction('atmosphere');
	}

	// ── Scene timers ─────────────────────────────────────────────────────────
	// Flyover beat + lock-step cruise both live in SceneTimers — see
	// ./aero-window-timers. They were two timer collections and three teardown
	// call sites in this file, which made "does every path cancel everything?"
	// a question you could only answer by reading all 800 lines.
	//
	// The methods below stay on the class because they are the public surface
	// the fleet client and protocol type against (FleetClientModel.scheduleFlyover).
	readonly #timers = new SceneTimers(() => ({
		skyState: this.skyState,
		config: this.config,
		flight: this.flight,
		applyConfigPatch: (path, value) => this.applyConfigPatch(path, value),
		stampRoute: (toId) => this.#stampRoute(toId),
	}));

	enterFlyover(pitchDeg: number, altitudeFt: number): void {
		this.#timers.enterFlyover(pitchDeg, altitudeFt);
	}

	exitFlyover(): void {
		this.#timers.exitFlyover();
	}

	/** Schedule enter@transitionAtMs and exit@transitionAtMs+durationMs, locked
	 *  to the same instant on leader and every follower. */
	scheduleFlyover(beat: VantageBeat, transitionAtMs: number): void {
		this.#timers.scheduleFlyover(beat, transitionAtMs);
	}

	#scheduleFlyTo(locationId: LocationId, transitionAtMs: number): void {
		this.#timers.scheduleFlyTo(locationId, transitionAtMs);
	}

	/** Record origin → destination names for the passenger blind watermark.
	 *  Stays here: it writes $state, which this class owns. */
	#stampRoute(toId: LocationId): void {
		const toName = LOCATION_MAP.get(toId)?.name ?? toId;
		// Origin is the place we still are (location only flips on arrival).
		this.routeFromName = this.currentLocation.name;
		this.routeToName = toName;
	}

	#cancelScheduledFlyTo(): void {
		this.#timers.cancelScheduledFlyTo();
	}

	setFlightSpeed(n: number): void {
		// Honor the cruise bounds defined in the config tree (admin-tunable
		// SSOT). Earlier this hard-coded (0.1, 5) which contradicted the
		// slider ceiling — fleet PATCHes could land speeds above what the
		// operator could set. Warp departure bypasses this clamp intentionally.
		const { minSpeed, maxSpeed } = this.config.camera.cruise;
		this.flight.flightSpeed = clamp(n, minSpeed, maxSpeed);
	}

	updateTimeFromSystem(): void {
		// timeOfDay is LOCAL civil time at the depicted location (or the admin
		// IANA override). Prefer location.timeZone so DST is correct; fixed
		// utcOffset is only a fallback (see resolveLocalHours).
		const loc = this.currentLocation;
		const override = this.config.director.daylight.timeZoneOverride?.trim() ?? '';
		this.timeOfDay = resolveLocalHours({
			timeZone: loc.timeZone,
			utcOffset: loc.utcOffset,
			zoneOverride: override,
		});
	}

	pickNextLocation(): LocationId {
		// `nightLitCitiesOnly` means "only fly to LIT cities AT NIGHT" — its own
		// config comment says so. It was being passed unconditionally, with no
		// night gate, which is a different and much narrower rule: only ever fly
		// to cities that have buildings, at any hour.
		//
		// The cost was four locations and eight authored scenarios that could
		// never be reached by autopilot OR by a blind pull (which routes through
		// this same picker): the Himalayas, the Pacific, the Sahara, and Above
		// Clouds — every location in the catalogue with hasBuildings:false, and
		// between them the most distinctive frames in the whole product.
		//
		// Gating on actual darkness restores them by day, which is also when a
		// wide, quiet, low-information view next to someone's desk is worth the
		// most. At night the lit-city restriction still applies, because that is
		// when city lights are the thing worth flying to.
		// Gated on cityLightAmount, the existing civil-twilight SSOT for "are the
		// discrete city lights on" — deliberately NOT on vantage.minNightFactor,
		// which belongs to the flyover beat. Borrowing that knob would mean
		// retuning the beat silently rewrites the destination pool.
		const lightsAreOn = lightingState(this.timeOfDay, this.nightFactor).cityLightAmount > 0;
		return pickNextLocation(this.location, this.timeOfDay, {
			nightLitOnly: this.config.director.autopilot.nightLitCitiesOnly && lightsAreOn,
		});
	}

	/**
	 * Human / ops scene change (blind pull, LocationPicker).
	 *
	 * Leaders only. Broadcasts `director_decision` to corridor peers; when the
	 * broadcast actually went out (panorama leader with followers), the local
	 * flyTo is scheduled at the same transitionAtMs so the leader and edge
	 * panes move in wall-clock lock-step — same rule as the autopilot path.
	 * When solo (no broadcast, nobody to lock-step with), it flies
	 * immediately — operator feedback beats wall-clock alignment for a blind
	 * pull. Edge followers ignore — they only move when a `director_decision`
	 * arrives via the fleet client and `applyScene()` runs. Without this gate
	 * a center blind-pull desynced the corridor (one pane cruised; left/right
	 * stayed in orbit).
	 */
	flyTo(locationId: LocationId): void {
		if (!isGroupLeader(this.config.camera.parallax.role)) {
			this.telemetry.recordEvent('info', {
				event: 'flyTo_ignored',
				reason: 'follower',
				locationId,
				role: this.config.camera.parallax.role,
			});
			return;
		}
		this.#cancelScheduledFlyTo();   // a human scene change supersedes a pending autopilot cruise
		this.exitFlyover();   // a blind pull mid-beat must not carry flyover altitude/pitch into the cruise (autopilot + applyScene already do this)
		const transitionAtMs = this.#broadcastLocationDecision(locationId, 'manual');
		if (transitionAtMs !== null) this.#scheduleFlyTo(locationId, transitionAtMs);
		else {
			this.#stampRoute(locationId);
			this.flight.flyTo(locationId, this.skyState);
		}
	}

	/**
	 * Fan-out the autopilot's periodic ambient jitter to corridor peers.
	 *
	 * tickRandomize runs on the LEADER ONLY — directorTick returns early for
	 * followers (autopilot.svelte.ts:46) — and its output used to be applied
	 * locally and never sent. So every 3–8 min the centre pane re-rolled its
	 * cloud density / speed / haze (and sometimes the weather) while the edge
	 * panes kept the old values, and the three-screen wall visibly disagreed
	 * until the next location change resynced it via director_decision.
	 *
	 * The arrival path had already been fixed for this same bug class — see the
	 * seeded-RNG jitter in setLocation and its `Was Math.random()` note — but
	 * the periodic path was never brought along.
	 *
	 * Sent as `set_config`, the existing leader→follower ambient channel (it
	 * already carried cloudDensity), rather than inventing a message type.
	 * Deliberately NOT lock-stepped to a transitionAtMs like a location change:
	 * these are slow atmospheric values with no cut to hide, so applying them a
	 * few hundred ms apart is invisible, and skipping the schedule avoids the
	 * pending-timeout bookkeeping that path needs.
	 */
	#broadcastAmbientJitter(configs: Array<{ path: string; value: unknown }>): void {
		broadcastAmbientJitter(
			this.#fleetBroadcast,
			this.config.camera.parallax.role,
			resolveBinding().groupId,
			configs,
		);
	}

	/**
	 * Fan-out a location change to corridor peers. Shared by autopilot and
	 * human flyTo so the wire shape cannot drift between the two paths.
	 * Returns the transitionAtMs placed on the wire so the caller can lock
	 * its own local transition to the same instant — or null when nothing
	 * was broadcast (no fleet hook, or solo). Callers fly immediately on null.
	 */
	#broadcastLocationDecision(locationId: LocationId, scenarioId: string): number | null {
		return broadcastLocationDecision(
			this.#fleetBroadcast,
			this.config.camera.parallax.role,
			resolveBinding().groupId,
			{ locationId, scenarioId, weather: this.weather },
		);
	}

	/**
	 * Switch kiosk display path. Invalid payloads refuse the mode change for
	 * media modes (stay on current) so a bad admin push cannot blank the wall.
	 * flight always applies and clears media state.
	 *
	 * Implementation: `applyDisplayMode` in aero-window-display.ts (LWW + parse).
	 *
	 * @returns true if the mode was applied; false if rejected (also logged).
	 */
	setDisplayMode(
		mode: DisplayMode,
		payload?: string,
		opts?: { decidedAtMs?: number; force?: boolean },
	): boolean {
		return applyDisplayMode(this, mode, payload, opts);
	}

	applyScene(locationId: LocationId, weather?: WeatherType): void {
		this.exitFlyover();   // a location change ends any active flyover beat
		this.#cancelScheduledFlyTo();   // …and supersedes a pending autopilot cruise
		this.#stampRoute(locationId);
		this.flight.flyTo(locationId, this.skyState);
		if (weather) { this.weather = weather; this.#syncWeatherConfig(); }
	}

	setQualityMode(mode: QualityMode): void {
		this.applyConfigPatch('world.qualityMode', mode);
	}

	/**
	 * Path-targeted config patch. Routes into the flat config tree via
	 * the generic dispatcher. Returns true if the path was recognised.
	 * Called by the fleet v2 `config_patch` message handler — remote fleet
	 * writes pass `opts.remote` (the CRDT stamp) so the LWW merge carries
	 * the originator's timestamp instead of a fresh wall-clock one.
	 */
	applyConfigPatch(path: string, value: unknown, opts?: ConfigPatchOpts): boolean {
		this.telemetry.recordEvent('config_patch', { path, value });
		// Boot-time applications skip the CRDT stamp (see #booting); an
		// explicit opts (e.g. a remote fleet stamp) always wins.
		return _applyConfigPatch(path, value, opts ?? (this.#booting ? { stamp: false } : undefined));
	}

	onUserInteraction(type: 'altitude' | 'time' | 'atmosphere'): void {
		trackOverride(type);
	}

	getPersistedSnapshot(): PersistedState {
		return buildPersistedSnapshot(this);
	}

	// ── Tick pipeline ─────────────────────────────────────────────────────────

	tick(delta: number): void {
		if (!Number.isFinite(delta) || delta <= 0 || delta > 0.1) return;
		const frameStart = performance.now();
		this.#time = (this.#time + delta) % 3600;
		this.#reportFrame(frameStart);

		const ctx = this.#createContext();

		const flightPatch = this.flight.tick(delta, ctx);
		// Cruise FSM blind open/close — same gate as human use-blind (single
		// write path). stamp:false: local-only chrome during flyTo; not a
		// fleet decision (shell.blindOpen is not PEER_SYNC'd).
		if (flightPatch.blindOpen !== undefined) {
			this.applyConfigPatch('shell.blindOpen', flightPatch.blindOpen, { stamp: false });
		}
		if (flightPatch.locationArrived)         this.setLocation(flightPatch.locationArrived);
		if (flightPatch.resetDirector)           directorReset(ctx);

		// Refresh heading/lat/lon AFTER flight.tick() so motionStep sees current values.
		// flight.tick() needs ctx for camera/orbit config reads, but mutates heading/lat/lon.
		ctx.heading = this.flight.heading;
		ctx.lat    = this.flight.lat;
		ctx.lon    = this.flight.lon;

		motionStep(delta, ctx);

		ctx.isOrbitMode      = this.flight.flightMode === 'orbit';
		ctx.pickNextLocation = () => this.pickNextLocation();
		// Phase 7 — solo + center are leaders (run autopilot); left/right follow
		// the leader's director_decision. The rule lives in fleet/parallax as
		// isGroupLeader: it was ALSO inlined here, so the panorama's leader
		// definition existed in two places. If they ever disagreed, two Pis
		// would both run the autopilot and fight over the location, or none
		// would and the wall would freeze on one scene.
		ctx.isLeader = isGroupLeader(this.config.camera.parallax.role);
		const directorPatch = directorTick(ctx);

		if (directorPatch.configs) {
			for (const { path, value } of directorPatch.configs) {
				// Autopilot weather rolls must not arm the user-override
				// cooldown that gates tickRandomize — they ARE the randomiser.
				if (path === 'weather') this.setWeather(value as WeatherType, { trackUserOverride: false });
				else this.applyConfigPatch(path, value);
			}
			this.#broadcastAmbientJitter(directorPatch.configs);
		}
		if (directorPatch.nextLocation) {
			// A new location cancels any active/pending flyover beat — the
			// world is moving, so pop the camera back to the normal look.
			this.exitFlyover();
			// Phase 7 — broadcast BEFORE flying locally (shared with flyTo()).
			// transitionAtMs is 2.5s ahead so followers can lock to wall-clock
			// and absorb ~±200 ms NTP drift. When the broadcast went out, the
			// leader schedules its OWN flyTo at the same instant (same
			// mechanism as the vantage path below) — starting immediately
			// reopened the leader's blinds ~2.5 s ahead of the edge panes,
			// tearing the panorama. When nothing was broadcast (solo — no
			// followers to lock-step with), the leader flies immediately;
			// scheduling would only add a dead 2.5 s delay.
			const transitionAtMs = this.#broadcastLocationDecision(directorPatch.nextLocation, 'autopilot');
			if (transitionAtMs !== null) this.#scheduleFlyTo(directorPatch.nextLocation, transitionAtMs);
			else {
				this.#stampRoute(directorPatch.nextLocation);
				this.flight.flyTo(directorPatch.nextLocation, this.skyState);
			}
		} else if (directorPatch.vantageBeat) {
			// Leader chose a night-city flyover. Same rule as the location
			// decision above: broadcast + lock-step only when there are
			// followers (role 'center'); solo enters immediately.
			const now = Date.now();
			const isGroup = this.#fleetBroadcast && this.config.camera.parallax.role === 'center';
			const transitionAtMs = isGroup ? now + TRANSITION_DELAY_MS : now;
			if (isGroup) {
				this.#fleetBroadcast!({
					v: 2,
					type: 'vantage_beat',
					decidedAtMs: now,
					transitionAtMs,
					durationMs: directorPatch.vantageBeat.durationMs,
					pitchDeg: directorPatch.vantageBeat.pitchDeg,
					altitudeFt: directorPatch.vantageBeat.altitudeFt,
					groupId: resolveBinding().groupId,
				});
			}
			this.scheduleFlyover(directorPatch.vantageBeat, transitionAtMs);
		}

		this.telemetry.recordFrame(performance.now() - frameStart);
	}

	// Context assembly lives in ./aero-window-context — mechanical marshalling
	// wrapped around the wall-clock clamp, which has real edge cases (suspended
	// tab, NTP step-back) that are worth testing without a model.
	//
	// tick() itself stays here on purpose: it is the update ORDER, and that is
	// the thing you want readable in sequence at the top level.
	readonly #ctxBuilder = new SimulationContextBuilder({
		camera: _config.camera,
		director: _config.director,
	} as Pick<SimulationContext, 'camera' | 'director'>);

	#createContext(): SimulationContext {
		return this.#ctxBuilder.build(this, this.#time);
	}

	// Feed the real, *unclamped* wall-clock gap between frames to telemetry.
	// The game loop clamps its `dt` to 100 ms so the simulation stays stable
	// through a stall — using that clamped value here would pin every reading
	// below 10 fps at exactly 10 fps.
	#reportFrame(now: number): void {
		if (this.#fpsLastTime > 0) {
			this.telemetry.recordFramePeriod(now - this.#fpsLastTime);
		}
		this.#fpsLastTime = now;
	}

	destroy(): void {
		// override timestamps are module-level — nothing to teardown there.
		// One call now covers both timer collections; previously this named
		// each one and a new timer could be added without being cancelled here.
		this.#timers.destroy();
	}
}

// ─── Context DI ──────────────────────────────────────────────────────────────
//
// Hand-rolled over `createContext()` for ONE reason: createContext's getter
// THROWS `missing_context` when unset, with no non-throwing companion and no
// way to reach its private key. `tryUseAeroWindow()` must be able to answer
// "is there a model?" with `null`, because AtmosphereControls / LightingControls
// mount both inside the kiosk tree and standalone in /admin. Owning the key
// here lets `hasContext` do that check safely.
const AERO_WINDOW_KEY = Symbol('aero-window');

function getAeroWindowContext(): AeroWindow {
	return getContext<AeroWindow>(AERO_WINDOW_KEY);
}

export function createAeroWindow(): AeroWindow {
	const model = new AeroWindow();
	setContext(AERO_WINDOW_KEY, model);
	return model;
}

export function useAeroWindow(): AeroWindow {
	if (!hasContext(AERO_WINDOW_KEY)) {
		throw new Error('useAeroWindow() called outside component tree');
	}
	return getAeroWindowContext();
}

/**
 * Non-throwing variant for components mountable both inside the kiosk
 * tree (model present) and standalone in /admin (no AeroWindow context —
 * admin writes go through the module-level config gate instead, and
 * startPeerSync propagates them to the fleet).
 *
 * ─── ⚠ WHY THIS USES hasContext RATHER THAN `?? null` ───────────────────────
 * `createContext()`'s getter does not return undefined when the context is
 * unset — it THROWS `missing_context`. So the previous `getAeroWindowContext()
 * ?? null` could never yield null: the ?? was dead code, and mounting any of
 * these components without a provider killed the whole page during init.
 * That is what blanked /admin — a white screen with one console error, while
 * `bun run check` and every unit test stayed green.
 *
 * `hasContext` is the only safe pre-check, and it must be called with the SAME
 * key the getter uses, which is why the key lives here beside the accessors
 * rather than being hidden inside createContext's closure.
 */
export function tryUseAeroWindow(): AeroWindow | null {
	return hasContext(AERO_WINDOW_KEY) ? getAeroWindowContext() : null;
}
