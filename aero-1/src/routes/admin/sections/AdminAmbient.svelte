<!-- AdminAmbient — live-tuning panels + ambient fan-out failures. Verbatim from +page. -->
<script lang="ts">
	import { getAmbientSyncFailures, clearAmbientSyncFailures } from '$lib/fleet/peer-sync.svelte';
	import { LOCATIONS } from '$content/locations';
	import AtmosphereControls from '$lib/shell/operator/panel/AtmosphereControls.svelte';
	import AudioControls from '$lib/shell/operator/panel/AudioControls.svelte';
	import FlightControls from '$lib/shell/operator/panel/FlightControls.svelte';
	import LightingControls from '$lib/shell/operator/panel/LightingControls.svelte';
	import TimeControl from '$lib/shell/operator/panel/TimeControl.svelte';
	import { wallClockNow } from '$lib/shell/passenger/wall-clock.svelte';
	import { formatAge } from '$lib/utils';
	import type { LocationId, WeatherType } from '$lib/types';

	let { scene }: { scene: { location: LocationId; weather: WeatherType; altitude: number; timeOfDay: number; flightSpeed: number; syncToRealTime: boolean } } = $props();

	const ambientFailures = $derived(getAmbientSyncFailures());
	const sceneLocationZone = $derived(
		LOCATIONS.find((l) => l.id === scene.location)?.timeZone ?? '',
	);
	const sceneLocationUtcOffset = $derived(
		LOCATIONS.find((l) => l.id === scene.location)?.utcOffset,
	);

	/** Compact relative age for the ambient-failure list ("45s ago"). */
	function relativeAgo(at: number): string {
		return formatAge(at, wallClockNow());
	}
</script>

			<section class="control-section">
				<h3>
					Ambient <span class="hint-muted">— auto-syncs to fleet</span>
				</h3>
				<p class="section-caption">
					Live tuning — changes fan out immediately. Time zone follows the depicted city unless overridden below.
				</p>
				<!-- Same dual-tree panels as kiosk SidePanel. FlightControls
				     shows night-lit only (no AeroWindow → no speed/alt sliders).
				     usePanelConfig → applyConfigPatch; peer-sync fans out. -->
				<FlightControls />
				<TimeControl locationZone={sceneLocationZone} locationUtcOffset={sceneLocationUtcOffset} />
				<AtmosphereControls />
				<LightingControls />
				<AudioControls />
				{#if ambientFailures.length > 0}
					<p class="update-result has-failures">
						{ambientFailures.length} ambient sync {ambientFailures.length === 1 ? 'failure' : 'failures'}
						<button
							class="btn-x ambient-dismiss"
							aria-label="Dismiss ambient sync failures"
							title="Dismiss"
							onclick={clearAmbientSyncFailures}
						>×</button>
						<span class="update-failed">
							{#each ambientFailures as f}
								{f.deviceId} · {f.path} · {relativeAgo(f.at)}<br />
							{/each}
						</span>
					</p>
				{/if}
			</section>
