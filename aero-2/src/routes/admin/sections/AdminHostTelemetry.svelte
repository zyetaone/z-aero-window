<script lang="ts">
	import type { KioskStatus } from '#lib/status.js';

	let {
		status,
		statusError
	}: {
		status: KioskStatus | null;
		statusError: string | null;
	} = $props();
</script>

<section class="card telemetry-section">
	<h2>⚡ Host Telemetry & Device Health</h2>
	<div class="telemetry-grid">
		<div class="telem-item">
			<span class="label">System Status</span>
			<!-- Reflects the probe, not a constant: a dashboard that always says
			     HEALTHY is decoration, not telemetry. -->
			<span class="val" class:green={status?.online} class:warn={!status || !status.online}>
				{#if statusError}UNREACHABLE — {statusError}{:else if status}{status.online
						? 'HEALTHY'
						: 'DEGRADED'}{:else}CONNECTING…{/if}
			</span>
		</div>
		<div class="telem-item">
			<span class="label">Host</span>
			<span class="val">{status?.hostname ?? 'unknown'}</span>
		</div>
		<div class="telem-item">
			<span class="label">Memory (used / total)</span>
			<span class="val"
				>{status ? Math.round((status.totalMemBytes - status.freeMemBytes) / 1048576) : 0} MB / {status
					? Math.round(status.totalMemBytes / 1048576)
					: 0} MB</span
			>
		</div>
		<div class="telem-item">
			<span class="label">Uptime</span>
			<span class="val">{Math.round((status?.uptimeSec ?? 0) / 60)} minutes</span>
		</div>
	</div>
</section>
