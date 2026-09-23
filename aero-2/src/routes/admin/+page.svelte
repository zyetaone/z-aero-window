<script lang="ts">
	/**
	 * /admin — Fleet Management, Multi-Screen Remote Control Cockpit & Diagnostics.
	 */
	import { onMount } from 'svelte';
	import {
		PRODUCT_NAME,
		PRODUCT_OWNER,
		ENGINEERED_BY,
		PRODUCT_STAGE,
		PRODUCT_PARTNERS
	} from '#lib/credits.js';
	import { LOCATIONS } from '#lib/settings/locations.js';
	import { SCENE_PRESETS } from '#lib/settings/presets.js';
	import {
		fetchStatus,
		fetchFleet,
		FLEET_ONLINE_WINDOW_MS,
		type KioskStatus,
		type FleetDevice
	} from '#lib/status.js';
	import Wall from '#lib/settings/Wall.svelte';
	import { WallSync } from '#lib/settings/wall.svelte.js';
	import { createWallPoller } from '#lib/settings/wall-poll.js';
	import { PaneSettings } from '#lib/settings/settings.svelte.js';
	import { PUBLIC_WALL_ORIGIN } from '$app/env/public';

	let status = $state<KioskStatus | null>(null);
	let statusError = $state<string | null>(null);
	let activeRole = $state('center');
	let activeMode = $state('flight');
	let activePreset = $state('');
	let copiedLink = $state<string | null>(null);

	/**
	 * The fleet rollup.
	 *
	 * Every layer under this was already built and tested — health-check.sh
	 * scrapes temperature and the throttle bitfield every 60 s, `throttle.ts`
	 * decodes it, `POST /api/fleet/heartbeat` records it per device, and
	 * `summarize()` computes the maxima. Nothing rendered any of it, so the one
	 * page an operator opens showed memory and uptime for the single Pi it
	 * happened to be served from, and nothing at all about the other two.
	 *
	 * `null` means "not fetched yet", `[]` means "fetched, no device has ever
	 * reported" — which is the normal state of a single-Pi install and must not
	 * read as a fault.
	 */
	let fleet = $state<FleetDevice[] | null>(null);
	let fleetError = $state<string | null>(null);

	const origin = $derived(
		typeof window !== 'undefined' ? window.location.origin : 'http://localhost:5173'
	);

	onMount(() => {
		// The empty `.catch(() => {})` this replaces turned an unreachable Pi into
		// a reachable one with blank fields. Say so instead.
		fetchStatus()
			.then((data) => {
				status = data;
				statusError = null;
			})
			.catch((err: unknown) => {
				status = null;
				statusError = err instanceof Error ? err.message : 'unreachable';
			});

		/**
		 * Poll, because heartbeats arrive every 60 s from three devices
		 * independently and a page opened between beats would otherwise show a
		 * stale wall until someone refreshed. 20 s is a third of the beat, so a
		 * device that has just reported shows up promptly without this becoming a
		 * meaningful load on a Pi that is also flying.
		 */
		const load = () =>
			fetchFleet()
				.then((d) => {
					fleet = d;
					fleetError = null;
				})
				.catch((err: unknown) => {
					// Keep the last good list: a dropped poll is not evidence the wall
					// went away, and blanking the table on one failed fetch is how a
					// dashboard trains people to ignore it.
					fleetError = err instanceof Error ? err.message : 'unreachable';
				});
		void load();
		const id = setInterval(load, 20_000);
		return () => clearInterval(id);
	});

	const now = $state({ ms: Date.now() });
	$effect(() => {
		const id = setInterval(() => {
			now.ms = Date.now();
			// Consume due snapshots so "applied version" and the countdown mean
			// the same thing here as on a pane. The config it lands in is this
			// page's throwaway seed, never a display.
			wallSync.applyDue(now.ms / 1000, wallConfig);
		}, 5_000);
		return () => clearInterval(id);
	});

	/**
	 * The Wall tab, here. `Wall.svelte` was written to be mounted from /admin
	 * ("omitted by /admin, which has no display context") and never was, so the
	 * one page an operator opens could launch a preset on one device and could
	 * not change the wall. Same component, same draft-then-push contract, same
	 * poller as a pane: this page follows the wall origin exactly as a pane does,
	 * so the countdown and the applied version are the wall's, not a guess.
	 *
	 * `applyAtWallSec` is epoch seconds (wall-store.ts), so `Date.now() / 1000`
	 * is the right clock for the countdown without a display.
	 */
	const wallConfig = new PaneSettings();
	const wallSync = new WallSync(PUBLIC_WALL_ORIGIN);
	$effect(() => {
		const poller = createWallPoller(wallSync, PUBLIC_WALL_ORIGIN);
		void poller.poll();
		return () => poller.stop();
	});

	/**
	 * Wi-Fi reset — the hatch for a venue whose SSID or password changed.
	 * Resets THIS Pi (the one serving the page), not the fleet: the request
	 * purges its saved Wi-Fi and reboots it into the setup portal, so this page
	 * goes unreachable a couple of seconds after a 200. Token per use, in
	 * memory only, for the same reason as the update token above.
	 */
	let wifiToken = $state('');
	let wifiStatus = $state<string | null>(null);
	let wifiBusy = $state(false);

	async function resetWifi() {
		if (!wifiToken || wifiBusy) return;
		wifiBusy = true;
		wifiStatus = await postWithToken('/api/wifi/reset', wifiToken, 'Wi-Fi reset scheduled.');
		wifiBusy = false;
	}

	/**
	 * One bearer POST for the privileged hatches. The explicit JSON
	 * content-type is load-bearing: SvelteKit's CSRF guard rejects a
	 * same-origin POST whose content-type looks form-like, and this fetch
	 * answered 403 "Cross-site POST forbidden" from INSIDE the admin page
	 * until it was set. Found by driving the real button, not by reading.
	 */
	async function postWithToken(url: string, token: string, okText: string): Promise<string> {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
				body: '{}'
			});
			const body = (await res.json()) as { message?: string; error?: string };
			return res.ok
				? (body.message ?? okText)
				: `${res.status}: ${body.error ?? body.message ?? 'refused'}`;
		} catch (err) {
			return err instanceof Error ? err.message : 'unreachable';
		}
	}

	const isOnline = (d: FleetDevice) => now.ms - d.receivedAtMs < FLEET_ONLINE_WINDOW_MS;

	/**
	 * Rolled up here rather than by calling `?summary`, so the table and the
	 * headline can never disagree — one fetch, one source, and the counts are
	 * derived from the rows the operator is looking at.
	 */
	const roll = $derived.by(() => {
		const all = fleet ?? [];
		const temps = all.map((d) => d.tempC).filter((v): v is number => v !== undefined);
		return {
			total: all.length,
			online: all.filter(isOnline).length,
			maxTempC: temps.length ? Math.max(...temps) : null,
			shedding: all.filter((d) => d.thermalAction === 'shed').length,
			// `=== false` only. A device that did not report its clock is unknown,
			// and an unknown must never be rendered as a fault.
			clockUnsynced: all.filter((d) => d.clockSynced === false).length
		};
	});

	/**
	 * The on-demand OTA trigger.
	 *
	 * The endpoint existed with no UI — an operator pushing a fix had to know
	 * to curl POST /api/update with a bearer token, which on a headless fleet
	 * means "had to read the source". The timer remains the delivery path
	 * (every ~15 min, rollback included); this is the same unit started now.
	 *
	 * The token is asked for PER USE and held in memory only. /admin has no
	 * authentication of its own — AERO_ADMIN_UI is a deployment gate, not an
	 * identity — so persisting the admin token in this page (localStorage, a
	 * cookie) would promote "can see the cockpit" into "can restart the wall".
	 * A field the operator pastes into keeps the credential where it belongs:
	 * with the operator.
	 */
	let updateToken = $state('');
	let updateStatus = $state<string | null>(null);
	let updateBusy = $state(false);

	async function triggerUpdate() {
		if (!updateToken || updateBusy) return;
		updateBusy = true;
		updateStatus = await postWithToken('/api/update', updateToken, 'Update triggered.');
		updateBusy = false;
	}

	const ago = (ms: number) => {
		const s = Math.max(0, Math.round((now.ms - ms) / 1000));
		return s < 90 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
	};

	function copyToClipboard(text: string, label: string) {
		if (typeof navigator !== 'undefined' && navigator.clipboard) {
			navigator.clipboard.writeText(text);
			copiedLink = label;
			setTimeout(() => {
				copiedLink = null;
			}, 2500);
		}
	}
</script>

<svelte:head>
	<title>Admin & Fleet Cockpit — {PRODUCT_NAME}</title>
</svelte:head>

<main class="admin-cockpit">
	<header class="top-bar">
		<div>
			<h1>{PRODUCT_NAME} Cockpit</h1>
			<p class="subtitle">Multi-Screen Fleet Remote Control & System Diagnostics</p>
		</div>
		<div class="header-badges">
			{#if PRODUCT_STAGE}<span class="badge stage">{PRODUCT_STAGE}</span>{/if}
			<span class="badge online">SYSTEM ONLINE</span>
		</div>
	</header>

	<div class="dashboard-grid">
		<!-- Column 1: Multi-Screen Fleet Remote Launcher -->
		<section class="card">
			<h2>🖥️ Multi-Screen Panorama Displays</h2>
			<p class="card-desc">
				Launch continuous 3-screen panoramic windows or solo kiosk instances across local network
				devices.
			</p>

			<div class="display-roles-grid">
				{#each [{ role: 'left', title: 'Left Window Screen', desc: '-30° Yaw Offset Panorama', icon: '◀️' }, { role: 'center', title: 'Center Window Screen', desc: '0° Leader & Flight Director', icon: '⏺️' }, { role: 'right', title: 'Right Window Screen', desc: '+30° Yaw Offset Panorama', icon: '▶️' }, { role: 'solo', title: 'Solo Window Display', desc: 'Standalone Single Kiosk', icon: '🚀' }] as item}
					{@const roleUrl = `${origin}/?role=${item.role}`}
					<div class="role-card" class:active={activeRole === item.role}>
						<div class="role-header">
							<span class="role-icon">{item.icon}</span>
							<div>
								<div class="role-title">{item.title}</div>
								<div class="role-desc">{item.desc}</div>
							</div>
						</div>
						<div class="role-url-box">
							<code>{roleUrl}</code>
						</div>
						<div class="role-actions">
							<a href={roleUrl} target="_blank" rel="noreferrer" class="btn primary"
								>Launch Screen ↗</a
							>
							<button
								type="button"
								class="btn secondary"
								onclick={() => copyToClipboard(roleUrl, item.role)}
							>
								{copiedLink === item.role ? '✓ Copied URL!' : 'Copy URL'}
							</button>
						</div>
					</div>
				{/each}
			</div>

			{#if status?.lanIps && status.lanIps.length > 0}
				<div class="network-interfaces">
					<h3>Local LAN Access IP Addresses:</h3>
					<div class="ip-list">
						<!-- Keyed: this list is refetched every 20 s and interfaces come and
					     go (WiFi associating, a tunnel raising utun). Unkeyed, Svelte
					     patches in place, so a removed interface leaves the row below it
					     wearing the wrong copy-button target. The other `{#each}` blocks
					     on this page iterate module constants and cannot reorder. -->
						{#each status.lanIps as net (net.name + net.address)}
							{@const ipUrl = `http://${net.address}:5173/`}
							<div class="ip-row">
								<span class="iface-name">{net.name}:</span>
								<code>{ipUrl}</code>
								<button
									type="button"
									class="btn xs"
									onclick={() => copyToClipboard(ipUrl, net.address)}
								>
									{copiedLink === net.address ? '✓ Copied' : 'Copy'}
								</button>
							</div>
						{/each}
					</div>
				</div>
			{/if}
		</section>

		<!-- Column 2: Scene Presets & Remote Controls -->
		<section class="card">
			<h2>🎨 Scene Composition Presets</h2>
			<p class="card-desc">
				Open a curated composition on this device. To change the wall, use a pane's Wall tab.
			</p>

			<div class="presets-list">
				{#each SCENE_PRESETS as preset}
					<a
						href="{origin}/?preset={preset.id}"
						target="_blank"
						rel="noreferrer"
						class="preset-card-admin"
					>
						<div class="preset-top">
							<span class="preset-icon">{preset.icon}</span>
							<span class="badge preset-badge">{preset.badge}</span>
						</div>
						<div class="preset-name">{preset.name}</div>
						<div class="preset-desc">{preset.description}</div>
					</a>
				{/each}
			</div>

			<h2 style="margin-top: 24px;">🌍 Global Destinations</h2>
			<div class="destinations-grid">
				{#each LOCATIONS as loc}
					<a href="{origin}/?place={loc.id}" target="_blank" rel="noreferrer" class="dest-btn">
						<span class="dest-name">{loc.name}</span>
						<span class="dest-elev">{loc.groundElevationM}m MSL</span>
					</a>
				{/each}
			</div>
		</section>
	</div>

	<!-- The wall: the one control that reaches every pane at once. -->
	<section class="card telemetry-section">
		<h2>🧭 Wall</h2>
		<p class="card-desc">
			Destination, preset, weather, clock, blind, rotation and media for every pane together. Landed
			on the wall clock, so it applies a few seconds after the push.
			{#if PUBLIC_WALL_ORIGIN}Wall origin: <code>{PUBLIC_WALL_ORIGIN}</code>.{/if}
		</p>
		<Wall config={wallConfig} wall={wallSync} nowSec={() => Date.now() / 1000} />
	</section>

	<!-- Fleet Health — every pane on the wall, not just this one -->
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

			<table class="fleet-table">
				<thead>
					<tr
						><th>Device</th><th>Role</th><th>Temp</th><th>FPS</th><th>Clock</th><th>Last beat</th
						></tr
					>
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

		{#if fleetError}
			<p class="fleet-note warn">Last poll failed: {fleetError} — showing the last known state.</p>
		{/if}

		<!-- On-demand OTA. The timer updates every ~15 min regardless; this is for
		     "I just pushed a fix and want the wall on it now". Same unit, same
		     rollback, same health probe. -->
		<div class="update-row">
			<input
				type="password"
				placeholder="AERO_ADMIN_TOKEN"
				bind:value={updateToken}
				aria-label="Admin token for update trigger"
			/>
			<button
				type="button"
				class="glass-btn"
				disabled={!updateToken || updateBusy}
				onclick={triggerUpdate}
			>
				{updateBusy ? 'Triggering…' : 'Update fleet now'}
			</button>
		</div>
		{#if updateStatus}
			<p class="fleet-note">{updateStatus}</p>
		{/if}
	</section>

	<!-- System Telemetry & Health -->
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

		<!-- Wi-Fi reset for THIS device. Refused (503) until the setup portal is
		     installed, because without it this button is a remote brick. -->
		<div class="update-row">
			<input
				type="password"
				placeholder="AERO_WIFI_RESET_TOKEN"
				bind:value={wifiToken}
				aria-label="Wi-Fi reset token"
			/>
			<button
				type="button"
				class="glass-btn"
				disabled={!wifiToken || wifiBusy}
				onclick={resetWifi}
			>
				{wifiBusy ? 'Resetting…' : 'Reset this device’s Wi-Fi'}
			</button>
		</div>
		<p class="fleet-note">
			Clears saved Wi-Fi on <strong>{status?.hostname ?? 'this device'}</strong> and reboots it
			into the setup portal. This page will go unreachable; reconnect via the portal SSID.
		</p>
		{#if wifiStatus}
			<p class="fleet-note">{wifiStatus}</p>
		{/if}
	</section>

	<footer class="footer">
		<p>{PRODUCT_NAME} &copy; 2026 {PRODUCT_OWNER} · Engineered by {ENGINEERED_BY}.</p>
		<p class="partners">In partnership with {PRODUCT_PARTNERS.join(' · ')}.</p>
		<p><a href="/">← Return to Main Window Display</a> | <a href="/wiki">System Wiki →</a></p>
	</footer>
</main>

<style>
	:global(body) {
		margin: 0;
		background: #090e17;
		color: #e2e8f0;
		font-family:
			system-ui,
			-apple-system,
			sans-serif;
	}
	.admin-cockpit {
		max-width: 1280px;
		margin: 0 auto;
		padding: 32px 24px;
	}
	.top-bar {
		display: flex;
		justify-content: space-between;
		align-items: center;
		border-bottom: 1px solid var(--glass-border-subtle);
		padding-bottom: 24px;
		margin-bottom: 32px;
	}
	h1 {
		font-size: 1.85rem;
		margin: 0 0 6px;
		color: var(--accent-cyan);
		letter-spacing: -0.02em;
	}
	.subtitle {
		margin: 0;
		font-size: 0.95rem;
		color: var(--text-muted);
	}
	.header-badges {
		display: flex;
		gap: 8px;
	}
	.badge {
		font-size: 0.75rem;
		padding: 4px 10px;
		border-radius: 9999px;
		background: rgba(56, 189, 248, 0.1);
		border: 1px solid rgba(56, 189, 248, 0.3);
		color: var(--accent-cyan);
		font-weight: 500;
	}
	.badge.stage {
		background: rgba(245, 158, 11, 0.15);
		border-color: rgba(245, 158, 11, 0.4);
		color: #f59e0b;
	}
	.badge.online {
		background: rgba(34, 197, 94, 0.15);
		border-color: rgba(34, 197, 94, 0.4);
		color: #22c55e;
	}
	.dashboard-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 24px;
		margin-bottom: 24px;
	}
	@media (max-width: 900px) {
		.dashboard-grid {
			grid-template-columns: 1fr;
		}
	}
	.card {
		padding: 24px;
		background: rgba(255, 255, 255, 0.03);
		border: 1px solid var(--glass-border-subtle);
		border-radius: 14px;
		backdrop-filter: blur(12px);
	}
	h2 {
		font-size: 1.25rem;
		margin: 0 0 8px;
		color: var(--text-primary);
	}
	.card-desc {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin: 0 0 20px;
		line-height: 1.4;
	}
	.display-roles-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		margin-bottom: 20px;
	}
	.role-card {
		padding: 14px;
		background: rgba(255, 255, 255, 0.02);
		border: 1px solid var(--glass-bg-subtle);
		border-radius: 10px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.role-header {
		display: flex;
		gap: 10px;
		align-items: center;
	}
	.role-icon {
		font-size: 1.25rem;
	}
	.role-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: #f1f5f9;
	}
	.role-desc {
		font-size: 0.7rem;
		color: var(--text-muted);
	}
	.role-url-box {
		background: rgba(0, 0, 0, 0.3);
		padding: 6px 8px;
		border-radius: 6px;
		overflow: hidden;
	}
	.role-url-box code {
		font-size: 0.7rem;
		color: var(--accent-cyan);
		white-space: nowrap;
	}
	.role-actions {
		display: flex;
		gap: 6px;
	}
	.btn {
		padding: 6px 12px;
		border-radius: 6px;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		transition: all 0.15s ease;
		border: none;
	}
	.btn.primary {
		background: #0284c7;
		color: #ffffff;
	}
	.btn.primary:hover {
		background: #0369a1;
	}
	.btn.secondary {
		background: var(--glass-border-subtle);
		color: #e2e8f0;
		border: 1px solid rgba(255, 255, 255, 0.15);
	}
	.btn.secondary:hover {
		background: rgba(255, 255, 255, 0.15);
	}
	.btn.xs {
		padding: 2px 8px;
		font-size: 0.7rem;
		background: var(--glass-border-subtle);
		color: #e2e8f0;
		border: 1px solid var(--glass-border);
	}
	.network-interfaces {
		border-top: 1px solid var(--glass-border-subtle);
		padding-top: 16px;
	}
	.network-interfaces h3 {
		margin: 0 0 10px;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
	}
	.ip-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.ip-row {
		display: flex;
		align-items: center;
		gap: 8px;
		background: rgba(0, 0, 0, 0.25);
		padding: 6px 10px;
		border-radius: 6px;
		font-size: 0.75rem;
	}
	.iface-name {
		font-weight: 600;
		color: var(--text-muted);
	}
	.ip-row code {
		color: var(--accent-cyan);
		flex: 1;
	}
	.presets-list {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.preset-card-admin {
		padding: 10px;
		background: rgba(255, 255, 255, 0.02);
		border: 1px solid var(--glass-bg-subtle);
		border-radius: 8px;
		text-decoration: none;
		color: inherit;
		display: flex;
		flex-direction: column;
		gap: 4px;
		transition: all 0.15s ease;
	}
	.preset-card-admin:hover {
		background: var(--glass-bg-subtle);
		border-color: rgba(56, 189, 248, 0.4);
		transform: translateY(-1px);
	}
	.preset-top {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.preset-icon {
		font-size: 1.1rem;
	}
	.preset-badge {
		font-size: 0.6rem;
		padding: 1px 6px;
	}
	.preset-name {
		font-size: 0.8rem;
		font-weight: 600;
		color: #f1f5f9;
	}
	.preset-desc {
		font-size: 0.65rem;
		color: var(--text-muted);
		line-height: 1.3;
	}
	.destinations-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 6px;
	}
	.dest-btn {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		border-radius: 6px;
		background: rgba(255, 255, 255, 0.02);
		border: 1px solid var(--glass-bg-subtle);
		text-decoration: none;
		color: inherit;
		font-size: 0.75rem;
		transition: background 0.15s;
	}
	.dest-btn:hover {
		background: var(--glass-bg-subtle);
		border-color: rgba(56, 189, 248, 0.3);
	}
	.dest-name {
		font-weight: 500;
		color: #f1f5f9;
	}
	.dest-elev {
		font-size: 0.65rem;
		color: var(--text-muted);
	}
	.update-row {
		display: flex;
		gap: 8px;
		margin-top: 14px;
	}
	.update-row input {
		flex: 1;
		padding: 6px 10px;
		background: rgba(0, 0, 0, 0.35);
		border: 1px solid var(--glass-border);
		border-radius: 6px;
		color: var(--text-primary);
		font-family: monospace;
		font-size: 0.8rem;
	}
	.update-row button:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.fleet-note {
		font-size: 0.85rem;
		color: var(--text-muted, #94a3b8);
		line-height: 1.5;
	}
	.fleet-table {
		width: 100%;
		border-collapse: collapse;
		margin-top: 16px;
		font-size: 0.85rem;
	}
	.fleet-table th {
		text-align: left;
		font-weight: 600;
		color: var(--text-muted);
		border-bottom: 1px solid var(--glass-border);
		padding: 6px 8px;
	}
	.fleet-table td {
		padding: 6px 8px;
		border-bottom: 1px solid var(--glass-bg-subtle);
		font-variant-numeric: tabular-nums;
	}
	.fleet-table tr.offline {
		opacity: 0.45;
	}
	.chip {
		margin-left: 6px;
		padding: 1px 5px;
		border-radius: 3px;
		background: rgba(245, 158, 11, 0.2);
		color: #f59e0b;
		font-size: 0.7rem;
	}
	.telemetry-section {
		margin-bottom: 32px;
	}
	.telemetry-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 16px;
	}
	.telem-item {
		background: rgba(0, 0, 0, 0.25);
		padding: 12px 16px;
		border-radius: 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.telem-item .label {
		font-size: 0.7rem;
		color: var(--text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.telem-item .val {
		font-size: 1rem;
		font-weight: 600;
		color: #f1f5f9;
	}
	.telem-item .val.green {
		color: #22c55e;
	}
	.footer {
		border-top: 1px solid var(--glass-border-subtle);
		padding-top: 24px;
		color: #64748b;
		font-size: 0.85rem;
		display: flex;
		justify-content: space-between;
		align-items: center;
		flex-wrap: wrap;
		gap: 12px;
	}
	.footer a {
		color: var(--accent-cyan);
		text-decoration: none;
	}
	/* Quieter than the copyright line above it: an install partner is context,
	   not a claim on the product. */
	.footer .partners {
		opacity: 0.72;
	}
	.footer a:hover {
		text-decoration: underline;
	}
</style>
