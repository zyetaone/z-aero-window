<script lang="ts">
	/**
	 * Ground — satellite colour.
	 *
	 * Circadian-aware: brightness adjusts smoothly from daytime solar illumination
	 * to atmospheric twilight and night.
	 */
	import { RasterLayer, RasterTileSource } from 'svelte-maplibre-gl';

	import {
		IMAGERY_GRADE,
		TILE_ATTRIBUTION,
		SENTINEL2_MINZOOM,
		SENTINEL2_PLACES,
		TILE_MAXZOOM,
		TILE_SIZE,
		sentinel2MaxZoom,
		tileTemplates
	} from '#lib/settings/tiles.js';
	import { weatherLightLoss } from './atmosphere.js';
	import { PUBLIC_TILE_SERVER_URL } from '$app/env/public';
	import { useDisplay } from '../display.svelte.js';

	const display = useDisplay();
	// PUBLIC_TILE_SERVER_URL, so a pane can read tiles from a peer on the wall.
	const tiles = tileTemplates(PUBLIC_TILE_SERVER_URL);

	const night = $derived(display.night);

	/**
	 * Thick cloud dims the ground and pulls the colour out of it.
	 *
	 * Same scalar the sky, the hillshade and the cloud deck read, so the four
	 * cannot drift apart. See `weatherLightLoss`.
	 */
	const overcast = $derived(weatherLightLoss(display.config.weather));

	/**
	 * Only mount the sharp layer where it is packed.
	 *
	 * See SENTINEL2_PLACES: unconditional, the Pacific fired 203 requests in
	 * 16 seconds and 404'd every one. `{#if}` unmounts the source entirely,
	 * which is the only thing that stops MapLibre asking.
	 */
	const hasSentinel2 = $derived(SENTINEL2_PLACES.has(display.config.place.id));

	/**
	 * Pull the white out of the texture.
	 *
	 * MODIS at z9 is a hazy, low-contrast wash — the bright end blows out into a
	 * flat sheet long before the dark end does anything, which is what reads as
	 * "white" from the window. Capping the bright end below 1 is what actually
	 * removes it; contrast alone just moves the blowout around.
	 */
	const DAY_HIGHLIGHT_CEIL = 0.78;

	/**
	 * At night, let the light seep through while deeply darkening unlit terrain.
	 *
	 * The floor falls FASTER than the ceiling. Everything dim
	 * — fields, water, bare ground — is crushed to deep nocturnal tones, while the brightest
	 * pixels survive the squeeze and remain distinct.
	 */
	const groundBrightnessMax = $derived((DAY_HIGHLIGHT_CEIL - night * 0.62) * (1 - overcast * 0.45));
	const groundBrightnessMin = $derived(0.01 * (1 - night) ** 2);

	/** Lift contrast into the night so features separate crisply. */
	const groundContrast = $derived(IMAGERY_GRADE.contrast + 0.06 + night * 0.38);

	/**
	 * Desaturate INTO the night rather than out of it. Night imagery is still a
	 * daylight photograph; leaving it colour-saturated at low brightness reads
	 * as murky brown rather than as darkness.
	 */
	const groundSaturation = $derived(
		IMAGERY_GRADE.saturation - night * 0.35 - overcast * 0.4 * (1 - night)
	);

	/** One grade, applied to every colour source. */
	const grade = $derived({
		'raster-saturation': groundSaturation,
		'raster-contrast': groundContrast,
		'raster-brightness-max': groundBrightnessMax,
		'raster-brightness-min': groundBrightnessMin,
		'raster-fade-duration': IMAGERY_GRADE.fadeDuration,
		'raster-resampling': IMAGERY_GRADE.resampling
	});
</script>

<!-- GIBS satellite imagery. The only colour photograph of the ground.

     A second, 128x sharper NAIP layer used to stack on top of this over US
     locations only. At cruise altitude looking toward a horizon, z16 (1.8 m/px)
     is far past what the screen resolves, so it bought nothing but z16 tile
     fetches, a colour mismatch against MODIS, and a US/rest-of-world split in
     the render path. Deleted 2026-08-26 -- with it went `detail`, whose only
     consumer it was, `groundDetailOpacity` and `inNaipCoverage`. -->
<RasterTileSource
	id="gibs"
	tiles={tiles.gibs}
	tileSize={TILE_SIZE}
	maxzoom={TILE_MAXZOOM.gibs}
	attribution={TILE_ATTRIBUTION}
>
	<!-- Explicit layer id (not just the source id): the in-map sky layers
	     (stars, sun/moon) insert `beforeId` this layer, and auto-generated
	     `svmlgl-layer-N` ids are mount-order accidents, not addresses. -->
	<RasterLayer id="gibs-day" paint={{ ...grade, 'raster-opacity': 1.0 }} />
</RasterTileSource>

<!-- SENTINEL-2, the sharp basemap, laid OVER the MODIS wash.

     16x the detail and effectively cloudless, because it is built from a
     per-location scene chosen for <5% cloud rather than whatever the weather
     did on one pinned day. MODIS caps at z9 (306 m/px); this is packed to z13
     (19 m/px). The SENSOR is 10 m, so z14 would be the last honest zoom — z13
     is where the storage budget landed, not a limit of the data. MODIS at
     cruise is a brown smear; this resolves fields, roads and coastline.

     An OVERLAY, not a replacement, and that is the whole design. The pack is a
     box around each location, not a global layer, because fetching eleven
     cities at z8-13 is affordable and fetching the planet is not. Over open
     ocean Sentinel-2 produces no scenes at all. So MODIS stays underneath as
     the everywhere-layer and this covers the ground the window actually spends
     its time over; where it has no tile, the 404 simply reveals the layer below
     instead of punching a hole.

     `minzoom` matters as much as `maxzoom` here: without it MapLibre would
     request z0-z7 tiles that were never packed, which is hundreds of 404s a
     minute for imagery that does not exist. Same trap as the DEM's missing
     zoom range, and the same fix -- declare what the archive actually holds. -->
{#if hasSentinel2}
	<RasterTileSource
		id="sentinel2"
		tiles={tiles.sentinel2}
		tileSize={TILE_SIZE}
		minzoom={SENTINEL2_MINZOOM}
		maxzoom={sentinel2MaxZoom(display.config.place.id)}
	>
		<RasterLayer paint={{ ...grade, 'raster-opacity': 1.0 }} />
	</RasterTileSource>
{/if}
