<script lang="ts">
	/**
	 * Water — sun glint on lakes and sea, from a Sentinel-2 classification mask.
	 *
	 * WHY A MASK EXISTS AT ALL. MapLibre draws a PHOTOGRAPH of water; Cesium drew
	 * it as a SURFACE (normal map plus a light vector), which is why v1 shimmered
	 * and this reads flat. No amount of raster grading recovers that — the grade
	 * operates on a still image. A specular layer can, but it has to know WHERE
	 * the water is, and Terrarium carries no water bit (v1 got one from Cesium's
	 * quantized-mesh `requestWaterMask`).
	 *
	 * `tools/fetch-water-mask.py` reclassifies the Sentinel-2 Scene
	 * Classification band — class 6 is water — into an RGBA tile that is white
	 * where water and fully transparent everywhere else. So the mask carries its
	 * own coverage in alpha and needs nothing but `raster-opacity` to composite.
	 *
	 * WHAT IT DRAWS. Not a colour wash — a GLINT. Opacity is driven by
	 * `specularGlint`, which is strong only when the sun is low AND the window
	 * is pointed at it, because that is the geometry that makes a lake a mirror
	 * at 18:00 and a flat grey sheet at noon. Facing away from a low sun, or at
	 * any high sun, this layer is invisible and unmounted.
	 *
	 * That per-pane response is also why it earns its place on a three-Pi wall:
	 * the panes point at different bearings, so the left window can be looking
	 * across a blazing lake while the right sees the same water flat and dark.
	 * It is the same asymmetry the sunward haze draws, on the surface instead of
	 * in the air, and both read `facingSunAmount` so they cannot disagree about
	 * where the sun is.
	 */
	import { RasterLayer, RasterTileSource } from 'svelte-maplibre-gl';

	import {
		TILE_MAXZOOM,
		TILE_SIZE,
		WATER_MINZOOM,
		WATER_PLACES,
		tileTemplates
	} from '#lib/settings/tiles.js';
	import { PUBLIC_TILE_SERVER_URL } from '$app/env/public';
	import { useDisplay } from '../display.svelte.js';
	import { specularGlint } from './sun.js';
	import { weatherLightLoss } from './atmosphere.js';

	const display = useDisplay();
	// PUBLIC_TILE_SERVER_URL, so a pane can read tiles from a peer on the wall.
	const tiles = tileTemplates(PUBLIC_TILE_SERVER_URL);

	/**
	 * Only where the mask is packed.
	 *
	 * Same gate as `SENTINEL2_PLACES`, and the same measured reason: a source
	 * mounted where it has no tiles fired 203 requests in 16 seconds over the
	 * Pacific and 404'd every one.
	 */
	const hasMask = $derived(WATER_PLACES.has(display.config.place.id));

	/**
	 * Overcast kills a glint outright — there is no sun disc to reflect, which
	 * is exactly why a lake goes flat and grey under cloud. Reuses the same
	 * scalar as the sky and the ground so the three cannot disagree.
	 */
	const overcast = $derived(weatherLightLoss(display.config.weather));

	const glint = $derived(
		specularGlint(display.view.cameraBearingDeg, display.sun.azimuthDeg, display.sun.elevationDeg) *
			(1 - overcast)
	);

	/**
	 * Capped low on purpose. This is a sheen ON a photograph that already
	 * contains the water's own colour, not a replacement for it — pushed higher
	 * it stops reading as light on a surface and starts reading as a white
	 * shape stamped over the lake, which is worse than the flatness it set out
	 * to fix.
	 */
	/**
	 * Breathing, not ripples. A photograph cannot be made to flow, but a glint
	 * on real water is never steady: two slow beats (7 s and 11 s, so the
	 * product never repeats inside a minute) swing the sheen between 70% and
	 * 100%. Pure in wallSec, so three panes breathe together; 0.01 steps, so
	 * the paint write lands a few times a second, not every frame.
	 */
	const breathe = $derived.by(() => {
		const t = display.view.wallSec;
		const w = 0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / 7) * Math.sin((t * 2 * Math.PI) / 11);
		return Math.round((0.7 + 0.3 * w) * 100) / 100;
	});
	const opacity = $derived(Math.round(Math.min(0.34, glint * 0.34) * breathe * 100) / 100);
</script>

{#if hasMask && opacity > 0.01}
	<RasterTileSource
		id="water"
		tiles={tiles.water}
		tileSize={TILE_SIZE}
		minzoom={WATER_MINZOOM}
		maxzoom={TILE_MAXZOOM.water}
	>
		<RasterLayer
			paint={{
				'raster-opacity': opacity,
				// No fade: the glint is already a smooth function of the pose, and a
				// crossfade on top would make it a function of tile arrival too.
				'raster-fade-duration': 0,
				'raster-resampling': 'linear'
			}}
		/>
	</RasterTileSource>
{/if}
