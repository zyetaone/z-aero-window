<script lang="ts">
	/**
	 * Buildings — 3D Vector Building Extrusions from OpenStreetMap GeoJSON datasets.
	 *
	 * Renders realistic city skyscrapers with height-based 3D extrusions,
	 * solar daytime architectural shading, and evening glowing window illumination.
	 */
	import { GeoJSONSource, FillExtrusionLayer, LineLayer } from 'svelte-maplibre-gl';
	import type { ExpressionSpecification } from 'maplibre-gl';
	import { useDisplay } from '../display.svelte.js';
	import { cssRgb, lerpRgb, type Rgb } from './atmosphere.js';

	const display = useDisplay();

	const place = $derived(display.config.place);
	const night = $derived(display.night);
	const aglM = $derived(display.view.aglM);
	const isPerf = $derived(display.config.qualityMode === 'performance');

	// Fade out buildings when climbing into the upper stratosphere (> 7,500m)
	const altitudeFade = $derived(Math.max(0, Math.min(1, (8000 - aglM) / 2500)));

	// Dynamic building color transitioning from day concrete to night illuminated facade.
	// Night is warm lamp-amber, not cyan: the old `#38bdf8` fought the amber
	// street grid and VIIRS glow underneath. Paired with the vertical gradient
	// below, rooftops catch the light and bases fall off — lit profiles rather
	// than flat slabs.
	//
	// Full night is BAKED per building, not flat: tools/stamp-building-glow
	// stamps each feature's `night` hex from its height (towers read lit,
	// sheds read ember) dimmed by distance from the lit core, so downtown
	// glows and the rural rim stays dark instead of glowing like the city.
	// A fill layer has no per-pixel shader to hash — the February
	// emissive-lights lesson (variance, not uniform amber) lives in the
	// data. Fallback keeps the old uniform amber for unstamped packs.
	const DAY_COLOR: Rgb = [0.82, 0.84, 0.86];
	const SUNSET_COLOR: Rgb = [0.96, 0.62, 0.04];

	const buildingColor: string | ExpressionSpecification = $derived.by(() => {
		if (night < 0.2) return cssRgb(DAY_COLOR);
		if (night < 0.6) {
			const t = (night - 0.2) / 0.4;
			return cssRgb(lerpRgb(DAY_COLOR, SUNSET_COLOR, t));
		}
		return ['coalesce', ['get', 'night'], '#ffc98a'] as ExpressionSpecification;
	});
	/**
	 * Footprint outline glow: lit block edges for the pass-through.
	 *
	 * The slabs read from directly above, but on a low approach through the
	 * city the towers are dark shapes against dark ground — nothing catches
	 * the eye as the window threads between them. A LineLayer over the same
	 * polygon source strokes every footprint: from altitude the strokes merge
	 * into the lit grid, and down low each tower gets a glowing base that
	 * separates it from its neighbour. Arrives with the amber slabs (same
	 * night gate) and thins with the same altitude fade, so a climbing
	 * window never leaves outlines floating over an empty grid.
	 */
	const outlineOpacity = $derived(
		isPerf ? 0 : Math.max(0, Math.min(1, (night - 0.5) / 0.3)) * altitudeFade * 0.55
	);
</script>

{#if !place.isFeature}
	<GeoJSONSource id="city-buildings" data="/api/buildings/{place.id}">
		<FillExtrusionLayer
			layout={{
				visibility: altitudeFade > 0.005 ? 'visible' : 'none'
			}}
			paint={{
				'fill-extrusion-color': buildingColor,
				'fill-extrusion-height': ['coalesce', ['get', 'height'], 20],
				'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
				// Fully opaque: a building is the mask its neighbours' lights
				// need. At 0.85 the VIIRS halo and the road bloom behind a
				// tower bled through its faces — streetlight shining through
				// concrete. The altitude fade still thins the whole city with
				// height; it just no longer makes walls translucent.
				'fill-extrusion-opacity': altitudeFade,
				// Lit rooftops, dark street-level bases: the gradient shades
				// facades top-to-bottom so towers read as profiles at night
				// instead of extruded slabs. Day impact is nil (flat light).
				'fill-extrusion-vertical-gradient': true
			}}
		/>
		<LineLayer
			id="city-buildings-outline"
			layout={{
				visibility: outlineOpacity > 0.01 ? 'visible' : 'none'
			}}
			paint={{
				'line-color': '#ffd9a0',
				'line-width': 1,
				'line-blur': 0.5,
				'line-opacity': outlineOpacity
			}}
		/>
	</GeoJSONSource>
{/if}
