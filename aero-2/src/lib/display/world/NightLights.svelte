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
	import {
		hysteresisGate,
		NIGHT_LIGHT_RAMP,
		NIGHT_MOUNT_OFF,
		NIGHT_MOUNT_ON,
		NIGHT_VECTOR_SPAN_M,
		NIGHT_VECTOR_TOP_M
	} from './sun.js';
	import { weatherLightLoss } from './atmosphere.js';
	import { Location } from '#lib/locations.js';

	const display = useDisplay();
	/** Metres above the road-lamp handover over which the cruise exposure ramps in. */
	const CRUISE_EXPOSURE_SPAN_M = 4000;
	// PUBLIC_TILE_SERVER_URL, so a pane can read tiles from a peer on the wall.
	const tiles = tileTemplates(PUBLIC_TILE_SERVER_URL);

	const night = $derived(display.night);

	/**
	 * How strongly the city-lights raster shows. Ramped on the shared
	 * NIGHT_LIGHT_RAMP so it stays out of dusk — a linear fade puts lights
	 * on a sky that is still blue. `Roads.svelte` uses the same constant
	 * deliberately: the vector layer sharpens this raster once VIIRS runs
	 * out of resolution at z8, and two lighting layers arriving on
	 * different ramps would read as one of them lagging.
	 */
	// Showcase cities burn brighter, sleeping desert dimmer — same ramp,
	// per-place gain. Applied here AND in Roads so the vector still arrives
	// with its raster.
	//
	// Altitude crossfade with the vectors, and that direction matters. The
	// raster is a 468 m/px smudge: perfect at cruise, a blanket pasted over
	// whole towns on approach. Roads does the opposite — it fades IN from 9
	// down to 4 km — so the raster fades OUT across the same window and the
	// street grid takes over exactly where the photograph runs out of pixels.
	// Where there are no vectors (features: ocean, desert, Himalayas) there
	// is nothing to hand over to, so the raster stays.
	const hasVectors = $derived(!display.config.place.isFeature);
	const vectorShare = $derived(
		Math.max(0, Math.min(1, (NIGHT_VECTOR_TOP_M - display.view.aglM) / NIGHT_VECTOR_SPAN_M))
	);
	// Capped at 0.8, not 0.95: the z8 raster is blocky up close and at full
	// weight it reads as grey pixels, not city glow. The vectors carry the
	// street-level truth now; this stays a halo.
	const nightLightOpacity = $derived(
		Math.min(
			0.8,
			night ** NIGHT_LIGHT_RAMP *
				Location.moodFor(display.config.place.id).nightGlow *
				(hasVectors ? 1 - vectorShare : 1)
		)
	);

	// Latched against twilight dither, but TRACKED: `untrack` here evaluated
	// the gate once at mount and froze it, so a dusk boot never mounted the
	// layer no matter how dark it got. The hysteresis thresholds (not the
	// untrack) are what stop the blinking; same-value writes don't notify.
	let latched = $state(false);
	$effect(() => {
		latched = hysteresisGate(nightLightOpacity, latched, NIGHT_MOUNT_ON, NIGHT_MOUNT_OFF);
	});

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
	 * that a city never loses. The per-place gain already sits in
	 * nightLightOpacity above, so it is not applied twice here.
	 */
	const lowPass = $derived(
		Math.round(Math.max(0, Math.min(1, (display.view.aglM - 1000) / 1500)) * 100) / 100
	);
	// The regional glow dims under a cloud deck too (Roads.svelte, `deck`). 0.01 steps.
	const deck = $derived(weatherLightLoss(display.weather));
	const viirsOpacity = $derived(
		Math.round(
			100 * Math.min(0.5, nightLightOpacity) * (1 - 0.6 * cruise) * (0.25 + 0.75 * lowPass) * (1 - 0.8 * deck)
		) / 100
	);
	const viirsContrast = $derived(0.55 * cruise);
	const viirsBrightnessMax = $derived(1 - 0.3 * cruise);
</script>

<!-- VIIRS arrives already masked: the tile route bakes luminance into an
     amber ramp with transparent blacks (server/viirs-tint.ts) plus baked
     grain tooth, so dark pixels show the ground beneath instead of a white
     sheet. It carries no client grade of its own — it is emitted light,
     not a photograph of a lit surface, which is also why it is mounted here
     rather than beneath the hillshade. -->
{#if latched}
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
