<script lang="ts">
	/**
	 * Terminator — the day/night line as draped vector geometry.
	 *
	 * Five nested night-cap bands around the antisolar point (see
	 * terminator.ts), drawn as fills between the ground photograph and the
	 * emitted city lights: dusk darkens the ground on the night side while
	 * VIIRS, lamp dots and casings keep glowing through it. That is the
	 * composition Cesium gets from per-pixel sun blending, recovered as
	 * geometry because MapLibre raster takes no sun input.
	 *
	 * Refreshes every 60 s (the sun moves 0.25°/min). Mounts by position —
	 * right after Water, before NightLights — so the lights never dim.
	 * No `beforeId`: the VIIRS layer id is auto-generated and the roads
	 * layers gate on night, so there is no stable target to name.
	 */
	import { untrack } from 'svelte';
	import { FillLayer, GeoJSONSource } from 'svelte-maplibre-gl';
	import { useDisplay } from '../display.svelte.js';
	import { nightOverlay } from './terminator.js';

	const display = useDisplay();

	/**
	 * `display.solarSec`, never `Date.now()`. A preset composes the scene at
	 * some other hour, and the ground, sky and wing all honour it; a private
	 * clock here drapes the REAL night band over a composed daylit scene.
	 *
	 * Read untracked, because `solarSec` moves every frame and rebuilding five
	 * nested multi-polygons sixty times a second to chase a sun that travels
	 * 0.25 deg/min is the reason the 60 s timer exists. `clockOffsetH` IS
	 * tracked: an operator changing the preset should not wait out the timer.
	 */
	let overlay = $state(nightOverlay(untrack(() => display.solarSec)));
	$effect(() => {
		// Read to subscribe, not for the value -- `void` so it is not mistaken
		// for a dead statement and stripped by a tidy-up later.
		void display.config.clockOffsetH;
		const refresh = () => (overlay = nightOverlay(untrack(() => display.solarSec)));
		refresh();
		const id = setInterval(refresh, 60_000);
		return () => clearInterval(id);
	});
</script>

<GeoJSONSource id="night-terminator" data={overlay}>
	<FillLayer
		paint={{
			'fill-color': '#060a18',
			'fill-opacity': ['coalesce', ['get', 'opacity'], 0]
		}}
	/>
</GeoJSONSource>
