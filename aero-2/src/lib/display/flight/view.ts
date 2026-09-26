/**
 * Window camera geometry, look-at ground target, and MapLibre viewport projection.
 * Pure deterministic mathematics — rune-free and renderer-free.
 */

import {
	normalizeHeading,
	phaseFor,
	azimuthSweepAt,
	FlightTrack,
	type OrbitPose
} from './flight-path.js';
import { downtownBlendAt, downtownPose, downtownWarpSec } from './downtown.js';
import { roleYawOffsetDeg, type FleetRole } from './parallax.js';
import { signedDelta } from '#lib/angles.js';
import { resolveLocalHours } from '../world/sun.js';

export interface CameraParams {
	place: {
		lat: number;
		lon: number;
		utcOffset: number;
		/** Feature locations are crossed, not orbited — see the aim below. */
		isFeature?: boolean;
	};
	azimuthDeg: number;
	pitchDeg: number;
	floorM: number;
	ceilingM: number;
	/** +1 or -1: which way round the loop is flown. */
	direction?: 1 | -1;
	/** Simulation flight speed multiplier (e.g. 2.5x). */
	speed?: number;
	/** Hours added to the destination's UTC offset. Tuning only; 0 on the wall. */
	clockOffsetH?: number;
	/** Multi-Pi Fleet Parallax Role */
	fleetRole?: FleetRole;
	/** Weather condition (drives procedural turbulence intensity) */
	weather?: Weather;
}

/**
 * How much of the airframe's bank reaches the horizon as roll.
 *
 * ONE home, because two renderers read it and they must not disagree: the
 * MapLibre camera rolls the world by this, and the Three wing counter-rotates
 * by the same amount so it stays fixed to the aircraft. A copy in each file
 * drifts the moment someone tunes one, and the symptom — a wing that slides
 * against its own horizon through a turn — is subtle enough to survive review.
 *
 * Not 1.0. From a window seat the horizon does tilt with the aircraft, but the
 * passenger's head tilts too, so the felt rotation is smaller than the
 * instrument reading; at full gain an 18 deg bank also swings the horizon far
 * enough to show the frame's corners on a wide pane.
 */
export const WORLD_ROLL_GAIN = 0.55;

export const DEFAULT_WINDOW_AZIMUTH_DEG = 0;
export const DEFAULT_PITCH_DEG = -10;

/**
 * Furthest the look-at ground point may roam from the aircraft, in metres.
 *
 * Depression and range are related by a tangent, so at a FIXED depression the
 * ground distance grows linearly with altitude: at the 4 deg shallow end of
 * the bank swing the target sits 64 km out at 4,500 m AGL but 186 km out at
 * the 13,000 m ceiling — aimed at ground no pack covers, past the horizon
 * haze the sky expects, and (via `calculateCameraOptionsFromTo`) pitching the
 * MapLibre camera ever closer to horizontal.
 *
 * The packed sharp imagery is the authority for the number, not taste. The
 * Sentinel-2 manifests (`aero-2/data/tiles/sentinel2/source-*.json`) pack the
 * near box at +/-0.65 deg latitude around each pin — ~72 km — carrying z12-13,
 * the zooms the window actually resolves; the DEM is packed to roughly +/-1
 * deg. Capping the ground distance at 70 km keeps the centre of frame on
 * packed tiles at every altitude while leaving low-altitude behaviour exactly
 * alone: the cap only lifts depressions shallower than atan(agl/70km), which
 * at 4,500 m is 3.7 deg — below the 4 deg the bank swing ever reaches. It
 * first bites around ~4,900 m AGL and holds the target at 70 km all the way
 * to the ceiling.
 */
export const LOOKAT_MAX_GROUND_DIST_M = 70_000;

import { DEG2RAD } from '#lib/angles.js';
const M_PER_DEG_LAT = 111_320;

/** Written out in five places before this existed. */
export const WEATHERS = ['clear', 'cloudy', 'rain', 'overcast', 'storm'] as const;
export type Weather = (typeof WEATHERS)[number];

/**
 * Procedural atmospheric turbulence — micro-shakes, low-frequency bumps, wing flutter.
 *
 * Deterministic off `wallSec`, but determinism alone is not enough here. Every
 * other derived quantity in this codebase has a period measured in minutes, so
 * "the same second" is a fine granularity for three panes to agree at. These
 * terms run at ~2.3 and ~3.5 Hz, where a few milliseconds matters: `wallSec` is
 * `Date.now() / 1000` sampled per animation frame, and three Pi 5s do not tick
 * RAF in phase. Eight milliseconds of frame offset is 0.18 rad at 22.3 rad/s —
 * a completely different jitter value on each pane, feeding `bankDeg`, tilting
 * the horizon differently across one continuous panorama.
 *
 * Sampling on a fixed grid removes the frame phase entirely: every pane rounds
 * to the same bucket and computes the same number. 20 Hz is above Nyquist for
 * the fastest term, so the shake survives; panes whose clocks straddle a bucket
 * edge differ by one 50 ms step of a smooth function, which is bounded and
 * small — unlike the unbounded phase error it replaces.
 */
const TURBULENCE_GRID_HZ = 20;

const TURBULENCE_INTENSITY = {
	clear: 0.04,
	cloudy: 0.16,
	rain: 0.38,
	overcast: 0.58,
	storm: 1.0
} as const satisfies Record<Weather, number>;

export interface Turbulence {
	pitchJitterDeg: number;
	rollJitterDeg: number;
	verticalBumpM: number;
	wingFlutterPx: number;
	intensity: number;
}

export function atmosphericTurbulence(wallSec: number, weather: Weather = 'clear'): Turbulence {
	const intensity = TURBULENCE_INTENSITY[weather];
	const t = Math.round(wallSec * TURBULENCE_GRID_HZ) / TURBULENCE_GRID_HZ;

	// Multi-octave harmonic noise.
	const lowFreq = Math.sin(t * 0.73) * Math.cos(t * 0.37);
	const midFreq = Math.sin(t * 3.41 + 1.2) * 0.5 + Math.cos(t * 5.13) * 0.3;
	const highFreq = Math.sin(t * 14.7) * Math.sin(t * 22.3) * 0.2;

	const composite = (lowFreq * 0.5 + midFreq * 0.35 + highFreq * 0.15) * intensity;

	return {
		pitchJitterDeg: composite * 0.45,
		rollJitterDeg: composite * 0.75,
		verticalBumpM: composite * 14.0,
		wingFlutterPx: composite * 12.0,
		intensity
	};
}

/** Initial great-circle bearing from one point to another, in degrees. */
function bearingTo(fromLat: number, fromLon: number, toLat: number, toLon: number): number {
	const cosLat = Math.cos(fromLat * DEG2RAD) || 1;
	const dNorth = (toLat - fromLat) * M_PER_DEG_LAT;
	const dEast = (toLon - fromLon) * M_PER_DEG_LAT * cosLat;
	return normalizeHeading((Math.atan2(dEast, dNorth) * 180) / Math.PI);
}

export interface CameraView {
	lat: number;
	lon: number;
	aglM: number;
	planeHeadingDeg: number;
	/** Roll of the airframe, degrees. Negative is left-wing-down. */
	bankDeg: number;
	cameraBearingDeg: number;
	cameraPitchDeg: number;
	targetLat: number;
	targetLon: number;
	distanceM: number;
	timeOfDay: number;
	/** Procedural atmospheric turbulence micro-vibration and wing flutter */
	turbulence: Turbulence;
	/** The wall-clock second this view was derived from — the only input. */
	wallSec: number;
	/**
	 * Drawn ground elevation under the aircraft, metres in the rendered
	 * (exaggerated) frame. NOT set by `calculateCameraView` — only the Stage
	 * can query the map — so it is optional and filled post-hoc per frame.
	 * The Hud shows it beside AGL so the readout names its datum: AGL over
	 * WHAT. Without it the number reads against an invisible surface and any
	 * ridge or exaggeration makes it look wrong.
	 */
	groundM?: number;
}

export interface CameraTargetOptions {
	targetLat: number;
	targetLon: number;
	cameraBearingDeg: number;
	cameraPitchDeg: number;
	distanceM: number;
}

/**
 * FlightCamera — ES6 domain model for aircraft camera look-at ground target and viewport projection.
 */
export class FlightCamera {
	constructor(
		public azimuthDeg: number = DEFAULT_WINDOW_AZIMUTH_DEG,
		public pitchDeg: number = DEFAULT_PITCH_DEG
	) {}

	/**
	 * Compute look-at ground target intersection vector from aircraft pose.
	 */
	/**
	 * Where the window looks from a given pose.
	 *
	 * The bearing is measured INWARD — towards the centre of the orbit — rather
	 * than as a fixed offset from the aircraft's heading. The centre is the city,
	 * so this keeps the city in the window for the whole loop.
	 *
	 * With a heading-relative bearing the view swung out over empty countryside
	 * for half of every circuit, because "90 deg off the nose" points outward on
	 * one side of an ellipse and inward on the other. `azimuthDeg` still applies,
	 * but now as a nudge either side of the city rather than as the whole aim.
	 */
	viewOptions(plane: OrbitPose, centerLat?: number, centerLon?: number): CameraTargetOptions {
		const inwardDeg =
			centerLat === undefined || centerLon === undefined
				? plane.headingDeg + 90
				: bearingTo(plane.lat, plane.lon, centerLat, centerLon);

		const cameraBearingDeg = normalizeHeading(inwardDeg + this.azimuthDeg);

		/**
		 * Roll the sightline dynamically with the airframe turn.
		 *
		 * From a window seat the bank IS the turn: the wing drops and the ground
		 * swings up into the glass, or it lifts and you get panoramic sky and cloud layers.
		 * At 0.85 gain, entering a turn dramatically reveals the ground/city below,
		 * and exiting/levelling opens the window to the horizon and sky canopy.
		 */
		const BANK_VIEW_GAIN = 0.85;
		const bankOffset = (plane.bankDeg ?? 0) * BANK_VIEW_GAIN;

		/**
		 * The bank swing is applied as a RATIO of the current depression, not as
		 * a number of degrees added to it.
		 *
		 * Additive was the bug, and it is worth being precise about because the
		 * numbers look harmless. Peak bank is 18 deg and the gain is 0.85, so
		 * the offset swings +/-15.3 deg against a default `pitchDeg` of -10.
		 * Every turn therefore drove the effective pitch POSITIVE — the camera
		 * asked to look UP — and the clamp below caught it at 0.5 deg of
		 * depression. Measured over one roll cycle: the sightline is pinned at
		 * that clamp for 28.6% of the time, i.e. for more than a quarter of
		 * every turn the view does not move at all.
		 *
		 * The visual cost is worse than the freeze, because depression and
		 * distance are related by a tangent. At 4,500 m AGL the look-at point
		 * travels from 10 km away at the bottom of the roll to 516 KM away at
		 * the top — most of a continent, well past the horizon, over ground no
		 * tile pack covers. Every turn the window pans from a city block to
		 * half a continent and back. That is the single biggest reason the
		 * result does not read as an aeroplane window: a real one holds a
		 * roughly constant slant range and the ground rotates past it.
		 *
		 * A ratio cannot cross zero, so the sightline stays below the horizon
		 * for every bank angle and every `pitchDeg` an operator can dial in, and
		 * the clamp goes back to being a guard rather than a mode the camera
		 * spends a quarter of its life in.
		 *
		 * The look-at distance now varies by a factor of ~4.1 across a turn
		 * instead of ~50. It said ~2.4 here, which is the figure for a clamp of
		 * +/-0.4: that gives a depression swing of 6-14 deg. The clamp below is
		 * +/-0.6, which swings 4-16 deg, and tan(16)/tan(4) is 4.10.
		 *
		 * Altitude then moved the problem without moving the fix: at a fixed
		 * 4 deg shallow end the ground distance is agl/tan(4deg) — 64 km at
		 * 4,500 m AGL but 186 km at the 13,000 m ceiling, aimed at ground no
		 * pack covers. So the depression carries a second, altitude-scaled
		 * floor (LOOKAT_MAX_GROUND_DIST_M): never shallower than keeps the
		 * target within 70 km, the half-width of the packed z12-13 near box.
		 * Measured over a full circuit at Denver against this function: bank
		 * reaches +/-18.0 deg, depression runs 10.43-16.01 deg, ground range
		 * 12.3-64.5 km — inside the pack at every altitude, with
		 * low-altitude behaviour unchanged (the floor sits below 4 deg under
		 * ~4,900 m AGL). The circuit max/min ratio is 5.25x, but that is
		 * altitude-inclusive (the climb varies through the circuit); the
		 * fixed-altitude depression swing is still the 4.10x above. Do not
		 * compare the two numbers across that line. Whoever moves the cap
		 * or the clamp re-measures here.
		 */
		const bankRatio = 1 - Math.max(-0.6, Math.min(0.6, bankOffset / 25));
		const basePitch = Math.min(-0.5, this.pitchDeg);
		const effectivePitch = basePitch * bankRatio;
		/**
		 * Altitude-scaled floor: no shallower than would put the look-at
		 * point past LOOKAT_MAX_GROUND_DIST_M. A max() of three guards, in
		 * ascending order: the historic 0.5 deg horizon guard, the coverage
		 * floor, then the bank-driven depression capped at 89.5.
		 */
		const coverFloorDeg = (Math.atan(plane.aglM / LOOKAT_MAX_GROUND_DIST_M) * 180) / Math.PI;
		const depressionDeg = Math.max(0.5, coverFloorDeg, Math.min(89.5, -effectivePitch));
		const depressionRad = depressionDeg * DEG2RAD;

		const groundDistM = plane.aglM / Math.tan(depressionRad);
		const slantDistM = plane.aglM / Math.sin(depressionRad);

		const bearingRad = cameraBearingDeg * DEG2RAD;
		const cosLat = Math.cos((plane.lat * Math.PI) / 180) || 1;

		const dNorthM = groundDistM * Math.cos(bearingRad);
		const dEastM = groundDistM * Math.sin(bearingRad);

		const targetLat = plane.lat + dNorthM / M_PER_DEG_LAT;
		const targetLon = plane.lon + dEastM / (M_PER_DEG_LAT * cosLat);

		return {
			targetLat,
			targetLon,
			cameraBearingDeg,
			cameraPitchDeg: 90 - depressionDeg,
			distanceM: slantDistM
		};
	}

	/**
	 * Project full CameraView given flight track pose, local solar UTC offset, and wall-clock timestamp.
	 */
	project(
		plane: OrbitPose,
		utcOffset = 0,
		wallSec = 0,
		centerLat?: number,
		centerLon?: number,
		weather: Weather = 'clear'
	): CameraView {
		const cam = this.viewOptions(plane, centerLat, centerLon);
		const timeOfDay = resolveLocalHours(wallSec, utcOffset);
		const turbulence = atmosphericTurbulence(wallSec, weather);

		return {
			lat: plane.lat,
			lon: plane.lon,
			aglM: plane.aglM + turbulence.verticalBumpM,
			planeHeadingDeg: plane.headingDeg,
			bankDeg: plane.bankDeg + turbulence.rollJitterDeg,
			cameraBearingDeg: cam.cameraBearingDeg,
			cameraPitchDeg: cam.cameraPitchDeg + turbulence.pitchJitterDeg,
			targetLat: cam.targetLat,
			targetLon: cam.targetLon,
			distanceM: cam.distanceM,
			timeOfDay,
			turbulence,
			wallSec
		};
	}
}

export function calculateCameraView(wallSec: number, params: CameraParams): CameraView {
	const track = new FlightTrack(
		params.place.lat,
		params.place.lon,
		params.floorM,
		params.ceilingM,
		params.direction ?? 1,
		// Derived here, from the same second as the pose. See `phaseFor`.
		phaseFor(params.place, wallSec)
	);
	const effectiveSec = wallSec * (params.speed ?? 1.0);
	const plane = track.poseAt(effectiveSec);
	const roleOffset = roleYawOffsetDeg(params.fleetRole ?? 'solo');
	// The operator's aim, the fleet parallax, and the slow look-around —
	// three independent offsets, one bearing. The sweep keys off wallSec,
	// NOT effectiveSec: it is a window behaviour, not a flight behaviour,
	// so warp speeds pan the world, not the head. Cities only: a feature
	// is a transit with a fixed off-nose aim (pinned by display.test.ts),
	// and there is no framed subject for the pan to walk across.
	const sweep = params.place.isFeature ? 0 : azimuthSweepAt(wallSec);
	const camera = new FlightCamera(
		params.azimuthDeg + roleOffset + sweep,
		params.pitchDeg
	);

	/**
	 * Cities get an inward aim; features do not.
	 */
	const utcOffset = params.place.utcOffset + (params.clockOffsetH ?? 0);
	const weather = params.weather ?? 'clear';

	if (params.place.isFeature)
		return camera.project(plane, utcOffset, wallSec, undefined, undefined, weather);
	const big = camera.project(
		plane,
		utcOffset,
		wallSec,
		params.place.lat,
		params.place.lon,
		weather
	);

	/**
	 * Mid-visit downtown thread. The pass is a wall-slot event like the
	 * rotation itself, so it keys off wallSec — NOT effectiveSec, which the
	 * speed knob scales. Blending two full views (not poses) keeps aim,
	 * turbulence and time-of-day continuous: at 0 the thread view is
	 * unreachable and at 1 the big loop is, with the handoff eased both
	 * sides in `downtownBlendAt`.
	 */
	/**
	 * Features never thread, explicitly — not via the altitude gate. The
	 * gate alone only saves the Himalayas (6,000 m floor); ocean and desert
	 * fly low enough to open it, and the pass would detour a mid-transit
	 * crossing into circles over open water. Crossing is the feature
	 * experience; visits are for cities.
	 */
	const thread = params.place.isFeature ? 0 : downtownBlendAt(wallSec, plane.aglM);
	if (thread <= 0) return big;
	// The thread flies its own clock: position AND heading/bank come from
	// the warped pose, so the aircraft circles downtown instead of
	// side-slipping across it holding the big loop's attitude. The gate
	// above deliberately still reads the unwarped climb — it is the
	// visit's altitude that decides whether the pass engages.
	const warpPose = track.poseAt(downtownWarpSec(effectiveSec));
	const small = downtownPose(warpPose, params.place.lat, params.place.lon, params.floorM);
	const threadView = camera.project(
		small,
		utcOffset,
		wallSec,
		params.place.lat,
		params.place.lon,
		weather
	);
	return blendViews(big, threadView, thread);
}

/**
 * Blend two camera views during a cruise transition, `t` in 0..1.
 *
 * aero-1's lesson, ported: a destination change used to teleport, because the
 * pose is a pure function of the second and the new place simply won. aero-1
 * flies it (cruise_departure → cruise_transit → orbit); here the old pose is
 * recomputed for the same second from the previous place and eased across.
 * Bearings blend on the shortest arc and longitude wraps, so a
 * Pacific-to-Atlantic hop glides forward instead of swinging the long way
 * round. Everything else (bearing/pitch offsets, turbulence) rides with the
 * new view — only the world position eases.
 */
export function blendViews(a: CameraView, b: CameraView, t: number): CameraView {
	const s = Math.max(0, Math.min(1, t));
	const ease = s * s * (3 - 2 * s);
	const wrapLon = (d: number) => ((d + 540) % 360) - 180;
	// timeOfDay blends in degree space (15 deg per hour) so a hop across
	// midnight eases forward instead of rewinding the whole dial.
	const todD = signedDelta(a.timeOfDay * 15, b.timeOfDay * 15) / 15;
	return {
		...b,
		lat: a.lat + (b.lat - a.lat) * ease,
		lon: a.lon + wrapLon(b.lon - a.lon) * ease,
		aglM: a.aglM + (b.aglM - a.aglM) * ease,
		planeHeadingDeg: a.planeHeadingDeg + signedDelta(a.planeHeadingDeg, b.planeHeadingDeg) * ease,
		bankDeg: a.bankDeg + (b.bankDeg - a.bankDeg) * ease,
		targetLat: a.targetLat + (b.targetLat - a.targetLat) * ease,
		targetLon: a.targetLon + wrapLon(b.targetLon - a.targetLon) * ease,
		distanceM: a.distanceM + (b.distanceM - a.distanceM) * ease,
		timeOfDay: a.timeOfDay + todD * ease
	};
}
