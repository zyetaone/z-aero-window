<script lang="ts">
	/**
	 * LiveWeather — the sky follows the real atmosphere.
	 *
	 * Polls same-origin `/api/weather` (a thin proxy over Open-Meteo, which is
	 * free and keyless) for the flown place and writes the mapped union into
	 * `config.weather`, which every consumer — deck pools, coverage, proximity,
	 * hillshade, ground grade, rain glass — already reads. No new plumbing:
	 * the weather knob gains a live author and nothing else changes.
	 *
	 * Cadence: once per mount/place plus every 15 minutes, aligned with the
	 * deck's own coverage-slot rhythm so a change lands near a slot boundary
	 * instead of mid-slot. A weather change re-rolls the deck once — the same
	 * price the operator's slider always paid.
	 *
	 * Offline is a no-op (the route 503s, the assignment never happens), and
	 * `?weather=` pins the sky by switching `liveWeather` off in settings, so
	 * a staged A/B cannot wander. Wall-shared by construction: all panes poll
	 * the same endpoint for the same place and apply the same union.
	 */
	import { useDisplay } from '../display.svelte.js';
	import type { Weather } from '../flight/view.js';

	const display = useDisplay();

	const POLL_MS = 15 * 60 * 1000;

	async function refresh(lat: number, lon: number): Promise<void> {
		let res: Response;
		try {
			res = await fetch(`/api/weather?lat=${lat}&lon=${lon}`);
		} catch {
			return; // offline — hold course
		}
		if (!res.ok) return;
		let body: { weather?: unknown };
		try {
			body = (await res.json()) as { weather?: unknown };
		} catch {
			return;
		}
		const w = body.weather;
		if (w === 'clear' || w === 'cloudy' || w === 'rain' || w === 'overcast' || w === 'storm') {
			// Advise, never assign: weather is a wall key (ADR-007) and only
			// settings itself may write it. The method is idempotent, so an
			// unchanged sky costs nothing downstream.
			display.config.applyLiveWeather(w as Weather);
		}
	}

	$effect(() => {
		const place = display.config.place;
		if (!display.config.liveWeather) return;
		void refresh(place.lat, place.lon);
		const id = setInterval(() => {
			void refresh(place.lat, place.lon);
		}, POLL_MS);
		return () => clearInterval(id);
	});
</script>
