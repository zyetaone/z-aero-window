<!-- AdminScenePush — one-shot scene sliders + push + result. Markup verbatim. -->
<script lang="ts">
	import type { RestAdminStore } from '$lib/fleet/rest-admin.svelte';
	import type { LocationId, WeatherType } from '$lib/types';
	import { formatAltitudeFt, formatSpeedX, formatTime } from '$lib/utils';
	import { CRUISE_SPEED_DEFAULTS } from '$lib/model/config-tree.svelte';

	let { scene, selectedCount, pushResult, store, onPushFull }: {
		scene: { location: LocationId; weather: WeatherType; altitude: number; timeOfDay: number; flightSpeed: number; syncToRealTime: boolean },
		selectedCount: number,
		pushResult: { ok: number; failed: string[] } | null,
		store: RestAdminStore,
		onPushFull: () => void
	} = $props();

	const altitudeLabel = $derived(formatAltitudeFt(scene.altitude, 0));
	const timeLabel = $derived(formatTime(scene.timeOfDay));
	const speedLabel = $derived(formatSpeedX(scene.flightSpeed));
</script>

			<section class="control-section">
				<h3>Scene — one-shot push</h3>
				<p class="section-caption">
					Overrides location, weather, altitude, and clock on button press. Does not change the ambient time zone above.
				</p>
				<label>
					<div class="slider-header">
						<span>Altitude</span>
						<span class="slider-value">{altitudeLabel}</span>
					</div>
					<input type="range" min="5000" max="48000" step="1000" bind:value={scene.altitude} class="range" />
				</label>
				{#if scene.syncToRealTime}
					<p class="scene-time-note">
						Clock follows Real Time in the ambient zone — manual time is not sent on push.
					</p>
				{:else}
					<label>
						<div class="slider-header">
							<span>Time of Day</span>
							<span class="slider-value">{timeLabel}</span>
						</div>
						<input type="range" min="0" max="24" step="0.25" bind:value={scene.timeOfDay} class="range" />
					</label>
				{/if}
				<label>
					<div class="slider-header">
						<span>Flight Speed</span>
						<span class="slider-value">{speedLabel}</span>
					</div>
					<input
						type="range"
						min={CRUISE_SPEED_DEFAULTS.minSpeed}
						max={CRUISE_SPEED_DEFAULTS.maxSpeed}
						step="0.1"
						bind:value={scene.flightSpeed}
						class="range"
					/>
				</label>
				<label class="toggle-label">
					<input type="checkbox" bind:checked={scene.syncToRealTime} />
					<span>Real Time on push</span>
				</label>
				<button class="btn btn-primary" onclick={onPushFull}>
					Push Scene {selectedCount > 0 ? `(${selectedCount})` : '(All)'}
				</button>
				{#if pushResult}
					<p class="update-result" class:has-failures={pushResult.failed.length > 0}>
						{pushResult.ok} pushed{pushResult.failed.length ? `, ${pushResult.failed.length} failed` : ''}
						{#if store.ackProgress}
							· applied by {store.ackProgress.applied}/{store.ackProgress.total}{store.ackProgress.applied < store.ackProgress.total ? '…' : ''}
						{/if}
						{#if pushResult.failed.length}
							<span class="update-failed">{pushResult.failed.join(' · ')}</span>
						{/if}
					</p>
				{/if}
			</section>
