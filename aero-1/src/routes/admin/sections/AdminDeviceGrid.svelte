<!-- AdminDeviceGrid — device cards + temps poll. Markup verbatim. -->
<script lang="ts">
	import type { RestAdminStore } from '$lib/fleet/rest-admin.svelte';
	import { LOCATIONS } from '$content/locations';
	import { formatUptime, formatAge } from '$lib/utils';
	import { DISPLAY_MODE_LABELS, type DisplayMode } from '$lib/types';

	let { store, selectedDevices, onToggleSelectAll, onToggleDevice }: {
		store: RestAdminStore,
		selectedDevices: Set<string>,
		onToggleSelectAll: () => void,
		onToggleDevice: (id: string) => void
	} = $props();

	let deviceTemps = $state<Record<string, number>>({});
	$effect(() => {
		const poll = async () => {
			try {
				const res = await fetch('/api/fleet/heartbeat?summary');
				if (!res.ok) return;
				const data = await res.json();
				if (data.devices) {
					const temps: Record<string, number> = {};
					for (const d of data.devices) {
						if (d.deviceId && d.temp != null) temps[d.deviceId] = d.temp;
					}
					deviceTemps = temps;
				}
			} catch { /* heartbeat endpoint may not be available */ }
		};
		poll();
		const timer = setInterval(poll, 30000);
		return () => clearInterval(timer);
	});

	function formatDeviceMode(mode: string | undefined): string {
		if (!mode) return '—';
		return DISPLAY_MODE_LABELS[mode as DisplayMode]?.short ?? mode;
	}
</script>

		<!-- Device Grid -->
		<main class="grid-area">
			{#if store.devices.length === 0}
				<div class="empty-state">
					<p class="empty-title">No devices registered</p>
					<p class="empty-desc">
						{store.connectionState === 'connected'
							? 'Start a display instance — it will auto-register here.'
							: 'Waiting for server connection...'}
					</p>
				</div>
			{:else}
				<div class="grid-toolbar">
					<button class="btn btn-outline" onclick={onToggleSelectAll}>
						{selectedDevices.size === store.devices.length && store.devices.length > 0
							? 'Deselect All'
							: 'Select All'}
					</button>
				</div>
				<div class="device-grid">
					{#each store.devices as device (device.deviceId)}
						{@const selected = selectedDevices.has(device.deviceId)}
						<button
							class={['device-card', device.online ? 'online' : 'offline', selected && 'selected']}
							onclick={() => onToggleDevice(device.deviceId)}
						>
							<div class="card-header">
								<span class={['status-dot', device.online && 'online']}></span>
								<span class="hostname">{device.hostname || device.deviceId.slice(0, 8)}</span>
								{#if device.commit}
									<span class="commit-chip" title="running commit">{device.commit}</span>
								{/if}
							</div>

							<div class="card-body">
								<div class="stat">
									<span class="stat-label">Location</span>
									<span class="stat-value">{LOCATIONS.find((l) => l.id === device.currentLocation)?.name || device.currentLocation || '—'}</span>
								</div>
								<div class="stat">
									<span class="stat-label">Temp</span>
									<span class="stat-value">{deviceTemps[device.deviceId] != null ? `${deviceTemps[device.deviceId].toFixed(0)}°C` : '—'}</span>
								</div>
								<div class="stat">
									<span class="stat-label">Mode</span>
									<span
										class={[
											'stat-value',
											'mode-chip',
											device.currentMode && device.currentMode !== 'flight' && 'mode-media',
										]}
									>
										{formatDeviceMode(device.currentMode)}
									</span>
								</div>
								<div class="stat-row">
									<div class="stat">
										<span class="stat-label">FPS</span>
										<span class={['stat-value', device.fps < 30 ? 'fps-warn' : 'fps-good']}>
											{device.fps > 0 ? device.fps.toFixed(0) : '—'}
										</span>
									</div>
									<div class="stat">
										<span class="stat-label">Uptime</span>
										<span class="stat-value">{device.uptime > 0 ? formatUptime(device.uptime) : '—'}</span>
									</div>
								</div>
							</div>

							{#if device.errorCount}
								<div class="error-strip" title={device.lastErrors?.join('\n') ?? ''}>
									⚠ {device.errorCount} error{device.errorCount === 1 ? '' : 's'}
									{#if device.lastErrors?.length}
										<span class="error-last">· {device.lastErrors[device.lastErrors.length - 1]}</span>
									{/if}
								</div>
							{/if}

							<div class="card-footer">
								<span class="last-seen">
									{device.online ? 'Active' : `Last: ${formatAge(device.lastSeen, Date.now())}`}
								</span>
								{#if selected}
									<span class="selected-badge">Selected</span>
								{/if}
							</div>
						</button>
					{/each}
				</div>
			{/if}
		</main>
