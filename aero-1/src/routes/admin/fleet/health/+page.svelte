<!--
	Admin fleet health dashboard.

	Renders one tile per device with the most recent heartbeat metrics:
	FPS, CPU temp, uptime, crash count, online/offline state.

	Polls /api/fleet/heartbeat every 5 s. No WebSocket — health data is
	append-only and already has server-side ring-buffer semantics, so
	polling is simpler and degrades gracefully across flaky networks.
-->
<script lang="ts">
	import { onDestroy } from 'svelte';
	import type { HeartbeatSample } from '$lib/server/fleet/heartbeat';
	import type { FleetSummary } from '$lib/fleet/protocol';
	import { formatUptime } from '$lib/utils';
	import { ONLINE_THRESHOLD_MS } from '$lib/fleet/protocol';
	import { subscribeWallClock, wallClockNow } from '$lib/shell/passenger/wall-clock.svelte';

	// $state.raw — samples is replaced wholesale on each poll response,
	// never mutated in place. Skip the per-element proxy traversal.
	let samples = $state.raw<HeartbeatSample[]>([]);
	let summary = $state<FleetSummary>({
		total: 0, online: 0, offline: 0, avgFps: 0, maxTempC: 0, totalCrashes: 0,
		shedding: 0, throttledLive: 0,
	});
	let error = $state<string | null>(null);
	// False until the first successful poll — summary shows '—' instead of
	// misleading zeros while connecting, and the empty state stays quiet.
	let loaded = $state(false);

	async function poll() {
		try {
			const [devs, sum] = await Promise.all([
				fetch('/api/fleet/heartbeat').then((r) => r.json()),
				fetch('/api/fleet/heartbeat?summary').then((r) => r.json()),
			]);
			samples = devs as HeartbeatSample[];
			summary = sum as FleetSummary;
			error = null;
			loaded = true;
		} catch (e) {
			error = (e as Error).message;
		}
	}

	poll();
	const interval = setInterval(poll, 5_000);
	onDestroy(() => clearInterval(interval));

	// Ages must read the SHARED wall clock, not this page's own Date.now():
	// a pane whose clock is minutes off would compute its own ages from its
	// own idea of now, and the fleet view would disagree with every pane's
	// telemetry about whether a device is alive. Same reason the device grid
	// subscribes — f7c55f59 converted that page and missed this sibling.
	// Without this the "N s ago" text only re-evaluates on the 5 s poll, so
	// it also advances in 5 s steps and a device can read as online for up to
	// 5 s after it drops.
	$effect(() => subscribeWallClock());

	function isOnline(s: HeartbeatSample): boolean {
		return wallClockNow() - s.receivedAt < ONLINE_THRESHOLD_MS;
	}

	function tempColor(c: number): string {
		if (c >= 80) return 'var(--error)';
		if (c >= 70) return 'var(--warn)';
		return 'var(--ok)';
	}

	function fpsColor(fps: number): string {
		if (fps === 0) return 'var(--no-data)';
		if (fps < 55) return 'var(--warn)';
		return 'var(--ok)';
	}

	function throttleLabel(s: HeartbeatSample): string | null {
		if (s.thermalAction === 'shed') return 'SHEDding';
		if (s.throttle?.livePressure) {
			const bits: string[] = [];
			if (s.throttle.underVoltage) bits.push('UV');
			if (s.throttle.freqCapped) bits.push('cap');
			if (s.throttle.throttled) bits.push('throt');
			if (s.throttle.softTempLimit) bits.push('softT');
			return bits.join('+') || 'live';
		}
		if (s.throttle?.throttledOccurred || s.throttle?.underVoltageOccurred) return 'had throttle';
		return null;
	}
</script>

<svelte:head>
	<title>Fleet Health · Aero Window</title>
</svelte:head>

<div class="page">
	<header>
		<h1>Fleet health</h1>
		<nav><a href="/admin">← Admin</a></nav>
	</header>

	{#if error}
		<p class="err">Error fetching heartbeats: {error}</p>
	{/if}

	<section class="summary">
		<div class="stat"><strong>{loaded ? summary.online : '—'}</strong> / {loaded ? summary.total : '—'} online</div>
		<div class="stat"><strong>{loaded ? summary.offline : '—'}</strong> offline</div>
		<div class="stat"><strong>{loaded ? summary.avgFps.toFixed(1) : '—'}</strong> avg fps</div>
		<div class="stat"><strong>{loaded ? `${summary.maxTempC}°C` : '—'}</strong> max</div>
		<div class="stat"><strong>{loaded ? summary.totalCrashes : '—'}</strong> kiosk restarts</div>
		<div class="stat" class:warn-stat={(summary.throttledLive ?? 0) > 0 || (summary.shedding ?? 0) > 0}>
			<strong>{loaded ? (summary.shedding ?? 0) : '—'}</strong> shedding
		</div>
		<div class="stat" class:warn-stat={(summary.maxClockSkewMs ?? 0) > 1000}>
			<strong>{loaded && summary.maxClockSkewMs !== undefined ? `${summary.maxClockSkewMs} ms` : '—'}</strong> clock skew
		</div>
		<div class="stat" class:warn-stat={(summary.throttledLive ?? 0) > 0}>
			<strong>{loaded ? (summary.throttledLive ?? 0) : '—'}</strong> throttle live
		</div>
	</section>

	<section class="tiles">
		{#each samples as s (s.deviceId)}
			<article class={['tile', !isOnline(s) && 'offline']}>
				<header>
					<span class={['status-dot', isOnline(s) && 'online']}></span>
					<span class="id">{s.deviceId}</span>
					<span class="role">{s.role} · {s.groupId}</span>
					{#if s.commit}<span class="commit" title="running commit">{s.commit}</span>{/if}
				</header>
				<dl>
					<div><dt>FPS</dt><dd style:color={fpsColor(s.fps)}>{s.fps.toFixed(0)}</dd></div>
					<div><dt>Temp</dt><dd style:color={tempColor(s.temp)}>{s.temp}°C</dd></div>
					<div><dt>Uptime</dt><dd>{s.uptime > 0 ? formatUptime(s.uptime) : '—'}</dd></div>
					<div><dt>Restarts</dt><dd title="aero-kiosk.service NRestarts since boot — includes the updater's per-release restart">{s.crashCount}</dd></div>
					<div>
						<dt>Mode</dt>
						<dd class={s.mode && s.mode !== 'flight' ? 'mode-media' : undefined}>
							{s.mode === 'screensaver' ? 'Slideshow' : s.mode === 'video' ? 'Video' : s.mode === 'flight' ? 'Flight' : (s.mode ?? '—')}
						</dd>
					</div>
					{#if throttleLabel(s)}
						<div class="full">
							<dt>Thermal</dt>
							<dd
								class={s.thermalAction === 'shed' || s.throttle?.livePressure ? 'thermal-hot' : 'thermal-hist'}
								title={s.throttledRaw != null ? `throttled=0x${s.throttledRaw.toString(16)}` : undefined}
							>
								{throttleLabel(s)}
							</dd>
						</div>
					{/if}
				</dl>
				<footer>
					last heartbeat {Math.round((wallClockNow() - s.receivedAt) / 1000)}s ago
				</footer>
			</article>
		{:else}
			{#if loaded}
				<p class="empty">No heartbeats received yet. Pi devices need AERO_ADMIN_URL set.</p>
			{:else}
				<p class="empty">Connecting…</p>
			{/if}
		{/each}
	</section>
</div>

<style>
	:global(body) {
		margin: 0;
		background: var(--bg-base);
	}
	.page {
		max-width: 1200px;
		margin: 0 auto;
		padding: 2rem;
		font: 14px/1.5 system-ui, sans-serif;
		color: #e5e7eb;
		background: var(--bg-base);
		min-height: 100vh;
	}
	header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
	header h1 { font-size: 1.5rem; margin: 0; }
	header a { color: #60a5fa; text-decoration: none; }
	header a:hover { text-decoration: underline; }
	.err { background: #7f1d1d; padding: 0.75rem; border-radius: 8px; }
	.summary {
		display: flex;
		gap: 1.5rem;
		padding: 1rem 1.25rem;
		background: var(--bg-surface);
		border: 1px solid var(--border);
		border-radius: 8px;
		margin-bottom: 1.5rem;
	}
	.stat strong { font-size: 1.25rem; color: #fff; }
	.stat.warn-stat strong { color: var(--warn); }
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
		gap: 1rem;
	}
	.tile {
		background: var(--bg-surface);
		border-radius: 8px;
		padding: 1rem;
		border: 1px solid var(--border);
	}
	.tile.offline { border-color: var(--error); opacity: 0.6; }
	.tile header {
		display: flex;
		justify-content: flex-start;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 0.75rem;
	}
	.status-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--error);
		flex-shrink: 0;
	}
	.status-dot.online { background: var(--ok); }
	.id { font-weight: 600; }
	.role { font-size: 0.8rem; color: #9ca3af; }
	.commit {
		margin-left: auto;
		font-family: ui-monospace, monospace;
		font-size: 0.7rem;
		color: #94a3b8;
		background: rgba(148, 163, 184, 0.12);
		padding: 0.1rem 0.35rem;
		border-radius: 4px;
	}
	dl { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin: 0; }
	dl > div { display: flex; justify-content: space-between; }
	dl > div.full { grid-column: 1 / -1; }
	dt { color: #9ca3af; }
	dd { margin: 0; font-weight: 600; }
	dd.mode-media { color: #93c5fd; }
	dd.thermal-hot { color: var(--error); letter-spacing: 0.04em; }
	dd.thermal-hist { color: var(--warn); font-weight: 500; }
	.tile footer { font-size: 0.75rem; color: var(--no-data); margin-top: 0.75rem; }
	.empty { color: #9ca3af; grid-column: 1 / -1; text-align: center; padding: 2rem; }
</style>
