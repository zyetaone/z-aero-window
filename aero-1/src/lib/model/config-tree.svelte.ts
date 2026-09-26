/**
 * Config — flat reactive state for all tuneable parameters.
 *
 * This is the SSOT for every tuning number the app exposes. Consumers
 * read from `config.*` rather than importing raw constants; the default
 * literals below are the place to edit tuning.
 *
 * Design:
 * - One $state object per namespace (no class-per-namespace)
 * - Generic setByPath(root, path, value) handles ALL mutations — no switch statements
 * - Sync functions (syncFromMode, syncFromEffects) are plain functions, not class methods
 */


import { type ConfigNamespace } from './config-namespaces';
import { WEATHER_EFFECTS } from '$content/weather';
import { type DeviceRole, type QualityMode, type WeatherType } from '$lib/types';
import { CRDTStore, setCRDTDeviceId, getCRDTDeviceId } from './crdt-store';
import { setByPath, readByPath } from '$lib/utils';

/**
 * Cruise speed literals — seed `camera.cruise`, flight speedNorm reference,
 * and admin scene slider bounds. One place so maxSpeed cannot drift below
 * defaultSpeed (which silently slows authored scenario legs on first clamp).
 */
export const CRUISE_SPEED_DEFAULTS: {
	minSpeed: number;
	defaultSpeed: number;
	maxSpeed: number;
} = {
	minSpeed: 0.1,
	/** Scenario waypoint durations are authored at this speed. */
	defaultSpeed: 6.0,
	maxSpeed: 8.0,
};

// ─── Atmosphere ───────────────────────────────────────────────────────────────

export const atmosphere = $state({
	clouds: {
		density: 0.85,   // CLOUD_DENSITY_MAX(1.0) * 0.85
		speed: 0.6,      // CLOUD_SPEED_MIN(0.2) + 0.4
		layerCount: 3,
		opacityScale: 1.0, // Multiplies per-sprite opacity at frame time (Three-side tuner).
	},
	haze: {
		amount: 0.07,    // HAZE_MIN(0) + 0.07
		min: 0,
		max: 0.15,
	},
	weather: {
		turbulence: WEATHER_EFFECTS.cloudy.turbulence,
		hasLightning: WEATHER_EFFECTS.cloudy.hasLightning,
		rainOpacity: WEATHER_EFFECTS.cloudy.rainOpacity,
		windAngle: WEATHER_EFFECTS.cloudy.windAngle,
		cloudDensityRange: [...WEATHER_EFFECTS.cloudy.cloudDensityRange] as [number, number],
		nightCloudFloor: WEATHER_EFFECTS.cloudy.nightCloudFloor,
		filterBrightness: WEATHER_EFFECTS.cloudy.filterBrightness,
		lightningMinInterval: 5,     // seconds
		lightningMaxInterval: 30,
		lightningDecayRate:   8,
	},
});


// ─── Camera ──────────────────────────────────────────────────────────────────

interface CameraShape {
	orbit: {
		driftRate: number;
		majorMin: number;
		majorMax: number;
		breathePeriod: number;
	};
	cruise: {
		departureDurationSec: number;
		transitDurationSec: number;
		arrivalHoldMs: number;
		defaultSpeed: number;
		minSpeed: number;
		maxSpeed: number;
	};
	motion: {
		bankAngleMax: number;
		bankSmoothing: number;
		bankPitchCouple: number;
		breathingPeriod: number;
		breathingAmplitude: number;
		engineVibeFreqX: number;
		engineVibeFreqY: number;
		engineVibeAmp: number;
		bumpMinInterval: number;
		bumpMaxInterval: number;
		bumpDecay: number;
		bumpRingFreq: number;
		bumpAmplitude: number;
		turbulenceMultipliers: { severe: number; moderate: number; light: number };
		turbulenceOffsetY: number;
	};
	altitude: {
		default: number;
		min: number;
		max: number;
		driftAmplitudeFt: number;
		driftPeriodSec: number;
	};
	parallax: {
		role: DeviceRole;
		headingOffsetDeg: number;
		fovDeg: number;
		panoramaArcDeg: number;
		fuselageOffsetM: number;
	};
	/** Camera pitch override in degrees (0 = off → normal wing-out look; e.g.
	 *  −60 looks DOWN at the city). Lab "night flyover" preview; ship = 0. */
	flyoverPitchDeg: number;
	effectiveHeading(this: CameraShape, baseHeading: number): number;
}

const _camera: CameraShape = {
	orbit: {
				driftRate: 0.0011, // deg/s at speedNorm 1 ≈ 120 m/s: ~85 km loop in ~12 min. Was 0.018 with the raw ×6 knob: a lap every ~11 s.
		majorMin: 0.08,
		majorMax: 0.25,
		breathePeriod: 180,
	},
	cruise: {
		departureDurationSec: 2.0,
		transitDurationSec: 2.0,
		arrivalHoldMs: 8000,
		...CRUISE_SPEED_DEFAULTS,
	},
	motion: {
				bankAngleMax: 16.0, // max horizon tilt on turns
		bankSmoothing: 2.5,
				bankPitchCouple: 0.9, // tilt-to-pitch coupling (more ground/sky)
				breathingPeriod: 22, // cabin nose up/down cycle
		breathingAmplitude: 2.6,
				engineVibeFreqX: 7, // engine hum freq
		engineVibeFreqY: 11, // offset to avoid Lissajous lock
		engineVibeAmp: 0.5, // hum amplitude
				bumpMinInterval: 75, // min sec between turbulence bumps
		bumpMaxInterval: 260,
		bumpDecay: 6, // bump decay rate
		bumpRingFreq: 7, // bump ring frequency
		bumpAmplitude: 0.35, // bump amplitude
		turbulenceMultipliers: { severe: 0.55, moderate: 0.3, light: 0.18 },
		turbulenceOffsetY: 0.008, // turbulence chatter range
	},
	altitude: {
		default: 35000,         // feet
		min: 10000,
		max: 65000,
		// Slow climb/descent breathing around the location's preferred altitude.
		// Without it the aircraft settles within ~25 s of arrival and then holds
		// one number until the next hop — the ground never changes scale, which
		// is the single biggest tell that this is a camera on a rail rather than
		// an aeroplane.
		//
		// Driven by WALL CLOCK, not by a random roll or an accumulating local
		// timer: all three panes evaluate the same sine at the same instant, so
		// the panorama cannot drift apart (invariant #4). A Pi that reboots
		// mid-cycle rejoins at the correct phase rather than restarting it.
		//
		// 3500 ft over 7 min is deliberately below the conscious-notice
		// threshold — the intent is that the view breathes, not that anyone sees
		// it climb. Set amplitude 0 to disable.
		driftAmplitudeFt: 3500,
		driftPeriodSec: 420,
	},
	parallax: {
		role: 'solo' as DeviceRole,
		headingOffsetDeg: 0,
		fovDeg: 60,
		panoramaArcDeg: 44,
				fuselageOffsetM: 0, // multi-Pi wing perspective offset
	},
	flyoverPitchDeg: 0, // 0 = off (ship). Lab night-flyover sets ~−60 to look down.
	effectiveHeading(this: typeof _camera, baseHeading: number): number {
		return (baseHeading + this.parallax.headingOffsetDeg + 360) % 360;
	},
};

/**
 * Cabin ambience. Synthesized in `$lib/shell/audio/ambient-audio` — there are
 * no audio files in this repo, so nothing here points at a bundled asset.
 *
 * `enabled` ships FALSE. Audio is the one subsystem whose correct level cannot
 * be judged anywhere but the room: the Waveshare panels have built-in speakers
 * of unknown response, and three of them share one corridor. Shipping it on at
 * a guessed volume risks an install that is actively unpleasant and that
 * nobody on site knows how to mute. The operator turns it on once, sets the
 * level against the real room, and it persists from there.
 *
 * `musicUrl` is operator-supplied and empty by default. A music bed is the
 * only layer we cannot synthesize, and shipping one would mean shipping
 * someone else's licence (see the EOX/CARTO findings) — so the product
 * provides the slot, not the content.
 */
export const audio = $state({
	enabled: false,
	masterVolume: 0.5,
	engineVolume: 0.6, // the bed — carries the cabin
	weatherVolume: 0.4, // rides on top only when it's actually raining
	musicVolume: 0.3, // ducked under the ambience by default
	musicUrl: '',
});

export const camera = $state(_camera);

export type CameraConfig = typeof _camera;

// `panoramaArcDeg` is REQUIRED, not defaulted. It used to default to 44,
// duplicating the config literal above: if an installation ever retunes
// `camera.parallax.panoramaArcDeg`, a defaulted call site would keep computing
// yaw from the stale 44 and the 3-Pi seam would drift with nothing to point
// at. The sole caller already passes the live config value; making the
// parameter mandatory means a future caller cannot silently pick the old one.
function headingOffsetForRole(role: DeviceRole, panoramaArcDeg: number): number {
	switch (role) {
		case 'left':  return -panoramaArcDeg / 2 + panoramaArcDeg / 6;
		case 'right': return  panoramaArcDeg / 2 - panoramaArcDeg / 6;
		default:            return 0;
	}
}

function fuselageOffsetForRole(role: DeviceRole): number {
	switch (role) {
		case 'left':  return -6;
		case 'right': return  6;
		default:            return 0;
	}
}
export function setParallaxRole(role: DeviceRole): void {
	// Deliberately bypasses applyConfigPatch / the CRDT stamp: the parallax
	// role is device-local (each Pi knows which pane it is), so broadcasting
	// it to peers would be wrong.
	camera.parallax.role = role;
	applyRoleDerived(role);
}


// ─── Director ─────────────────────────────────────────────────────────────────

export const director = $state({
	daylight: {
		syncIntervalMs: 60_000,        // 1 minute
		/**
		 * Admin IANA zone override for Real Time. Empty = use the depicted
		 * location's `timeZone`. When set (e.g. America/Chicago), all Real Time
		 * updates follow that zone regardless of the city on screen — useful for
		 * a wall that should always show HQ local time while flying elsewhere.
		 */
		timeZoneOverride: '',
	},
	autopilot: {
		enabled: true,
		// First ambient jitter / first city hop after boot (seconds, wall-clock).
		// Was 120–300 / 240–360 — felt stuck on one city for long stretches on Pi.
		initialMinDelay: 45,
		initialMaxDelay: 90,
		// Ambient re-roll (weather / cloud jitter), NOT a location change.
		// 60-120 s → 180-360 s. With hops slowed to 7-15 min this became the
		// dominant churn: something visibly stepped every minute or two, which
		// undoes most of the calm the hop change buys. Weather that re-rolls
		// twice as often as a real front moves reads as flicker, not weather.
		// Also halves the fleet's ambient broadcast traffic, since each roll is
		// a leader→peers message.
		subsequentMinDelay: 180,
		subsequentMaxDelay: 360,
		weatherChangeChance: 0.2,
		weatherPool: Object.freeze(['clear', 'cloudy', 'cloudy', 'rain', 'overcast', 'storm']) as readonly WeatherType[],
		// Between location hops while in orbit (seconds, wall-clock).
		// ─── 90-180 s → 420-900 s (7-15 min) ────────────────────────────────
		// Two reasons, one of them not a matter of taste at all.
		//
		// THE MEASURABLE ONE. The authored scenarios run 160-270 s (21 of them,
		// median ~210). The old hop window was 90-180 s, so the hop fired before
		// the circuit finished in EVERY case — even the shortest scenario
		// outlasts the longest old hop. No authored flight path has ever played
		// to completion on this wall. Roughly 4,400 seconds of hand-authored
		// choreography was being shown exclusively as fragments.
		//
		// THE EXPERIENCE ONE. Every hop is a full occlusion event: the blind is
		// forced shut on departure and open on arrival. At the old cadence a
		// desk worker got 20-40 blind slams an hour, 500+ across a working day.
		// That is a slideshow with a shutter, not the calm ambient piece this is
		// sold as — and peripheral motion is the one thing that reliably steals
		// focus from someone trying to work. The old numbers were tuned for a
		// passer-by, who needs a change inside their 15-second window; the desk
		// worker needs the exact opposite.
		//
		// A location should be somewhere you settle into. Dynamism now comes
		// from WITHIN the location instead of from cutting away: the altitude
		// breathes (altitudeDriftFt), the night lights glimmer, weather drifts.
		// Longer holds also finally make the vantage flyover beat reachable — it
		// needs 900 s of continuous night flying, which no 180 s hop could ever
		// accumulate even after its reset bug was fixed.
		//
		// These are NOT peer-synced, so this default genuinely reaches the Pis.
		directorMinInterval: 420,      // 7:00
		directorMaxInterval: 900,      // 15:00
				nightLitCitiesOnly: true, // auto-flight only to lit cities at night
				vantage: {
			enabled: true,
			// Only fires at night (nightFactor > this) — the beat is a
			// city-lights moment; by day it would be a downward tilt at
			// bright terrain. Gates the whole thing to the evening/night loop.
			minNightFactor: 0.6,
			// Interval window in seconds between beats (~15–40 min).
			minIntervalSec: 900,
			maxIntervalSec: 2400,
			// How long the flyover holds before auto-returning to orbit.
			durationSec: 45,
			// Camera look-down pitch while active (deg). compose.ts applies it.
			pitchDeg: -60,
			// Altitude to descend to for the beat (feet) — low enough to read
			// the street grid, clamped to camera.altitude.min at apply time.
			altitudeFt: 9000,
		},
	},
	ambient: {
		// Drift ranges per randomisation cycle.
		cloudDensityShift: 0.3,
		cloudDensityMin: 0.2,
		cloudDensityMax: 1.0,
		cloudSpeedShift: 0.4,
		cloudSpeedMin: 0.2,
		cloudSpeedMax: 1.5,
		hazeShift: 0.04,
		hazeMin: 0,
		hazeMax: 0.15,
	},
});


// ─── World ───────────────────────────────────────────────────────────────────

export const world = $state({
		useThreeOverlay: true, // Three.js overlay on/off
	// Hash-palette night post-process — replaces aero-color-grade with the
	// 3-stop sodium/amber/warm-white palette + 3% red sparks (Apr-15).
	// Default true: this IS the production night look. Toggle off via SidePanel
	// or ?hashpalette=0 to revert to aero-color-grade for comparison.
	useHashPalette: true,
		baseNightSaturation: 0.50, // keep colour at dusk, shader desat handles deep night
		nightLightIntensity: 5.0, // VIIRS + shader city-glow intensity (0..5; gain-normalised)
		bloomContrast: 128,
	// Roads-first night (2026-08 de-soak): wider sigma + high brightness turned
	// city cores into one amber puddle. Tighter bloom lets road strokes and
	// window points stay distinct; night bloom stays ON (see qualityPaintGates).
	bloomBrightness: -0.22,
	bloomSigma: 2.8,
	buildingsEnabled: true,
	buildingEmissiveMax: 0.6, // max window-glow intensity at night
		// 3.0 → 1.6 → 1.25. VIIRS is a MASK (hash-palette.ts); roads carry
		// structure. High additive on a soft mask = solid amber sheet ("soaky").
		// 1.25 keeps road/window cores lit without re-soaking districts.
		additiveStrength: 1.25, // emissive boost on lit pixels
		// Mask shaping — the "photoshop" controls.
		// maskGamma > 1 pulls the mask toward its bright cores, so the soft
		// VIIRS halo falls away and the roads / lit building profiles read
		// through the gaps instead of drowning in the aggregate. 1.0 = the old
		// unsharpened behaviour. 2.4 = roads-first cores (2026-08 de-soak).
		nightMaskGamma: 2.4,
		// District-scale patchiness, ± this fraction. Real city light is uneven;
		// a flat field reads as a printed map.
		nightMaskNoise: 0.42,
		// Atmospheric scintillation on the brighter cells. Deliberately small —
		// this should be felt, not seen. 0 disables.
		nightGlimmer: 0.10,
		moonlightIntensity: 0.08,
	nightExposure: 1.15, // 0.95 → 1.15 (Aug-2026 review): global night lift — the wall read too dark at deep night
	darkVoidStrength: 0.01, // dark-crush floor (nearly off)
	// 4.0 → 3.0: ambient floor still lifts pure black; lower than the old
	// wash while keeping terrain readable on matte office panels.
	envLight: 3.0,
	// Daytime half of the grade pass. The base imagery layer's own contrast and
	// saturation are pinned at measured values (see imagery.ts — raising them
	// clipped a channel on 100% of ocean pixels and turned the Pacific purple),
	// so daytime depth comes from the post-process instead, using a
	// non-clipping S-curve and headroom-aware vibrance.
	// 0 = off for both. Modest by default: this needs eyes on the wall.
	dayContrast: 0.35,
	dayVibrance: 0.20,
		atmosphereLight: 2.0, // 1.6 → 2.0 (Aug-2026): ground ambient bleed at night, pairs with the exposure lift
		skyDarken: 1.8, // sky-atmosphere brightness shift
	// 3.0 → 1.55: VIIRS is fill/halo only; roads + windows are the city.
	// syncImagery multiplies this into layer.brightness — keep modest.
	viirsBrightness: 1.55,
	// 1.4 → 1.0: this multiplies INTO viirsLayerAlpha's gate product, which is
	// then clamped back to maxAlpha. At 1.4 the product overshot 1.0 at every
	// night-show altitude, pinning alpha flat and disabling the altitude gate
	// entirely. Reach for NIGHT_PALETTE.viirs.maxAlpha to change the level; see
	// the note in viirsLayerAlpha before raising this above ~1.03.
	viirsAlphaBoost: 1.0,
	windowLightIntensity: 1.5, // procedural building-window brightness
	showClouds: true,
		useCesiumClouds: true, // Cesium cloud billboards (1 draw call, GPU-instanced)
	// OFF by default — opt-in night-lighting TUNING. Cesium already generates a
	// dynamic environment map for the buildings tileset (its own default is
	// enabled=true; verified on the live scene). What this flag adds is night
	// tuning: a higher atmosphereScatteringIntensity so the environment term
	// carries the facades once the direct sun is gone, plus a warm groundColor
	// so the bounce reads as a lit city rather than neutral. Off until the look
	// is approved on real hardware. See world/night-ibl.ts.
	useDynamicEnvironmentMap: false,
	ambientOcclusion: true, // HBAO (altitude-gated)
	qualityMode: 'performance' as QualityMode, // quality preset
		// Wing mirror parity — flips the wing when travel direction reverses.
		// 1 = natural pose, -1 = mirrored pose. Toggle via Lighting panel.
		wingDriftSign: 1,
		// Wing horizontal position in Three.js camera-local space.
		// -5.3 = default (root near foreground), adjust via Lighting panel.
		wingXBase: -5.3,
});


// ─── Shell ───────────────────────────────────────────────────────────────────

export const shell = $state({
		windowFrame: false, // cabin oval border
	blindOpen: true,
	// Open-blind destination whisper on solo/center. Edge panes ignore this
	// (HUD is role-gated). Closed-blind BlindInfoCard is independent.
	hudVisible: true,
		clockVisible: false, // tap-to-toggle cabin clock on the open glass
		// OFF by default: kiosk has no cursor (html.kiosk { cursor:none }).
		// When ON, still skips $state writes once settled (see use-mouse-parallax).
		mouseParallax: false,
		sidePanelAutoCloseMs: 15000, // auto-close idle side panel
	// Touch-contract gate (Q3 council 2026-05-20). false = passenger mode: basic
	// blind drag is the ONLY touch interaction — the curtain metaphor. true =
	// demo/operator mode: long-press acceleration + future multi-touch gestures
	// become live. Lobby installs ship with false; operator iPad PATCHes shell.
	// touchEnabled=true via /api/config for guided demos. Auto-revert timer
	// (10-min) is a v1.1 follow-up; for v1 the toggle is sticky.
	touchEnabled: false, // passenger-mode touch safety
});


// ─── Root ────────────────────────────────────────────────────────────────────

// The root wrapper is a plain object on purpose: its fields are never
// reassigned (all mutation goes through setByPath into the namespaces), so
// the reactivity already lives in the five $state namespace proxies.
export const config = { atmosphere, audio, camera, director, world, shell };

// Flat namespace map — single dispatch point for all path-targeted patches.
// `satisfies` couples the keys to the framework-free CONFIG_NAMESPACE_KEYS
// SSOT (also consumed by the /api/config wire allowlist): add or rename a
// namespace in only one place and the compiler flags the other.
const NAMESPACES = { atmosphere, audio, camera, director, world, shell } as const satisfies Record<ConfigNamespace, object>;

// ─── CRDT layer ─────────────────────────────────────────────────────────────

const _configRoot: Record<string, unknown> = config as unknown as Record<string, unknown>;
const crdt = new CRDTStore(_configRoot);

/**
 * Sync atmosphere.weather fields from a weather effect recipe.
 * Each field is stamped through the CRDT so concurrent admin PATCHes
 * to the same fields participate in LWW merge — previously Object.assign
 * bypassed CRDT and would silently clobber fleet-config writes.
 * Boot-time callers pass `{ stamp: false }` (see applyConfigPatch).
 */
export function syncAtmosphereWeather(
	fx: { turbulence: 'light' | 'moderate' | 'severe'; hasLightning: boolean; rainOpacity: number; windAngle: number; cloudDensityRange: [number, number]; nightCloudFloor: number; filterBrightness: number },
	opts?: ConfigPatchOpts,
): void {
	for (const [key, value] of Object.entries(fx)) {
		const path = `atmosphere.weather.${key}`;
		// Route through applyConfigPatch so all config writes go through one
		// path: setByPath validation → idempotency skip → CRDT stamp. Previously
		// this wrote directly and stamped CRDT separately — two mutation paths.
		const newValue = key === 'cloudDensityRange' ? [...value as [number, number]] : value;
		applyConfigPatch(path, newValue, opts);
	}
}

/**
 * Resolve `namespace.rest…` against the five config roots.
 * Single parse path for local + remote patches (SSOT).
 */
function resolveConfigPath(path: string): {
	ns: ConfigNamespace;
	rest: string;
	rootRec: Record<string, unknown>;
	existing: unknown;
} | null {
	const idx = path.indexOf('.');
	if (idx < 0) return null;
	const ns = path.slice(0, idx) as ConfigNamespace;
	const root = NAMESPACES[ns];
	if (!root) return null;
	const rest = path.slice(idx + 1);
	const rootRec = root as unknown as Record<string, unknown>;
	return { ns, rest, rootRec, existing: readByPath(rootRec, rest) };
}

/**
 * Reject fleet/local writes that change a leaf's runtime type
 * (`'potato'` → number). Missing leaves: let setByPath / merge decide.
 */
function isLeafTypeCompatible(existing: unknown, value: unknown): boolean {
	if (existing === undefined) return true;
	return typeof value === typeof existing;
}

/**
 * Options for applyConfigPatch — one bag for local + remote (no
 * `undefined` placeholder between remote and stamp).
 *
 * - `remote` — fleet CRDT write (timestamp + sourceId). When set, stamp
 *   is ignored (merge carries the remote timestamp).
 * - `stamp: false` — local boot/restore: apply value without a wall-clock
 *   stamp so offline admin pushes still win LWW after reboot.
 */
export type ConfigPatchOpts = {
	remote?: { timestamp: number; sourceId: string };
	stamp?: boolean;
};

/**
 * Apply a path-keyed patch to the config tree.
 *
 * Local: write-through + optional CRDT stamp (default on).
 * Remote: LWW merge via opts.remote.
 *
 * Returns true if the write was applied.
 */
export function applyConfigPatch(
	path: string,
	value: unknown,
	opts?: ConfigPatchOpts,
): boolean {
	const resolved = resolveConfigPath(path);
	if (!resolved) return false;
	const { rest, rootRec, existing } = resolved;

	// SSOT type gate — same rule for local UI and fleet CRDT.
	if (!isLeafTypeCompatible(existing, value)) return false;

	if (opts?.remote) {
		const merged = crdt.merge({ path, value, ...opts.remote });
		if (merged) maybeApplyRoleDerived(path, value);
		return merged;
	}

	// Idempotency: skip stamp when already set (peer-sync keystroke noise).
	if (Object.is(existing, value)) return true;

	// Write config FIRST — failed setByPath must not leave a CRDT stamp.
	if (!setByPath(rootRec, rest, value)) return false;
	// stamp:false (boot/restore) — apply WITHOUT a wall-clock stamp.
	if (opts?.stamp !== false) crdt.record(path, value);
	maybeApplyRoleDerived(path, value);
	return true;
}

/**
 * `camera.parallax.role` is not a bare leaf — it DERIVES headingOffsetDeg
 * and fuselageOffsetM. One place for local + remote so panorama seams stay
 * aligned (callers used to forget setParallaxRole on the fleet path).
 */
function maybeApplyRoleDerived(path: string, value: unknown): void {
	if (path === 'camera.parallax.role') applyRoleDerived(value as DeviceRole);
}

/** Recompute the values that DERIVE from the panorama role. */
function applyRoleDerived(role: DeviceRole): void {
	camera.parallax.headingOffsetDeg = headingOffsetForRole(role, camera.parallax.panoramaArcDeg);
	camera.parallax.fuselageOffsetM = fuselageOffsetForRole(role);
}

/** Export device ID for use in fleet message sourceId field. */
export { setCRDTDeviceId, getCRDTDeviceId };

// ─── Public types (for consumers that need the shape, not the class) ──────────
// CameraConfig is already declared at line 140 (aliased to typeof _camera).
// DirectorConfig is the only new type export.

export type DirectorConfig = typeof director;
