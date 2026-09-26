<script lang="ts">
	import { RestAdminStore, newCommandId } from '$lib/fleet/rest-admin.svelte';
	import { startPeerSync } from '$lib/fleet/peer-sync.svelte';
	import { isValidLocation } from '$content/locations';
	import { onDestroy } from 'svelte';
	import { fanOut } from '$lib/fleet/fan-out';
	import type { LocationId, WeatherType, DisplayMode } from '$lib/types';
	import {
		encodeSlideshowPayload,
		toAbsoluteMediaUrl,
		absolutizeMediaUrls,
		setModePayloadError,
	} from '$lib/fleet/display-payload';
	import { CRUISE_SPEED_DEFAULTS } from '$lib/model/config-tree.svelte';
import './admin.css';
	import AdminHeader from './sections/AdminHeader.svelte';
	import AdminScenePicker from './sections/AdminScenePicker.svelte';
	import AdminMediaPush from './sections/AdminMediaPush.svelte';
	import AdminAmbient from './sections/AdminAmbient.svelte';
	import AdminScenePush from './sections/AdminScenePush.svelte';
	import AdminSoftware from './sections/AdminSoftware.svelte';
	import AdminBindings from './sections/AdminBindings.svelte';
	import AdminDeviceGrid from './sections/AdminDeviceGrid.svelte';

	// Admin reuses the same dual-tree panel controls as the kiosk SidePanel.
	// They write through usePanelConfig → applyConfigPatch (no AeroWindow).
	// startPeerSync watches PEER_SYNC_PATHS and PATCHes peers on change.
	//
	// Scene-level state (location/weather/altitude/time/flightSpeed) stays in
	// local `scene` state — one-shot "go there", not ambient config.
	const store = new RestAdminStore();
	const stopPeerSync = startPeerSync(store);
	onDestroy(() => { stopPeerSync(); store.destroy(); });

	// Selection state
	let selectedDevices = $state<Set<string>>(new Set());

	// One-shot scene builder — what to command devices to be (not ambient config).
	// Shadow state is justified here because admin authors a DRAFT before pushing;
	// the device's actual location/time/weather is elsewhere (its own simulation).
	let scene = $state({
		location: 'dallas' as LocationId,
		weather: 'clear' as WeatherType,
		altitude: 35000,
		timeOfDay: 12,
		flightSpeed: CRUISE_SPEED_DEFAULTS.defaultSpeed,
		syncToRealTime: true,
	});

	// Seed the picker from the first online device once — otherwise a
	// blind "Fly There" pushes the hardcoded default (Dallas) over whatever
	// the wall is actually showing. Operator edits win: once a picker is
	// touched, seeding stops.
	let sceneSeeded = $state(false);
	let sceneDirty = $state(false);
	$effect(() => {
		if (sceneSeeded || sceneDirty) return;
		// Prefer an online device; fall back to any that has EVER reported
		// (lastSeen > 0 skips placeholder rows the store seeds before the
		// first status poll, whose 'dubai' location is not real data).
		const withLoc =
			store.devices.find((d) => d.online && isValidLocation(d.currentLocation)) ??
			store.devices.find((d) => d.lastSeen > 0 && isValidLocation(d.currentLocation));
		if (withLoc) {
			scene.location = withLoc.currentLocation;
			sceneSeeded = true;
		}
	});

	function getTargets(): string[] {
		return selectedDevices.size > 0
			? [...selectedDevices]
			: store.devices.map(d => d.deviceId);
	}

	// Actions — push results
	let pushResult = $state<{ ok: number; failed: string[] } | null>(null);

	/**
	 * The push skeleton the three handlers below all shared: resolve targets,
	 * mint one commandId for the whole fan-out, track it, fan out, and report.
	 *
	 * The commandId is the point. Kiosks echo it in their heartbeat, so the
	 * result line counts real APPLIES rather than HTTP 200s — and it has to be
	 * one id across all targets of a single push. Three hand-copied versions of
	 * that plumbing is three places for it to drift.
	 *
	 * `after` runs inside the same try, because a caller that re-reads state to
	 * confirm the push wants a failure there reported as a failed push, not
	 * swallowed next to a success line.
	 */
	async function pushCommand(
		op: (id: string, commandId: string) => Promise<unknown>,
		after?: () => Promise<void>,
	) {
		const targets = getTargets();
		if (targets.length === 0) return;
		pushResult = null;
		const commandId = newCommandId();
		store.trackCommand(commandId, targets);
		try {
			// One code path for 1..N targets: broadcastScene() was the same
			// per-peer POSTs under Promise.all, but one rejecting peer failed
			// the whole report (ok: 0 with 2 of 3 applied). fanOut attributes
			// success/failure per target.
			pushResult = await fanOut(targets, (id) => op(id, commandId));
			await after?.();
		} catch (e) { pushResult = { ok: 0, failed: [String(e)] }; }
	}

	async function handlePushScene() {
		await pushCommand((id, commandId) =>
			store.pushScene(id, scene.location, scene.weather, commandId));
	}

	async function handlePushMode(draft: { pushMode: DisplayMode; videoUrl: string; slideUrls: string[]; slideIntervalSec: number }) {
		// Checked here as well as inside pushCommand, deliberately: validation
		// below writes pushResult, so with nothing selected the operator would
		// get "video URL required" instead of the no-op they asked for.
		if (getTargets().length === 0) return;
		// Absolute-ify /api/assets paths against this admin origin so every Pi
		// fetches media from the host that holds the files (not its own empty store).
		const origin = typeof window !== 'undefined' ? window.location.origin : '';
		const { pushMode, videoUrl, slideUrls, slideIntervalSec } = draft;
		let payload: string | undefined;
		if (pushMode === 'video') {
			const abs = toAbsoluteMediaUrl(videoUrl, origin);
			const err = setModePayloadError('video', abs);
			if (err) {
				pushResult = { ok: 0, failed: [err] };
				return;
			}
			payload = abs;
		} else if (pushMode === 'screensaver') {
			const absolute = absolutizeMediaUrls(slideUrls, origin);
			const err = setModePayloadError('screensaver', absolute, slideIntervalSec);
			if (err) {
				pushResult = { ok: 0, failed: [err] };
				return;
			}
			payload = encodeSlideshowPayload(absolute, slideIntervalSec);
		}
		// flight: no payload
		await pushCommand(
			(id, commandId) => store.pushMode(id, pushMode, payload, commandId),
			async () => {
				// Heartbeats are slow — re-poll status so Mode chips reflect the
				// push. Short delay lets devices apply set_mode before we read
				// /api/status.
				await new Promise((r) => setTimeout(r, 400));
				await store.refreshStatus();
			},
		);
	}

	async function handlePushScene_Full() {
		const patch = {
			altitude: scene.altitude,
			...(scene.syncToRealTime ? {} : { timeOfDay: scene.timeOfDay }),
			flightSpeed: scene.flightSpeed,
			syncToRealTime: scene.syncToRealTime,
			weather: scene.weather,
		};
		await pushCommand((id, commandId) => store.pushSceneFull(id, patch, commandId));
	}

	function toggleSelectAll() {
		if (selectedDevices.size === store.devices.length) {
			selectedDevices = new Set();
		} else {
			selectedDevices = new Set(store.devices.map(d => d.deviceId));
		}
	}

	function toggleDevice(id: string) {
		const next = new Set(selectedDevices);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		selectedDevices = next;
	}

	// Derived from the const-array SSOTs in $lib/types, not re-listed. A hand
	// written copy silently goes stale the day a weather type or display mode is
	// added: the kiosk's own WeatherPicker already iterates WEATHER_TYPES, so the
	// admin would offer a different set than the device it is driving.

	/**
	 * Pretty-print device.currentMode on cards (wire uses screensaver).
	 *
	 * Its own Record rather than MODE_LABELS directly: the card wants the
	 * shorter 'Flight', not the picker's 'Flight Sim'. But it must stay
	 * Record<DisplayMode, string> — the previous if-chain fell through to the
	 * raw wire string, so a mode added anywhere else would have shown up here
	 * as `screensaver` instead of failing to compile.
	 */

</script>

<div class="dashboard">
		<AdminHeader store={store} />

	<div class="content">
		<!-- Control Panel -->
		<aside class="controls">
		<AdminScenePicker scene={scene} bind:sceneDirty selectedCount={selectedDevices.size} onPushScene={handlePushScene} />

		<AdminMediaPush selectedCount={selectedDevices.size} onPushMode={handlePushMode} />

		<AdminAmbient scene={scene} />

		<AdminScenePush scene={scene} selectedCount={selectedDevices.size} pushResult={pushResult} store={store} onPushFull={handlePushScene_Full} />

		<AdminSoftware getTargets={getTargets} store={store} selectedCount={selectedDevices.size} />

		<AdminBindings />

		</aside>

			<AdminDeviceGrid store={store} selectedDevices={selectedDevices} onToggleSelectAll={toggleSelectAll} onToggleDevice={toggleDevice} />
	</div>
</div>
