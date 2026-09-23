<script lang="ts">
	/**
	 * Buildings — 3D Vector Building Extrusions from OpenStreetMap GeoJSON datasets.
	 *
	 * Renders realistic city skyscrapers with height-based 3D extrusions,
	 * solar daytime architectural shading, and evening glowing window illumination.
	 */
	import { GeoJSONSource, FillExtrusionLayer } from 'svelte-maplibre-gl';
	import { useDisplay } from '../display.svelte.js';

	const display = useDisplay();

	const place = $derived(display.config.place);
	const night = $derived(display.night);
	const aglM = $derived(display.view.aglM);

	// Fade out buildings when climbing into the upper stratosphere (> 7,500m)
	const altitudeFade = $derived(Math.round(Math.max(0, Math.min(1, (8000 - aglM) / 2500)) * 100) / 100);

	// Dynamic building color transitioning from day concrete to night illuminated facade
	const buildingColor = $derived.by(() => {
		if (night < 0.2) return '#d1d5db'; // Daylight architectural limestone
		if (night < 0.6) return '#f59e0b'; // Sunset golden hour reflection
		return '#38bdf8'; // Night skyglow and illuminated office window luminescence
	});
</script>

<!-- Gated on the place only. Mounting on altitude re-fetched and re-parsed the
     city on the main thread four times an hour (Roads.svelte says why);
     fill-extrusion-opacity 0 skips the draw for free. -->
{#if !place.isFeature}
	<GeoJSONSource id="city-buildings" data="/api/buildings/{place.id}">
		<FillExtrusionLayer
			paint={{
				'fill-extrusion-color': buildingColor,
				'fill-extrusion-height': ['coalesce', ['get', 'height'], 20],
				'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0],
				'fill-extrusion-opacity': 0.85 * altitudeFade
			}}
		/>
	</GeoJSONSource>
{/if}
