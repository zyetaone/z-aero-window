<script lang="ts">
	/**
	 * NightLights — VIIRS city lights, composited ABOVE the terrain shading.
	 *
	 * WHY THIS IS NOT IN `Ground.svelte`, where it lived until now.
	 *
	 * Layer order in MapLibre follows mount order, and `Stage.svelte` mounts
	 * `Ground` before `Terrain`. So every raster inside Ground — including the
	 * night lights — was drawn UNDER the hillshade, and the hillshade then
	 * blended its shadow and highlight colours over the top of the cities.
	 *
	 * That is physically backwards. Hillshade models how a surface REFLECTS
	 * sunlight, so it belongs over the photographs (`gibs`, `sentinel2`) which
	 * are exactly that. VIIRS is not a photograph of a lit surface, it is
	 * EMITTED light — Ground's own docstring says so — and emitted light does
	 * not get darker because the slope it sits on faces away from a sun that
	 * set hours ago. A city on the shaded side of a ridge is just as bright as
	 * one on the lit side; that is the whole difference between a lamp and a
	 * reflector.
	 *
	 * Measured cost of getting it backwards: at the night hillshade strength
	 * (exaggeration ~0.17 after the day-factor ramp) a bright amber city pixel
	 * rgb(255,214,140) came out rgb(215,182,124) — 15% of the luminance of
	 * every lit city in the frame, removed by a shading model that should not
	 * have been applied to it at all. Cities read dimmer, and dimmer unevenly,
	 * according to terrain that is invisible at night.
	 *
	 * Mounting it after `Terrain` in `Stage.svelte` is the entire fix. It also
	 * puts the three night layers in one honest order, brightest last:
	 *
	 *     gibs / sentinel2   the photograph        (shaded by hillshade)
	 *     hillshade          how the ground faces the sun
	 *     viirs              emitted light         (this file)
	 *     roads              emitted light, sharp  (vector, below z8 blur)
	 */
	import { RasterLayer, RasterTileSource } from 'svelte-maplibre-gl';

	import { IMAGERY_GRADE, TILE_MAXZOOM, TILE_SIZE, tileTemplates } from '#lib/settings/tiles.js';
	import { PUBLIC_TILE_SERVER_URL } from '$app/env/public';
	import { useDisplay } from '../display.svelte.js';
	import { NIGHT_VECTOR_TOP_M } from './sun.js';
	import { weatherLightLoss } from './atmosphere.js';
	import { Location } from '#lib/locations.js';

	const display = useDisplay();
	/** Metres above the road-lamp handover over which the cruise exposure ramps in. */
	const CRUISE_EXPOSURE_SPAN_M = 4000;
	// PUBLIC_TILE_SERVER_URL, so a pane can read tiles from a peer on the wall.
	const tiles = tileTemplates(PUBLIC_TILE_SERVER_URL);

	const night = $derived(display.night);

	/**
	 * How strongly the city-lights raster shows. Ramped on night^1.5 so it stays
	 * out of dusk — a linear fade puts lights on a sky that is still blue.
	 *
	 * `Roads.svelte` uses the same curve deliberately: the vector layer sharpens
	 * this raster once VIIRS runs out of resolution at z8, and two lighting
	 * layers arriving on different ramps would read as one of them lagging.
	 */
	const nightLightOpacity = $derived(Math.min(0.9, night ** 1.5));

	/**
	 * Exposure with altitude. VIIRS stops at z8, about 470 m a pixel, so from
	 * cruise a city is a solid orange sheet of stretched pixels. A passenger
	 * sees the opposite: the higher you are, the more the city collapses to
	 * its bright cores with black between. Above the vector handover the
	 * raster dims, gains contrast (crushes its dim skirt) and loses its
	 * brightest cream. Values poked live at 12 km over Dubai on 2026-09-22
	 * under the committed world grade. The ramp starts where the road lamps
	 * hand over (NIGHT_VECTOR_TOP_M) and is full 4 km above it.
	 */
	const cruise = $derived.by(() => Math.round(100 * (
		Math.max(0, Math.min(1, (display.view.aglM - NIGHT_VECTOR_TOP_M) / CRUISE_EXPOSURE_SPAN_M))
	)) / 100);
	/**
	 * Low pass: below ~2.5 km the road lamps and lit windows carry the city, and
	 * the raster, stretched to metres per pixel, is an orange blanket under
	 * them. It hands two-thirds of itself over to the vectors from 2.5 km down
	 * to 1 km (0.01 steps); the rest stays as the ambient glow between roads
	 * that a city never loses.
	 */
	const lowPass = $derived(
		Math.round(Math.max(0, Math.min(1, (display.view.aglM - 1000) / 1500)) * 100) / 100
	);
	// The regional glow dims under a cloud deck too (Roads.svelte, `deck`). 0.01 steps.
	const deck = $derived(weatherLightLoss(display.weather));
	// Showcase cities glow harder, sleeping places less (Location.moodFor).
	const glowGain = $derived(Location.moodFor(display.config.place.id).nightGlow);
	const viirsOpacity = $derived(
		Math.round(
			100 * Math.min(0.5, nightLightOpacity) * (1 - 0.6 * cruise) * (0.25 + 0.75 * lowPass) * (1 - 0.8 * deck) * glowGain
		) / 100
	);
	const viirsContrast = $derived(0.55 * cruise);
	const viirsBrightnessMax = $derived(1 - 0.3 * cruise);
</script>

<!-- VIIRS is a black frame with bright cities, so over ground the grade has
     already crushed toward black: the dark parts change nothing and the lit
     parts read as towns. It carries no grade of its own — it is emitted light,
     not a photograph of a lit surface, which is also why it is mounted here
     rather than beneath the hillshade. -->
{#if nightLightOpacity > 0.01}
	<RasterTileSource
		id="viirs"
		tiles={tiles.viirs}
		tileSize={TILE_SIZE}
		maxzoom={TILE_MAXZOOM.viirs}
	>
		<RasterLayer
			paint={{
				'raster-opacity': viirsOpacity,
				'raster-contrast': viirsContrast,
				'raster-brightness-max': viirsBrightnessMax,
				'raster-fade-duration': IMAGERY_GRADE.fadeDuration,
				'raster-resampling': IMAGERY_GRADE.resampling
			}}
		/>
	</RasterTileSource>
{/if}
