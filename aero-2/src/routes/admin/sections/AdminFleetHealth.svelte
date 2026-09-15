<script lang="ts">
	import { FLEET_ONLINE_WINDOW_MS, type FleetDevice } from '#lib/status.js';
	import AdminSoftware from './AdminSoftware.svelte';

	let {
		fleet,
		fleetError,
		roll,
		nowMs
	}: {
		fleet: FleetDevice[] | null;
		fleetError: string | null;
		roll: {
			total: number;
			online: number;
			maxTempC: number | null;
			shedding: number;
			clockUnsynced: number;
		};
		nowMs: number;
	} = $props();

	const isOnline = (d: FleetDevice) => nowMs - d.receivedAtMs < FLEET_ONLINE_WINDOW_MS;

	const ago = (ms: number) => {
		const s = Math.max(0, Math.round((nowMs - ms) / 1000));
		return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
	};
</script>

<section class="card telemetry-section">
	<h2>🌡️ Fleet Health</h2>

	{#if fleet === null && !fleetError}
		<p class="fleet-note">Loading…</p>
	{:else if fleet !== null && fleet.length === 0}
		<!-- The normal state of a single-Pi install. Said out loud, because an
		     empty table and a broken endpoint look identical otherwise. -->
		<p class="fleet-note">
			No device has reported a heartbeat. That is expected on a standalone kiosk —
			<code>health-check.sh</code> posts every 60 s once a fleet token is provisioned.
		</p>
	{:else}
		<div class="telemetry-grid">
			<div class="telem-item">
				<span class="label">Panes online</span>
				<span
					class="val"
					class:green={roll.online === roll.total}
					class:warn={roll.online < roll.total}
				>
					{roll.online} / {roll.total}
				</span>
			</div>
			<div class="telem-item">
				<span class="label">Hottest pane</span>
				<span class="val" class:warn={(roll.maxTempC ?? 0) >= 78}>
					{roll.maxTempC === null ? '—' : `${Math.round(roll.maxTempC)} °C`}
				</span>
			</div>
			<div class="telem-item">
				<span class="label">Shedding GPU work</span>
				<span class="val" class:warn={roll.shedding > 0}>{roll.shedding}</span>
			</div>
			<div class="telem-item">
				<!-- The one field here that is about CORRECTNESS, not health. The
				     whole panorama is a function of the wall clock, so an unsynced
				     pane flies a different part of the orbit and lights a different
				     time of day while every other number on this page reads green. -->
				<span class="label">Clock unsynced</span>
				<span class="val" class:warn={roll.clockUnsynced > 0}>{roll.clockUnsynced}</span>
			</div>
		</div>

		{#if fleet}
			<table class="fleet-table">
				<thead>
					<tr>
						<th>Device</th>
						<th>Role</th>
						<th>Temp</th>
						<th>FPS</th>
						<th>Clock</th>
						<th>Last beat</th>
					</tr>
				</thead>
				<tbody>
					{#each fleet as d (d.deviceId)}
						<tr class:offline={!isOnline(d)}>
							<td>{d.deviceId}</td>
							<td>{d.role}</td>
							<td class:warn={(d.tempC ?? 0) >= 78}>
								{d.tempC === undefined ? '—' : `${Math.round(d.tempC)}°`}
								{#if d.thermalAction === 'shed'}<span class="chip">SHED</span>{/if}
							</td>
							<td>{d.fps === undefined ? '—' : Math.round(d.fps)}</td>
							<td class:warn={d.clockSynced === false}>
								{d.clockSynced === false ? 'DRIFT' : d.clockSynced === true ? 'ok' : '—'}
							</td>
							<td>{isOnline(d) ? ago(d.receivedAtMs) : `offline · ${ago(d.receivedAtMs)}`}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	{/if}

	{#if fleetError}
		<p class="fleet-note warn">Last poll failed: {fleetError} — showing the last known state.</p>
	{/if}

	<AdminSoftware />
</section>
