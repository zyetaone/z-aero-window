import { describe, it, expect } from 'vitest';
import {
	LIVE_WEATHER_APPLY_SEC,
	LIVE_WEATHER_LEAD_SEC,
	LIVE_WEATHER_POLL_SEC,
	LiveWeatherSync,
	isWeather,
	liveWeatherApplyAt,
	nextLiveWeatherFetch
} from '#lib/display/world/live-weather.js';
import { createSettings } from '#lib/settings/settings.svelte.js';
import { scheduledWeather } from '#lib/display/flight/view.js';
import type { Weather } from '#lib/wall.js';

describe('the poll grid is a function of the wall clock, not of mount time', () => {
	it('fetches lead seconds before every poll boundary, strictly after now', () => {
		const B = LIVE_WEATHER_POLL_SEC;
		const L = LIVE_WEATHER_LEAD_SEC;
		expect(nextLiveWeatherFetch(0)).toBe(B - L);
		expect(nextLiveWeatherFetch(B - L - 0.5)).toBe(B - L);
		// AT a fetch second the next one is a full period on: never re-fires the same slot.
		expect(nextLiveWeatherFetch(B - L)).toBe(2 * B - L);
		expect(nextLiveWeatherFetch(B - L + 0.01)).toBe(2 * B - L);
		// Two panes booting 400 s apart land on the same next fetch second.
		expect(nextLiveWeatherFetch(1_700_000_100)).toBe(nextLiveWeatherFetch(1_700_000_500));
	});

	it('a scheduled fetch applies AT the poll boundary it was scheduled before', () => {
		const B = LIVE_WEATHER_POLL_SEC;
		const fetchSec = nextLiveWeatherFetch(0);
		expect(liveWeatherApplyAt(fetchSec)).toBe(B);
		// A timer that fired late (a stalled pane) still lands on the same boundary
		// for anything under a full apply quantum.
		expect(liveWeatherApplyAt(fetchSec + LIVE_WEATHER_APPLY_SEC - 1)).toBe(B);
	});

	it('a mount fetch applies at the next minute, not the next quarter hour', () => {
		expect(liveWeatherApplyAt(1234)).toBe(1260);
		expect(liveWeatherApplyAt(1259)).toBe(1260);
		expect(liveWeatherApplyAt(1260)).toBe(1320);
	});

	it('only union members may advise the sky', () => {
		expect(isWeather('storm')).toBe(true);
		expect(isWeather('snow')).toBe(false);
		expect(isWeather(undefined)).toBe(false);
	});
});

describe('LiveWeatherSync', () => {
	/** Tick a pane through whole wall seconds, the way the component's 1 Hz effect does. */
	function tick(
		sync: LiveWeatherSync,
		config: ReturnType<typeof createSettings>,
		from: number,
		to: number
	) {
		const applied: number[] = [];
		for (let s = from; s <= to; s++) if (sync.applyDue(s, config)) applied.push(s);
		return applied;
	}

	it('buffers a reading without applying it', () => {
		const sync = new LiveWeatherSync();
		const config = createSettings();
		sync.receive('rain', 840);
		expect(config.weather).toBe('clear');
		expect(sync.pending?.applyAtWallSec).toBe(900);
	});

	it('two panes fed the same reading at different resolve times apply at the same second', () => {
		const a = new LiveWeatherSync();
		const b = new LiveWeatherSync();
		const configA = createSettings();
		const configB = createSettings();
		const fetchSec = nextLiveWeatherFetch(800); // 840

		// Pane A's response is back within the second; it ticks from 841.
		a.receive('rain', fetchSec);
		const appliedA = tick(a, configA, 841, 899);
		expect(appliedA).toEqual([]);
		expect(configA.weather).toBe('clear');

		// Pane B's response took three seconds and it ticked meanwhile.
		expect(tick(b, configB, 841, 843)).toEqual([]);
		b.receive('rain', fetchSec);
		expect(tick(b, configB, 844, 899)).toEqual([]);
		expect(configB.weather).toBe('clear');

		// Same second, same value.
		expect(tick(a, configA, 900, 901)).toEqual([900]);
		expect(tick(b, configB, 900, 901)).toEqual([900]);
		expect(configA.weather).toBe('rain');
		expect(configB.weather).toBe('rain');
	});

	it('a response that arrives after the boundary applies on the next tick, to the same value', () => {
		const late = new LiveWeatherSync();
		const config = createSettings();
		expect(tick(late, config, 841, 904)).toEqual([]);
		late.receive('overcast', 840);
		expect(tick(late, config, 905, 906)).toEqual([905]);
		expect(config.weather).toBe('overcast');
	});

	it('a newer reading supersedes one still waiting', () => {
		const sync = new LiveWeatherSync();
		const config = createSettings();
		sync.receive('rain', 840);
		sync.receive('storm', 850);
		tick(sync, config, 851, 900);
		expect(config.weather).toBe('storm');
		expect(sync.pending).toBeNull();
	});

	it('clear() drops the buffer: a place change must not land the old sky on the new place', () => {
		const sync = new LiveWeatherSync();
		const config = createSettings();
		sync.receive('rain', 840);
		sync.clear();
		expect(tick(sync, config, 841, 1000)).toEqual([]);
		expect(config.weather).toBe('clear');
	});

	it('applying is idempotent through settings: same value, no assignment', () => {
		const sync = new LiveWeatherSync();
		const config = createSettings();
		config.weather = 'rain';
		sync.receive('rain', 840);
		expect(tick(sync, config, 900, 900)).toEqual([900]);
		expect(config.weather).toBe('rain');
	});
});

/**
 * CONVERGENCE — the property that was missing, and the reason this was a blocker.
 *
 * `applyDue` only ever writes from `pending`, so a pane whose fetch FAILED never
 * applied anything and simply kept the last value it had. Its neighbours
 * applied the new one. Because a live reading pinned `config.weather` and
 * `weatherAt` gives any non-'clear' value precedence over `scheduledWeather`
 * FOREVER, that divergence had no expiry: two panes, two skies, indefinitely.
 *
 * With the override bounded to the slot it was scheduled for, every pane returns
 * to `scheduledWeather(wallSec)` at the same wall second — a pure function of
 * the clock, identical everywhere — so panes converge whether the next fetch
 * succeeds, fails, or never arrives. Divergence is bounded to one poll period
 * instead of permanent.
 */
describe('live weather convergence', () => {
	/** A config stub that records writes, like the real one. */
	function cfg(): { weather: string; applyLiveWeather(w: Weather): void } {
		return {
			weather: 'clear',
			applyLiveWeather(w) {
				this.weather = w;
			}
		};
	}

	/** The pane's EFFECTIVE weather, i.e. what `weatherAt` would return. */
	function effective(c: { weather: string }, wallSec: number): string {
		return c.weather !== 'clear' ? c.weather : scheduledWeather(wallSec);
	}

	it('two panes, one fetch failing, converge within one poll period', () => {
		const a = new LiveWeatherSync();
		const b = new LiveWeatherSync();
		const ca = cfg();
		const cb = cfg();

		// Both panes start from the schedule: no pin, so they agree by construction.
		expect(effective(ca, 0)).toBe(effective(cb, 0));

		// Slot boundary at 900. Left fetches at 840 and succeeds; right's fetch
		// fails, so `receive` is never called — the only thing the network can do.
		a.receive('storm', 840);

		// Walk both panes forward to 1200. Left applies at 900; right applies nothing.
		for (let t = 841; t <= 1200; t += 5) {
			a.applyDue(t, ca);
			b.applyDue(t, cb);
		}
		// In the divergence window the panes genuinely differ — that is the honest
		// cost of a per-pane live reading with no shared origin, and it is bounded.
		expect(ca.weather).toBe('storm');
		expect(cb.weather).toBe('clear');

		// Left's reading lapses one poll period after it landed (900 + 900 = 1800).
		for (let t = 1205; t <= 2000; t += 5) {
			a.applyDue(t, ca);
			b.applyDue(t, cb);
		}
		// Both are back on the schedule, so they agree again — and they agree
		// because the SCHEDULE is a function of the wall second, not because
		// either pane learned anything from the other.
		expect(ca.weather).toBe('clear');
		expect(cb.weather).toBe('clear');
		expect(effective(ca, 2000)).toBe(effective(cb, 2000));
	});

	it('a pane whose fetches all fail still lapses its stale pin', () => {
		// The specific case that had no recovery: a pane that once succeeded and
		// then started failing held the old value FOREVER. The expiry does not
		// depend on a further fetch, which is the whole point of putting it in
		// applyDue rather than in the fetch path.
		const s = new LiveWeatherSync();
		const c = cfg();
		s.receive('overcast', 840);
		s.applyDue(900, c);
		expect(c.weather).toBe('overcast');
		expect(s.liveExpiresWallSec).toBe(900 + LIVE_WEATHER_POLL_SEC);

		// No further receive() calls — the fetches are failing.
		for (let t = 905; t <= 1800; t += 5) s.applyDue(t, c);
		expect(c.weather).toBe('clear');
	});

	it('a succeeding pane does not extend its override forever', () => {
		// Expiry runs before the apply, so each fresh reading sets a fresh
		// deadline rather than rolling the old one forward. If the order were
		// reversed, a pane with a working fetch chain would stay pinned
		// indefinitely — reintroducing the original bug for the happy path.
		const s = new LiveWeatherSync();
		const c = cfg();
		let applied = 0;
		for (let slot = 1; slot <= 5; slot++) {
			const fetchAt = slot * LIVE_WEATHER_POLL_SEC - LIVE_WEATHER_LEAD_SEC;
			s.receive('cloudy', fetchAt);
			const applyAt = fetchAt + LIVE_WEATHER_LEAD_SEC;
			s.applyDue(applyAt, c);
			applied++;
			expect(c.weather).toBe('cloudy');
			// It is always live, because each slot's reading replaces the last.
			expect(s.liveExpiresWallSec).toBe(applyAt + LIVE_WEATHER_POLL_SEC);
		}
		expect(applied).toBe(5);
		// And when the fetches stop, the last one lapses.
		for (let t = 6 * LIVE_WEATHER_POLL_SEC; t <= 8 * LIVE_WEATHER_POLL_SEC; t += 5) {
			s.applyDue(t, c);
		}
		expect(c.weather).toBe('clear');
	});

	it('a live "clear" reading is not mistaken for a stale pin', () => {
		// 'clear' is both a real weather and the no-override sentinel, so a live
		// 'clear' is indistinguishable from "nothing applied". That is harmless
		// now: after expiry the schedule decides either way, and before expiry the
		// schedule is what a clear sky means. The failure this replaces was the
		// INVERTED one — a pane that SUCCEEDED with 'clear' fell back to the
		// schedule while a pane that FAILED kept its stale value.
		const s = new LiveWeatherSync();
		const c = cfg();
		s.receive('clear', 840);
		s.applyDue(900, c);
		expect(c.weather).toBe('clear');
		expect(s.liveExpiresWallSec).toBe(900 + LIVE_WEATHER_POLL_SEC);
		// Still authoritative until the deadline, then hands back cleanly.
		s.applyDue(1800, c);
		expect(c.weather).toBe('clear');
	});
});
