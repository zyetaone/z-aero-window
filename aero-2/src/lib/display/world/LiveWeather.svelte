<script lang="ts">
	/**
	 * LiveWeather — the sky follows the real atmosphere.
	 *
	 * Polls same-origin `/api/weather` (a thin proxy over Open-Meteo, which is
	 * free and keyless) for the flown place and advises the mapped union to
	 * `config.applyLiveWeather`, which every consumer — deck pools, coverage,
	 * proximity, hillshade, ground grade, rain glass — already reads through
	 * `config.weather`. No new plumbing: the weather knob gains a live author
	 * and nothing else changes.
	 *
	 * Wall-shared by construction, not by hope (ADR-007). The poll grid, the
	 * apply second and the buffer live in `live-weather.ts`: fetches fire 60 s
	 * before each 15-minute wall boundary on every pane, the reading waits in
	 * `LiveWeatherSync`, and `applyDue` lands it AT the boundary — the second
	 * Clouds' own coverage slot rolls on. The old shape polled from mount time
	 * and wrote on fetch resolution, which is three panes on three private
	 * grids; see the module header for why that was the ADR-007 violation.
	 *
	 * Offline is a no-op (the route 503s, nothing is buffered), and
	 * `?weather=` pins the sky by switching `liveWeather` off in settings, so
	 * a staged A/B cannot wander.
	 */
	import { untrack } from 'svelte';
	import { useDisplay } from '../display.svelte.js';
	import { LiveWeatherSync, isWeather, nextLiveWeatherFetch } from './live-weather.js';
	import type { Weather } from '#lib/wall.js';

	const display = useDisplay();
	const sync = new LiveWeatherSync();

	/** The apply clock: whole wall seconds, so the apply effect runs at 1 Hz, not per frame. */
	const tickSec = $derived(Math.floor(display.view.wallSec));

	async function fetchReading(
		lat: number,
		lon: number,
		signal: AbortSignal
	): Promise<Weather | null> {
		let res: Response;
		try {
			res = await fetch(`/api/weather?lat=${lat}&lon=${lon}`, { signal });
		} catch {
			return null; // offline, or aborted by a place change — hold course
		}
		if (!res.ok) return null;
		let body: { weather?: unknown };
		try {
			body = (await res.json()) as { weather?: unknown };
		} catch {
			return null;
		}
		return isWeather(body.weather) ? body.weather : null;
	}

	/**
	 * Scheduling. Reads `wallSec` UNTRACKED: `view` is replaced every frame,
	 * and a tracked read here would abort and reschedule the poll 60×/s.
	 *
	 * The apply boundary is keyed on the second a fetch was SCHEDULED for,
	 * and that second is threaded through the timer chain rather than
	 * re-read when it fires: `view.wallSec` is written by the RAF loop, so
	 * at fire time it can lag the timer by a frame (839.99 for a fetch
	 * scheduled at 840), and flooring that would move the boundary by a
	 * whole minute on the strength of one pane's RAF phase. A timer that
	 * fires late after a stall still names the neighbours' boundary; its
	 * reading applies late, to the same value. The clock is read only for
	 * the delay to the next scheduled second, and on the mount fast path.
	 */
	$effect(() => {
		const place = display.config.place;
		if (!display.config.liveWeather) return;

		let controller: AbortController | null = null;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const poll = (scheduledSec: number | null) => {
			const now = untrack(() => display.view.wallSec);
			const fetchSec = scheduledSec ?? Math.floor(now);
			controller?.abort();
			const c = new AbortController();
			controller = c;
			void fetchReading(place.lat, place.lon, c.signal).then((w) => {
				if (w && !c.signal.aborted) sync.receive(w, fetchSec);
			});
			const next = nextLiveWeatherFetch(scheduledSec ?? now);
			timer = setTimeout(() => poll(next), Math.max(0, next - now) * 1000);
		};
		// Mount fast path: fetch now, land at the next minute (live-weather.ts).
		poll(null);

		return () => {
			clearTimeout(timer);
			controller?.abort();
			// A reading for the old place must never land on the new one.
			sync.clear();
		};
	});

	// Advise, never assign: weather is a wall key and only settings itself
	// may write it. Untracked so the write inside applyLiveWeather cannot
	// re-run this effect; `tickSec` is its only dependency.
	$effect(() => {
		const sec = tickSec;
		if (!display.config.liveWeather) return;
		untrack(() => sync.applyDue(sec, display.config));
	});
</script>
