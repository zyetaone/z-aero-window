<script lang="ts">
	/**
	 * /admin — Fleet Management, Multi-Screen Remote Control Cockpit & Diagnostics.
	 */
	import { onMount } from 'svelte';
	import { PRODUCT_NAME, PRODUCT_OWNER, ENGINEERED_BY, PRODUCT_PARTNERS } from '#lib/credits.js';
	import {
		fetchStatus,
		fetchFleet,
		rollUpFleet,
		type KioskStatus,
		type FleetDevice
	} from '#lib/status.js';
	import { PUBLIC_WALL_ORIGIN } from '$app/env/public';
	import Wall from '#lib/settings/Wall.svelte';
	import { createSettings } from '#lib/settings/settings.svelte.js';
	import { WallSync } from '#lib/settings/wall.svelte.js';
	import { createWallPoller } from '#lib/settings/wall-poll.js';
	import './admin.css';
	import AdminHeader from './sections/AdminHeader.svelte';
	import AdminPanoramaLaunch from './sections/AdminPanoramaLaunch.svelte';
	import AdminPresets from './sections/AdminPresets.svelte';
	import AdminFleetHealth from './sections/AdminFleetHealth.svelte';
	import AdminHostTelemetry from './sections/AdminHostTelemetry.svelte';

	let status = $state<KioskStatus | null>(null);
	let statusError = $state<string | null>(null);
	let activeRole = $state('center');
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

	/**
	 * A wall channel of this page's own.
	 *
	 * /admin renders no scene, so there is no `display` context to borrow one
	 * from. Polling the same origin the panes poll is what makes the pending
	 * countdown here mean the same thing it means on a pane — and the origin is
	 * also what `WallSync` uses to resolve media URLs, so a track uploaded to
	 * the writer resolves identically in both places.
	 */
	const wallConfig = createSettings();
	const wallSync = new WallSync(PUBLIC_WALL_ORIGIN);
	onMount(() => {
		const poller = createWallPoller(wallSync, PUBLIC_WALL_ORIGIN);
		// Poll once now rather than one interval from now, same as a pane does:
		// a page opened after a push should show the countdown, not miss it.
		void poller.poll();
		return () => poller.stop();
	});

	const now = $state({ ms: Date.now() });
	$effect(() => {
		const id = setInterval(() => (now.ms = Date.now()), 5_000);
		return () => clearInterval(id);
	});

	/**
	 * Rolled up from the rows already fetched rather than by calling `?summary`,
	 * so the table and the headline cannot disagree. That part was right and is
	 * unchanged; what was wrong was doing the ARITHMETIC here.
	 *
	 * This page had its own copy, and the copy had drifted: it took `maxTempC`
	 * and `shedding` over EVERY device, so a Pi that dropped off the wall hours
	 * ago kept contributing its last-known temperature to the headline number —
	 * a wall reading 81 °C when the only hot device has been dark since lunch.
	 * `rollUpFleet` counts live devices only, which is the same rule
	 * `/api/fleet?summary` answers with, and adds the fps average this page
	 * never had.
	 */
	const roll = $derived(rollUpFleet(fleet ?? [], now.ms));

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
	<AdminHeader />

	<div class="dashboard-grid">
		<AdminPanoramaLaunch
			{origin}
			{activeRole}
			lanIps={status?.lanIps}
			{copiedLink}
			onCopy={copyToClipboard}
		/>

		<AdminPresets {origin} />
	</div>

	<!--
		The wall push, on the page an operator actually opens.
		It lived only in the display's own operator drawer, behind a keystroke on
		a kiosk with no keyboard — so the one control that changes all three panes
		at once was reachable only by walking up to a pane. Wall.svelte's `nowSec`
		prop has been optional and documented as "omitted by /admin" since it was
		written; this is the mounting it was describing.

		`config` is read once to seed the draft and never written (see
		Wall.svelte's header), so a default PaneSettings is the honest thing to
		pass from a page that renders no scene.
	-->
	<section class="wall-push">
		<h2>Wall Push</h2>
		<Wall config={wallConfig} wall={wallSync} />
	</section>

	<AdminFleetHealth {fleet} {fleetError} {roll} nowMs={now.ms} />

	<AdminHostTelemetry {status} {statusError} />

	<footer class="footer">
		<p>{PRODUCT_NAME} &copy; 2026 {PRODUCT_OWNER} · Engineered by {ENGINEERED_BY}.</p>
		<p class="partners">In partnership with {PRODUCT_PARTNERS.join(' · ')}.</p>
		<p><a href="/">← Return to Main Window Display</a> | <a href="/wiki">System Wiki →</a></p>
	</footer>
</main>
