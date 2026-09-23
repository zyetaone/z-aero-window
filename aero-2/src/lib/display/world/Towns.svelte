<script lang="ts">
	/**
	 * Towns — distant lamp clusters from the VIIRS raster, drawn as points.
	 *
	 * WHY POINTS AND NOT THE RASTER: the raster is a 468 m/px photograph of
	 * light, and a town in it is a smudge — glow with no structure. From
	 * cruise the ring of towns around every visit read as haze, not
	 * habitation. `tools/extract-town-lamps.mjs` bakes each bright ~5 km
	 * cell into a lamp point with an intensity, and this draws them as soft
	 * amber circles over the raster: clusters of individual lamps where the
	 * photograph has no pixels to give.
	 *
	 * It sits between NightLights and Roads by mount order: above the
	 * regional glow it textures, below the sharp vectors it must never
	 * cover. No altitude gate — unlike the road vectors these are the ONLY
	 * structure outside the packed box at every height, so they stay from
	 * thread altitude to ceiling. Steady opacity (no 5 Hz shimmer):
	 * hundreds of points breathing in unison reads as a faulty sensor,
	 * and per-point phasing is beyond what a circle layer can do.
	 */
	import { GeoJSONSource, CircleLayer } from 'svelte-maplibre-gl';
	import { useDisplay } from '../display.svelte.js';
	import {
		hysteresisGate,
		NIGHT_LIGHT_RAMP,
		NIGHT_MOUNT_OFF,
		NIGHT_MOUNT_ON
	} from './sun.js';
	import { Location } from '#lib/locations.js';

	const display = useDisplay();

	const place = $derived(display.config.place);
	const night = $derived(display.night);

	// Same arrival curve as the raster and the road vectors: three lighting
	// layers on three different ramps would read as two of them lagging.
	const lightUp = $derived(
		Math.min(1, night ** NIGHT_LIGHT_RAMP * Location.moodFor(place.id).nightGlow)
	);

	// Night-gated mount, same hysteresis as the sibling layers: monotonic
	// over hours (two transitions a day), so the source is not re-parsed
	// on any faster cycle. Tracked, not untracked — see Roads.svelte.
	const hasTowns = $derived(!place.isFeature);
	let latched = $state(false);
	$effect(() => {
		latched = hysteresisGate(lightUp, latched, NIGHT_MOUNT_ON, NIGHT_MOUNT_OFF);
	});
	const mounted = $derived(hasTowns && latched);

	/**
	 * Dim towns stay on the map: intensity weights the opacity but never
	 * below a third, so a hamlet at i=0.1 draws faint rather than not at
	 * all. Absence that looks like measurement is this repo's most
	 * expensive recurring bug; a missing town must mean a dark valley.
	 */
	const opacity = $derived(['*', lightUp, ['max', ['get', 'i'], 0.35]] as never);
	const color = [
		'interpolate',
		['linear'],
		['get', 'i'],
		0,
		'#7c2d12',
		0.5,
		'#ffab45',
		1,
		'#ffd9a0'
	] as never;
	const radius = [
		'interpolate',
		['linear'],
		['zoom'],
		7,
		1.5,
		11,
		3
	] as never;
</script>

{#if mounted}
	<GeoJSONSource id="town-lamps" data="/api/towns/{place.id}">
		<CircleLayer
			id="town-lamps-points"
			paint={{
				'circle-color': color,
				'circle-radius': radius,
				'circle-blur': 0.5,
				'circle-opacity': opacity,
				'circle-stroke-width': 0
			}}
		/>
	</GeoJSONSource>
{/if}
