/**
 * live-weather.ts — when a live reading is fetched, and when it lands.
 *
 * THE BUG THIS EXISTS TO AVOID is the one wall.svelte.ts names: applying a
 * network result when its fetch resolves makes network jitter an input to
 * the picture. LiveWeather.svelte used to `setInterval` from mount time and
 * write `config.weather` as each response arrived — three panes, three
 * mount phases, three fetch latencies, three different seconds at which the
 * deck re-rolled. A pane that rebooted polled on its own 15-minute grid
 * forever after. ADR-007 forbids exactly this: no per-pane accumulated
 * state, nothing derived from a private clock.
 *
 * So the fetch only fills a buffer, and the assignment is a pure function
 * of the wall clock:
 *
 *   - Fetches fire on a wall-clock grid every pane computes identically:
 *     `LIVE_WEATHER_LEAD_SEC` before each `LIVE_WEATHER_POLL_SEC` boundary
 *     (`nextLiveWeatherFetch`). The delay to the first one is computed from
 *     `wallSec`, not from mount time.
 *   - A reading applies at the first `LIVE_WEATHER_APPLY_SEC` multiple after
 *     the second the fetch was SCHEDULED for (`liveWeatherApplyAt`) — not the
 *     second its response arrived. A scheduled fetch at B−60 therefore lands
 *     at B, the same boundary Clouds' `coverSlot` rolls on, so a weather
 *     change re-rolls the deck once, at a slot edge, on every pane at once.
 *   - `LiveWeatherSync.applyDue` is the only thing that writes, and only when
 *     the wall clock has reached that second.
 *
 * The mount fast path: a pane that has just booted fetches immediately and
 * applies at the next minute, rather than sitting on the schedule sky for
 * up to 15 minutes while its neighbours fly the live one. That is a
 * deliberate mid-slot re-roll on one pane, once, to converge. The reading
 * it gets is the neighbours' reading as long as `/api/weather`'s cache
 * still holds it (10 min TTL); past that, agreement is the provider's to
 * give, not this file's — the poll period is longer than the TTL, so the
 * three scheduled fetches at B−60 are three cache misses that match in
 * practice, not by construction.
 *
 * Pure (no Svelte, no DOM) so the two-pane contract is unit-testable: two
 * panes handed the same reading at different resolve times apply it at the
 * same wall second.
 */
import { WEATHERS, type Weather } from '#lib/wall.js';

/** Poll period: every pane fetches once per 15-minute wall slot. */
export const LIVE_WEATHER_POLL_SEC = 900;
/** Fetch this long before the slot boundary the reading applies at. Must cover a slow response. */
export const LIVE_WEATHER_LEAD_SEC = 60;
/** Readings land on the first multiple of this after their scheduled fetch second. */
export const LIVE_WEATHER_APPLY_SEC = 60;

/** The wall second a reading fetched (by schedule) at `fetchWallSec` applies at. */
export function liveWeatherApplyAt(fetchWallSec: number): number {
	return (Math.floor(fetchWallSec / LIVE_WEATHER_APPLY_SEC) + 1) * LIVE_WEATHER_APPLY_SEC;
}

/** The next scheduled fetch second strictly after `wallSec`: lead seconds before a poll boundary. */
export function nextLiveWeatherFetch(wallSec: number): number {
	const k = Math.floor((wallSec + LIVE_WEATHER_LEAD_SEC) / LIVE_WEATHER_POLL_SEC) + 1;
	return k * LIVE_WEATHER_POLL_SEC - LIVE_WEATHER_LEAD_SEC;
}

/** The route answers `{ weather }`; only a member of the union may advise the sky. */
export function isWeather(value: unknown): value is Weather {
	return typeof value === 'string' && (WEATHERS as readonly string[]).includes(value);
}

/** The one method a reading may reach config through (settings.svelte.ts). */
export interface LiveWeatherTarget {
	applyLiveWeather(w: Weather): void;
}

export interface PendingReading {
	readonly weather: Weather;
	readonly applyAtWallSec: number;
}

export class LiveWeatherSync {
	/** Buffered and not yet due. Replaced wholesale, never mutated. */
	pending: PendingReading | null = null;

	/**
	 * Buffer a reading against the second its fetch was SCHEDULED for.
	 * Receiving is not applying. A newer reading supersedes one still
	 * waiting: the later fetch is the fresher sky.
	 */
	receive(weather: Weather, fetchWallSec: number): void {
		this.pending = { weather, applyAtWallSec: liveWeatherApplyAt(fetchWallSec) };
	}

	/**
	 * Apply the buffered reading if its second has arrived. A pane whose
	 * response came back after the boundary applies on its next tick — late,
	 * to the same value its neighbours applied on time.
	 */
	applyDue(wallSec: number, config: LiveWeatherTarget): boolean {
		const due = this.pending;
		if (!due || wallSec < due.applyAtWallSec) return false;
		this.pending = null;
		config.applyLiveWeather(due.weather);
		return true;
	}

	/** Drop whatever is waiting: the place changed, so the reading is for the wrong sky. */
	clear(): void {
		this.pending = null;
	}
}
