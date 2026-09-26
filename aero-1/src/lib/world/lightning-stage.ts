/**
 * lightning — Cesium-native post-process stage for ambient scene flash.
 *
 * Reactive feature: shader uniforms come from module-level state read
 * via uniform callbacks; the strike timer is an imperative RAF loop
 * because it's time-driven simulation (not a state-driven effect).
 *
 * Composition picker (sheet / forked / distant) drives the timing,
 * intensity, and x/y placement — same recipes as before.
 */

import { randomBetween, clamp } from '$lib/utils';
import type * as CesiumType from 'cesium';
import {
	pickLightningComposition,
	type LightningComposition,
} from '$content/compositions/lightning';
import { createSeededRng, daySeed } from './prng';
import { registerViewerTeardown } from './viewer-lifecycle';

const STAGE_NAME = 'aero-lightning';

const LIGHTNING_GLSL = /* glsl */ `
	uniform sampler2D colorTexture;
	uniform float u_flash;
	uniform float u_strike_x;
	uniform float u_strike_y;
	in vec2 v_textureCoordinates;

	void main() {
		vec4 color = texture(colorTexture, v_textureCoordinates);
		if (u_flash < 0.001) { out_FragColor = color; return; }

		vec2 d = v_textureCoordinates - vec2(u_strike_x, u_strike_y);
		d.x *= 1.2;
		float dist = length(d);
		float radial = 1.0 - smoothstep(0.0, 1.0, dist);

		vec3 flashColor = mix(vec3(0.59, 0.59, 0.90), vec3(0.78, 0.78, 1.0), radial);

		float gain = u_flash * (0.3 + 0.7 * radial);
		out_FragColor = vec4(color.rgb + flashColor * gain, color.a);
	}
`;

interface WeatherSlice {
	hasLightning: boolean;
	lightningDecayRate: number;
	lightningMinInterval: number;
	lightningMaxInterval: number;
}

// Module-private state — uniform callbacks read these each frame.
let _flash = 0;
let _x = 0.5;
let _y = 0.4;
let _viewer: CesiumType.Viewer | null = null;
let _stage: CesiumType.PostProcessStage | null = null;
let _composition: LightningComposition | null = null;
let _prevHasLightning = false;
let _nextStrike = 10;
/**
 * Wall-clock second the next strike lands on. The schedule is absolute —
 * storm start plus cumulative intervals — never accumulated from frame
 * deltas (see tickLightning). Reset with everything else in destroy.
 */
let _nextStrikeWallSec = 0;

// Deterministic strike sequence AND schedule (invariant #4). Lightning is
// a FULL-SCREEN flash, so if each Pi rolled its own timings the panorama
// would flash out of sync — the most visible seam of any effect. All three
// Pis share daySeed() and receive the same broadcast weather, so seeding
// the storm from (daySeed ^ stormIndex) makes the SEQUENCES agree with no
// extra messaging. The seed alone never agreed the TIMING: the old
// `_timer += delta` accumulation crossed each interval at whatever wall
// moment each Pi's frame rate happened to reach, so identical sequences
// fired out of sync. The schedule is therefore absolute — storm start
// plus cumulative intervals against the shared wall clock — while the
// draws stay exactly as seeded.
//
// `_stormIndex` counts hasLightning false→true transitions. It stays in
// step across Pis because `hasLightning` is derived from the leader's
// broadcast weather, so every device sees the same transitions.
let _stormIndex = 0;
// Seeded from the start rather than Math.random. This default is unreachable
// in practice — _prevHasLightning starts false, so the first hasLightning tick
// is always a false→true transition and beginStorm() reseeds before any
// consumer reads _rng — but a bare Math.random in a visual path on a 3-Pi wall
// is a landmine for the next determinism sweep, which has to re-derive that
// whole argument to clear it. Cheaper to not be there.
const STORM_SALT = 0x5c07;

let _rng: () => number = createSeededRng(STORM_SALT);

/** Reset the strike sequence for a new storm. Draw order is the determinism
 * contract (see lightning-determinism.test.ts): composition, first
 * interval, then per strike intensity, x, y, next interval. tickLightning
 * preserves it exactly — only the trigger changes. */
function beginStorm(index: number = _stormIndex): void {
	_rng = createSeededRng((daySeed() ^ (index * STORM_SALT)) >>> 0);
	_composition = pickLightningComposition(_rng);
	_flash = 0;
	_nextStrike = randomBetween(
		_composition.intervalRange[0],
		_composition.intervalRange[1],
		_rng,
	);
}

/**
 * One-time mount: create the PostProcessStage and add it to the scene.
 * Idempotent. Accepts the live Cesium + Viewer from CesiumManager so the
 * module mounts BEFORE `activeCesium.manager` is published by the viewer.
 *
 * Liveness-guarded: a latched `_stage` is only valid while its viewer lives.
 * If `onDestroy` fired while `CesiumManager.start()` was suspended in an
 * await, `destroy()` ran first and `start()` then resumes calling this on a
 * destroyed viewer — mounting there would latch a stage against a dead scene
 * and the bare `_stage` check would keep every later (live) mount out for the
 * rest of the session.
 */
export function mountLightning(C: typeof CesiumType, viewer: CesiumType.Viewer): void {
	if (_stage) {
		if (_viewer && !_viewer.isDestroyed?.()) return;
		// Stale latch from a destroyed viewer — drop it and remount below.
		_stage = null;
	}
	// Never mount onto a viewer that is already destroyed (start() resuming
	// after destroy()): the stage would be unreachable by the next live mount.
	if (viewer.isDestroyed()) return;
	// Keep the viewer so destroyLightning can detach the stage without
	// depending on activeCesium (which may already be cleared at teardown).
	_viewer = viewer;
	_stage = new C.PostProcessStage({
		name: STAGE_NAME,
		fragmentShader: LIGHTNING_GLSL,
		uniforms: {
			u_flash: () => _flash,
			u_strike_x: () => _x,
			u_strike_y: () => _y,
		},
	});
	_stage.enabled = false;
	viewer.scene.postProcessStages.add(_stage);
}

/**
 * Per-frame strike timing + flash decay.
 *
 * `wallSec` is the shared wall clock (seconds, Date.now()/1000 at the call
 * site — the same doctrine as flight.svelte.ts: identical across Pis
 * within NTP drift). The strike SCHEDULE derives from it absolutely:
 * storm start plus cumulative composition intervals. It used to accumulate
 * `_timer += delta` per frame, which reads the same on paper and splits
 * the wall in practice — two Pis at different frame rates cross each
 * interval at different wall moments, so the panorama flashed out of sync
 * while holding an identical RNG sequence. Same draws, wall-derived
 * trigger: every pane fires the same strikes at the same seconds.
 *
 * Flash DECAY stays delta-driven: it shapes a sub-second fade whose exact
 * curve is invisible across panes, and only the strike instants read as
 * sync. A non-finite wallSec fires nothing (all comparisons fail false)
 * while decay continues — a paused clock dims the storm, never breaks it.
 */
export function tickLightning(delta: number, weather: WeatherSlice, wallSec: number): void {
	if (!_stage) return;

	if (weather.hasLightning && !_prevHasLightning) {
		beginStorm(_stormIndex);
		_stormIndex++;
		_nextStrikeWallSec = wallSec + _nextStrike;
	} else if (!weather.hasLightning && _prevHasLightning) {
		_composition = null;
	}
	_prevHasLightning = weather.hasLightning;

	if (!weather.hasLightning) {
		_flash = 0;
		_stage.enabled = false;
		return;
	}

	_stage.enabled = true;

	const c = _composition;
	const decayRate = c?.decayRate ?? weather.lightningDecayRate;

	if (_flash > 0) {
		_flash = clamp(_flash - delta * decayRate, 0, 1);
	}
	// Every due strike fires, in order — including a backlog after a
	// suspended tab. Skipping backlog draws would desync the RNG against a
	// pane that drew them live; firing them keeps every pane's draw count
	// identical, and the visible end state is simply the latest strike.
	while (wallSec >= _nextStrikeWallSec) {
		if (c) {
			_flash = randomBetween(c.intensityRange[0], c.intensityRange[1], _rng);
			// Recipes are in percent (0..100); shader wants 0..1.
			_x = randomBetween(c.xRange[0], c.xRange[1], _rng) / 100;
			_y = randomBetween(c.yRange[0], c.yRange[1], _rng) / 100;
			// The composition owns the cadence — that is what makes 'sheet'
			// (slow, high, dim) read differently from 'forked' (fast, low,
			// bright). Falling back to the generic weather interval here
			// collapsed all three recipes onto one rhythm.
			_nextStrike = randomBetween(c.intervalRange[0], c.intervalRange[1], _rng);
		} else {
			_flash = randomBetween(0.5, 1, _rng);
			_x = randomBetween(20, 80, _rng) / 100;
			_y = randomBetween(15, 65, _rng) / 100;
			_nextStrike = randomBetween(
				weather.lightningMinInterval,
				weather.lightningMaxInterval,
				_rng,
			);
		}
		_nextStrikeWallSec += _nextStrike;
	}
}

/** Tear down the post-process stage. Idempotent. */
export function destroyLightning(): void {
	if (!_stage) return;
	if (_viewer && !_viewer.isDestroyed?.()) {
		_viewer.scene.postProcessStages.remove(_stage);
	}
	_stage = null;
	_viewer = null;
	_nextStrike = 10;
	_nextStrikeWallSec = 0;
	_flash = 0;
	_composition = null;
	_prevHasLightning = false;
	// Storm counter is session state, not viewer state — but a destroy means
	// the pipeline restarts from boot, so the next storm must reseed from 0
	// or its character silently shifts for the rest of the new session.
	_stormIndex = 0;
}

// Teardown was already explicit here; registering puts it in the single list
// so CesiumManager.destroy() no longer has to name subsystems individually.
registerViewerTeardown('lightning', destroyLightning);
