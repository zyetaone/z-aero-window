<!-- AdminScenePicker — Location + Weather draft + Fly There. Verbatim from +page. -->
<script lang="ts">
	import { LOCATIONS } from '$content/locations';
	import { WEATHER_TYPES } from '$lib/types';
	import type { LocationId, WeatherType } from '$lib/types';

	let {
		scene,
		sceneDirty = $bindable(),
		selectedCount,
		onPushScene
	}: {
		scene: { location: LocationId; weather: WeatherType; altitude: number; timeOfDay: number; flightSpeed: number; syncToRealTime: boolean },
		sceneDirty: boolean,
		selectedCount: number,
		onPushScene: () => void
	} = $props();

</script>

			<section class="control-section">
				<h3>Location + Weather</h3>
				<label>
					<span>Location</span>
					<select bind:value={scene.location} onchange={() => (sceneDirty = true)}>
						{#each LOCATIONS as loc (loc.id)}
							<option value={loc.id}>{loc.name}</option>
						{/each}
					</select>
				</label>
				<label>
					<span>Weather</span>
					<select bind:value={scene.weather} onchange={() => (sceneDirty = true)}>
						{#each WEATHER_TYPES as w (w)}
							<option value={w}>{w[0].toUpperCase() + w.slice(1)}</option>
						{/each}
					</select>
				</label>
				<button class="btn btn-secondary" onclick={onPushScene}>
					Fly There {selectedCount > 0 ? `(${selectedCount})` : '(All)'}
				</button>
			</section>
