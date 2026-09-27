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
