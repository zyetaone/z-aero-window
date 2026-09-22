/**
 * AeroDisplay — Svelte 5 root display simulation state container & Context DI.
 * Owns the reactive aircraft view pose, reactive PaneSettings, and simulation tick loop.
 */
import { createContext, untrack } from 'svelte';
import {
	blendViews,
	calculateCameraView,
	type CameraParams,
	type CameraView
} from './flight/view.js';

/**
 * Seconds a destination change glides instead of teleporting.
 *
 * aero-1 flies it (cruise_departure → cruise_transit → orbit, ~4 s); 3.5 s
 * reads the same here.
 *
 * This used to note that the blend START is the frame that notices the change,
 * so panes disagree by "16 ms of a 3,500 ms glide, invisible". True at 60 fps.
 * The fielded frame rate is the one number this repo has never measured for
 * aero-2 (docs/AERO-1-VS-AERO-2.md §9, gate 1), and the previous generation
 * measured 1.9–3.1 fps on the same hardware — where one frame is 14% of the
 * glide, and the blend interpolates lat/lon, not just yaw. An invariant should
 * not rest on an unmeasured number, so `cruiseStartSec` derives the start
 * instead of observing it.
 */
const CRUISE_BLEND_SEC = 3.5;

import { blindClosedAt, phaseFor } from './flight/flight-path.js';
import { DWELL_SEC, FlightDirector } from './flight/director.svelte.js';
import { resolveAtmosphere, type AtmosphereState } from './world/atmosphere.js';
import { nightAmount, sunPosition, type SunPosition } from './world/sun.js';
import { createSettings, type PaneSettings } from '#lib/settings/settings.svelte.js';
import { WallSync } from '#lib/settings/wall.svelte.js';
import { PUBLIC_WALL_ORIGIN } from '$app/env/public';

/**
 * When the glide that is starting now actually began, in wall-absolute seconds.
 *
 * The director moves the window on a slot boundary — `floor(wallSec /
 * DWELL_SEC) * DWELL_SEC` — which every pane can compute without being told.
 * A pane notices on its next frame, some unknown fraction of a frame period
 * later; snapping back to the boundary removes that observation from the pose.
 *
 * Changes that are NOT slot-driven keep `wallSec`: a manual blind-pull skip is
 * pane-local by design (see `FlightDirector.manualSkips`), and an operator
 * changing one pane's place from the settings panel is too. Blending those from
 * a boundary minutes in the past would compute t > 1 and cut instead of glide.
 * The boundary only wins while it is inside the blend window, which a
 * slot-driven change always is and a mid-slot change never is.
 */
export function cruiseStartSec(wallSec: number): number {
	const slotStart = Math.floor(wallSec / DWELL_SEC) * DWELL_SEC;
	return wallSec - slotStart < CRUISE_BLEND_SEC ? slotStart : wallSec;
}

/**
 * Type-safe context, rather than a Symbol key plus two casts.
 *
 * `createContext<T>()` returns its own getter/setter pair bound to a private
 * key, so the type is declared once here instead of being asserted at every
 * `getContext<AeroDisplay>(...)` call site. The old form compiled fine while
 * lying: `getContext<T>` casts whatever it finds, so a mismatched key returned
 * `undefined` typed as `AeroDisplay` and failed later, somewhere else, as a
 * property access on undefined.
 *
 * The runtime guard below is kept anyway. `createContext` types the value, it
 * does not promise a provider exists above you — and "called outside the
 * provider" is a mistake worth naming at the point it happens.
 */
const [getDisplayContext, setDisplayContext] = createContext<AeroDisplay>();

export class AeroDisplay {
	readonly config: PaneSettings;
	/** Buffered wall pushes. Emptied only by `advanceTo`, never by the fetch. */
	/**
	 * The origin is the same one the poller fetches from, and for the same
	 * reason: the host that serves the snapshot is the host holding the media
	 * files the snapshot names. Passing it here is what makes an uploaded track
	 * play on all three panes instead of only the writer.
	 */
	readonly wall = new WallSync(PUBLIC_WALL_ORIGIN);
	readonly director: FlightDirector;
	/**
	 * Overwritten in the constructor before anything can read it.
	 *
	 * The placeholder is a lie for exactly the length of the constructor body,
	 * and it used to leak: consumers defended against it with `?? 0` on every
	 * field, which is unreachable today AND converts any future genuine absence
	 * into a plausible zero -- a heading of 0 deg, an altitude of 0 m. Those
	 * defaults are gone; if this is ever read before assignment, it must throw
	 * rather than render north at sea level.
	 */
	/**
	 * `$state.raw`, for the same reason `PaneSettings.place` is: the object is
	 * REPLACED every frame and never mutated — `advanceTo` assigns a fresh
	 * `CameraView` 60 times a second, and nothing anywhere writes `view.lat`.
	 * The deep proxy that plain `$state` builds was therefore pure overhead on
	 * the hottest write in the codebase: proxy-wrapping a 15-field object plus
	 * its turbulence sub-object, per frame, to guard mutations that cannot
	 * happen. Raw still triggers on assignment, which is the only way this
	 * ever changes.
	 *
	 * Measured in isolation (200k assignments of this object shape, same
	 * process, interleaved): proxy 126ms, raw 58ms — 2.2x on the hottest
	 * write in the codebase. In the full `advanceTo` tick the difference is
	 * smaller because the flight maths dominates; the win is real but modest,
	 * and the CORRECTNESS argument (a proxy guarding mutations that cannot
	 * happen) would justify raw at 1.0x.
	 */
	view = $state.raw<CameraView>({} as CameraView);
	fps = $state<number>(60);
	frameTimeMs = $state<number>(16.6);

	/**
	 * How often the terrain actually answered, versus falling back to the mean.
	 *
	 * This exists because the DEM can fail in a way that emits no error at all.
	 * The archive serves 206s, the bytes arrive, the tiles sit in state
	 * `loading` forever, and `queryTerrainElevation` returns nothing -- so the
	 * regional mean wins every frame, the camera flies a sensible altitude, and
	 * the ground is drawn at sea level underneath it. MapLibre raises nothing;
	 * there is no error event to listen for. The failure is success-shaped.
	 *
	 * A percentage on the diagnostics panel is the smallest thing that makes it
	 * visible: `0% sampled` says the elevation you are looking at is not real.
	 */
	terrain = $state({ sampled: 0, fallback: 0 });

	#lastTickTime = typeof performance !== 'undefined' ? performance.now() : 0;
	#frameCount = 0;
	#lastFpsUpdate = typeof performance !== 'undefined' ? performance.now() : 0;

	constructor(configOrParams?: PaneSettings | (() => PaneSettings)) {
		if (typeof configOrParams === 'function') {
			this.config = configOrParams();
		} else if (configOrParams) {
			this.config = configOrParams;
		} else {
			this.config = createSettings();
		}

		this.director = new FlightDirector(this.config);
		this.view = untrack(() => calculateCameraView(Date.now() / 1000, this.config));
	}

	/**
	 * Today's orbit phase for the place being flown.
	 *
	 * Clouds seeds its sprite RNG from this and MiniMap builds its ring with it,
	 * and both MUST match what the camera flew or the marker leaves the ring and
	 * the three panes get different weather. They used to read `config.phase`, a
	 * stored field; this is the same number derived from the frame's own second,
	 * so there is one phase and nothing to keep in step.
	 */
	phase: number = $derived.by(() => phaseFor(this.config.place, this.view.wallSec));

	/** Cached for the same reason as `sun`: five readers, four of them in Sky. */
	atmosphere: AtmosphereState = $derived.by(() => resolveAtmosphere(this.view.aglM));

	/**
	 * Read by Ground, Terrain, Sky, Clouds, Buildings, Frame, Wing and
	 * CesiumStage. All of them used to inherit a clock-only curve that
	 * disagreed with `sun` below.
	 */
	night: number = $derived.by(() => nightAmount(this.sun.elevationDeg));

	/**
	 * Share of recent frames where real terrain was measured, 0-100.
	 *
	 * Reads 0 when no DEM tile has decoded, which is the whole point.
	 */
	get terrainSampledPct(): number {
		const n = this.terrain.sampled + this.terrain.fallback;
		return n === 0 ? 0 : (100 * this.terrain.sampled) / n;
	}

	/**
	 * Record one clearance resolution. Called from the frame loop.
	 *
	 * Halved rather than reset once the window is large enough, so the figure
	 * tracks the last few thousand frames instead of averaging over uptime -- a
	 * DEM that starts working after ten minutes should show up promptly, not be
	 * buried under the hours that preceded it.
	 */
	noteClearance(sampled: boolean): void {
		if (sampled) this.terrain.sampled++;
		else this.terrain.fallback++;
		if (this.terrain.sampled + this.terrain.fallback > 4000) {
			this.terrain.sampled = Math.round(this.terrain.sampled / 2);
			this.terrain.fallback = Math.round(this.terrain.fallback / 2);
		}
	}

	/**
	 * Where the sun is right now, over the place being flown.
	 *
	 * `$derived`, not a getter, because this is read a dozen-plus times per
	 * frame -- Sky takes three of them, Terrain three, Clouds three inside its
	 * render loop, and Ground, Buildings, Hud, Frame, Wing, Stage and
	 * CesiumStage one each. As a plain getter every one of those recomputed the
	 * solar position, and `dayOfYear` allocates a `Date` and calls `Date.UTC`
	 * twice, so a value that changes once a day was being rebuilt roughly a
	 * thousand times a second. Cached, it recomputes when the pose does: once
	 * per frame, for every reader.
	 */
	sun: SunPosition = $derived.by(() =>
		sunPosition(
			this.view.wallSec,
			this.config.place.lat,
			this.config.place.utcOffset + this.config.clockOffsetH
		)
	);

	/**
	 * The wall clock the SCENE is composed at, not the one the room is in.
	 *
	 * `clockOffsetH` is how a preset says "show me Dubai at midnight" while it
	 * is really lunchtime. `sun` above folds it into the utcOffset argument,
	 * which is the same arithmetic as shifting the instant --
	 * `resolveLocalHours(t, utc + off)` === `resolveLocalHours(t + off*3600, utc)`
	 * -- but only reaches code that takes a utcOffset. Anything asking a GLOBAL
	 * question ("where is the sub-solar point?") has no such argument, so it
	 * has nothing to fold the offset into and silently answers for real now.
	 *
	 * That is not hypothetical. `Terminator` and `SunMoon` each sampled a
	 * private `Date.now()`, so at `?preset=alpine-ridge` the ground, sky and
	 * wing were lit for a +14.4 deg sun while the night bands and the sun disc
	 * were placed for the real one at -39.5 deg. Two suns, 54 deg apart, in one
	 * frame.
	 *
	 * Read this instead of the clock. It is still absolute (invariant 2): three
	 * panes on the same preset derive the same value from the same second, with
	 * nothing exchanged.
	 */
	solarSec: number = $derived.by(() => this.view.wallSec + this.config.clockOffsetH * 3600);

	/**
	 * What the shade is actually doing: the passenger's setting, overridden
	 * by the automatic occlusion across every rotation boundary.
	 *
	 * Derived, never written back. `config.blindOpen` is in the wall snapshot
	 * and is persisted; an auto-close that wrote it would push "blind closed"
	 * to the wall and survive a reload. A pinned place (`rotate` off) never
	 * occludes: nothing is changing under the shade.
	 */
	blindOpen: boolean = $derived.by(
		() => this.config.blindOpen && !(this.config.rotate && blindClosedAt(this.view.wallSec))
	);

	advanceLocation(): void {
		this.director.advanceDestination(Date.now() / 1000);
	}

	/**
	 * Has the frame loop ever driven a frame?
	 *
	 * Plain, NOT `$state`, and that is the point: the watchdog polls on its own
	 * timer, so it needs a value to read rather than a signal to react to.
	 * Making it reactive would invalidate a derived sixty times a second to
	 * carry a boolean that flips once.
	 *
	 * It exists because `view` is populated in the constructor, so `wallSec` is
	 * fresh at mount whether or not a loop ever starts. Without this the
	 * watchdog cannot tell "not started yet" from "stopped" -- and a cold start
	 * on a Pi is slow enough to look exactly like a stall.
	 */
	hasAdvanced = false;

	/**
	 * `wallSec` is required, and was a defaulted `Date.now() / 1000` until the
	 * default turned out to be doing real work: `Stage.svelte` passed the clock
	 * explicitly and `CesiumStage.svelte` rode the default, so the two renderers
	 * sourced the same quantity two different ways. That is invariant 8 leaking
	 * -- a renderer projects the pose, it never sources it -- and a defaulted
	 * clock is how a third renderer would leak it again without anyone noticing.
	 * Required means the type checker asks the question at every call site.
	 */
	advanceTo(wallSec: number): CameraView {
		this.hasAdvanced = true;
		if (typeof performance !== 'undefined') {
			const now = performance.now();
			const delta = now - this.#lastTickTime;
			this.#lastTickTime = now;
			this.#frameCount++;

			if (now - this.#lastFpsUpdate >= 500) {
				this.fps = Math.round((this.#frameCount * 1000) / (now - this.#lastFpsUpdate));
				this.frameTimeMs = Number(delta.toFixed(1));
				this.#frameCount = 0;
				this.#lastFpsUpdate = now;
			}
		}

		/**
		 * BEFORE the tick, and that ordering is load-bearing: a snapshot may pin a
		 * place and clear `rotate`, and `director.tick` already early-returns on
		 * `!rotate`. Applying after would let the director rotate past the pinned
		 * place for exactly one frame on the pane that applied first.
		 *
		 * This is also the only place a wall snapshot is ever applied. The fetch
		 * fills a buffer; if the assignment happened when the fetch resolved,
		 * network jitter would be an input to the pose.
		 */
		this.wall.applyDue(wallSec, this.config);

		// Wall clock, not a frame delta: the destination is derived from the
		// second, so every pane lands on the same place without being told.
		this.director.tick(wallSec);

		let next = calculateCameraView(wallSec, this.config);
		// Carry the Stage-sampled datum across the fresh object so the Hud's
		// GND number does not blink on frames the Stage loop has not rerun.
		next.groundM = this.view.groundM;
		next = this.applyCruiseBlend(wallSec, next);
		this.view = next;
		return next;
	}

	#lastPlaceKey: string | null = null;
	#lastParams: {
		place: CameraParams['place'];
		floorM: number;
		ceilingM: number;
		direction: 1 | -1;
	} | null = null;
	#cruiseFrom: {
		place: CameraParams['place'];
		floorM: number;
		ceilingM: number;
		direction: 1 | -1;
		atSec: number;
	} | null = null;

	/**
	 * Glide across destination (or direction) changes instead of cutting.
	 *
	 * The old pose is recomputed for the SAME second from the previous
	 * place — FlightTrack is pure, so there is nothing to have stored but
	 * the previous params. Floor/ceiling knob drags do NOT blend: they
	 * change every frame while dragged and would chase forever.
	 */
	private applyCruiseBlend(wallSec: number, next: CameraView): CameraView {
		const key = `${this.config.place.id}|${this.config.direction}`;
		if (this.#lastPlaceKey !== null && key !== this.#lastPlaceKey && this.#lastParams) {
			this.#cruiseFrom = { ...this.#lastParams, atSec: cruiseStartSec(wallSec) };
		}
		this.#lastPlaceKey = key;
		this.#lastParams = {
			place: this.config.place,
			floorM: this.config.floorM,
			ceilingM: this.config.ceilingM,
			direction: this.config.direction ?? 1
		};
		const from = this.#cruiseFrom;
		if (!from) return next;
		const t = (wallSec - from.atSec) / CRUISE_BLEND_SEC;
		if (t >= 1 || t <= 0) {
			this.#cruiseFrom = null;
			return next;
		}
		const old = calculateCameraView(wallSec, {
			...this.config,
			place: from.place,
			floorM: from.floorM,
			ceilingM: from.ceilingM,
			direction: from.direction
		});
		old.groundM = next.groundM;
		return blendViews(old, next, t);
	}
}

export function createDisplay(configOrParams?: PaneSettings | (() => PaneSettings)): AeroDisplay {
	const display = new AeroDisplay(configOrParams);
	setDisplayContext(display);
	return display;
}

export function useDisplay(): AeroDisplay {
	const ctx = getDisplayContext();
	if (!ctx) {
		throw new Error('useDisplay() called outside of AeroDisplay provider context');
	}
	return ctx;
}
