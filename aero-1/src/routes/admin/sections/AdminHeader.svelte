<!-- AdminHeader — dashboard header + fleet health. Verbatim from +page. -->
<script lang="ts">
	import type { RestAdminStore } from '$lib/fleet/rest-admin.svelte';
	import { PRODUCT_STAGE } from '$lib/credits';
	import { subscribeWallClock, wallClockNow, formatClock } from '$lib/shell/passenger/wall-clock.svelte';

	let { store }: { store: RestAdminStore } = $props();

	$effect(() => subscribeWallClock());
	const clockDisplay = $derived(formatClock(wallClockNow(), true));
	const fpsBadge = $derived(
		store.fleetHealth.avgFps > 0 ? `${store.fleetHealth.avgFps.toFixed(0)} fps` : '— fps'
	);
</script>

	<!-- Header -->
	<header class="header">
		<div class="header-left">
			<h1>Aero Admin</h1>
			{#if PRODUCT_STAGE}<span class="stage-badge">{PRODUCT_STAGE}</span>{/if}
			<span class="subtitle">Fleet Management</span>
		</div>
		<div class="header-right">
			<span
				class="fps-badge"
				class:good={store.fleetHealth.avgFps >= 30}
				class:warn={store.fleetHealth.avgFps > 0 && store.fleetHealth.avgFps < 30}
			>{fpsBadge}</span>
			<span class="clock-display">{clockDisplay}</span>
			<span class={['connection-badge', store.connectionState === 'connected' && 'online']}>
				{store.connectionState === 'connected' ? 'REST' : store.connectionState}
			</span>
		</div>
	</header>

	{#if store.fleetHealth.total > 0 || store.alerts.length > 0}
		<div class="health-bar">
			<div class="health-stats">
				<span class="health-stat"><span class="health-dot online"></span>{store.fleetHealth.online} online</span>
				<span class="health-stat"><span class="health-dot offline"></span>{store.fleetHealth.offline} offline</span>
				<span class="health-stat">Avg FPS: <strong>{store.fleetHealth.avgFps}</strong></span>
			</div>
			{#if store.alerts.length > 0}
				<div class="alerts">
					{#each store.alerts as alert (alert.device + '|' + alert.message)}
						<span class={['alert-badge', alert.level === 'error' && 'error', alert.level === 'warning' && 'warning']}>
							{alert.message}
						</span>
					{/each}
				</div>
			{/if}
		</div>
	{/if}
