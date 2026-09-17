<script lang="ts">
	/**
	 * The Wall tab — the only control that pushes.
	 *
	 * Its state is a LOCAL DRAFT, deliberately not bound to `config`. A control
	 * that writes locally AND pushes is the two-mutation-paths shape ADR-007
	 * named as root cause: the local write lands instantly, the push lands at
	 * `applyAtWallSec`, and between those two moments this pane disagrees with
	 * itself. So nothing here touches `config` — the draft goes to the server,
	 * the server names a second, and `advanceTo` applies it on every pane
	 * together, this one included.
	 *
	 * Which is why the operator sees their own change arrive a beat late. That is
	 * the wall being a wall.
	 */
	import { onMount, untrack } from 'svelte';
	import MediaPicker from './MediaPicker.svelte';
	import Segmented from './Segmented.svelte';
	import Toggle from './Toggle.svelte';
	import { LOCATIONS, type Location } from './locations.js';
	import { SCENE_PRESETS } from './presets.js';
	import { KNOB_RANGE, WEATHERS, type PaneSettings } from './settings.svelte.js';
	import type { WallSync } from './wall.svelte.js';
	import type { WallState } from '#lib/wall.js';
	import { mediaLibrary } from './media-library.svelte.js';

	interface Props {
		config: PaneSettings;
		wall: WallSync;
		/** Omitted by /admin, which has no display context and so no wall clock. */
		nowSec?: () => number;
	}

	const { config, wall, nowSec }: Props = $props();

	/**
	 * Seeded from what this pane shows, so the first push is not a surprise.
	 *
	 * `untrack` because capturing the INITIAL value is the intent, not an
	 * oversight: a draft that followed `config` would move under the operator's
	 * hands every time a push or a rotation landed, and there would be no way to
	 * stage a change before sending it.
	 */
	let draft = $state<WallState>(
		untrack(() => ({
			placeId: config.place.id,
			presetId: '',
			weather: config.weather,
			clockOffsetH: config.clockOffsetH,
			displayMode: config.displayMode,
			blindOpen: config.blindOpen,
			rotate: config.rotate,
			mediaUrls: config.videoPlaylist.slice(),
			// Seeded like the video list: what this pane is playing is the least
			// surprising thing for the first push to carry.
			audioUrls: config.audioPlaylist.slice()
		}))
	);

	let status = $state<string>('');
	let pushing = $state(false);

	// One listing for both pickers, fetched when the tab first appears rather
	// than on every keystroke that reveals one.
	onMount(() => void mediaLibrary.refresh());

	const countdown = $derived.by(() => {
		const due = wall.pending?.applyAtWallSec;
		if (!due || !nowSec) return null;
		return Math.max(0, Math.ceil(due - nowSec()));
	});

	async function push() {
		pushing = true;
		status = '';
		try {
			const res = await fetch('/api/wall', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(draft)
			});
			const body = await res.json();
			status = res.ok
				? `pushed v${body.version}`
				: `refused (${res.status}): ${body.error ?? 'unknown'}`;
		} catch {
			// The wall origin is unreachable. Say so here rather than nowhere —
			// this panel is the one screen an operator is actually looking at.
			status = 'could not reach the wall';
		} finally {
			pushing = false;
		}
	}
</script>

<div class="wall-tab">
	<p class="explain">
		Pushes to every pane at once. Applied on the wall clock, so it lands here a few seconds later
		too.
	</p>

	<Segmented
		label="Destination"
		options={LOCATIONS}
		isActive={(l: Location) => l.id === draft.placeId}
		onselect={(l: Location) => (draft.placeId = l.id)}
		format={(l: Location) => l.name}
		key={(l: Location) => l.id}
	/>

	<Segmented
		label="Preset"
		options={['', ...SCENE_PRESETS.map((p) => p.id)]}
		isActive={(id: string) => id === draft.presetId}
		onselect={(id: string) => (draft.presetId = id)}
		format={(id: string) => (id === '' ? 'NONE' : id.replace(/-/g, ' ').toUpperCase())}
	/>

	<Segmented
		label="Weather"
		options={WEATHERS}
		isActive={(w: string) => w === draft.weather}
		onselect={(w: string) => (draft.weather = w)}
	/>

	<Segmented
		label="Mode"
		options={['flight', 'video', 'screensaver', 'standby'] as const}
		isActive={(m: string) => m === draft.displayMode}
		onselect={(m: string) => (draft.displayMode = m)}
	/>

	<!--
		The admin token, once, for both pickers. Uploading and importing write to
		this device's disk, so both are bearer-gated; picking and pushing are not.
		Typed per use and held in memory only — see media-library.svelte.ts.
	-->
	<label class="token-field">
		<span>Admin token <em>(needed only to add files)</em></span>
		<input
			type="password"
			autocomplete="off"
			placeholder="AERO_ADMIN_TOKEN"
			value={mediaLibrary.token}
			oninput={(e) => (mediaLibrary.token = e.currentTarget.value)}
		/>
	</label>
	{#if mediaLibrary.status}
		<p class="library-status">{mediaLibrary.status}</p>
	{/if}

	{#if draft.displayMode === 'video' || draft.displayMode === 'screensaver'}
		<!-- The mode and its content travel in one snapshot. Before this field
		     existed the wall could push `video` but the only writers of the
		     playlist were `?media=` URL params parsed at boot — so the switch
		     put "No media specified" on every pane. -->
		<MediaPicker
			label="Clips"
			kind="video"
			selected={draft.mediaUrls}
			onchange={(urls) => (draft.mediaUrls = urls)}
		/>
	{/if}

	<!--
		Always shown, not gated on the display mode: the cabin's soundtrack plays
		in flight too. `audioUrls` had no control at all until now — the field
		travelled in every snapshot and nothing could set it.
	-->
	<MediaPicker
		label="Soundtrack"
		kind="audio"
		selected={draft.audioUrls}
		onchange={(urls) => (draft.audioUrls = urls)}
		placeholder="Nothing chosen — the panes keep whatever they are playing."
	/>

	<!--
		A native range rather than the Knob control: Knob takes `config` and writes
		`config[key]` directly, which is precisely what this tab must not do. The
		range still reads its bounds from KNOB_RANGE, so the two cannot drift.
	-->
	<label class="offset">
		<span>Clock offset <em>{draft.clockOffsetH}h</em></span>
		<input
			type="range"
			min={KNOB_RANGE.clockOffsetH[0]}
			max={KNOB_RANGE.clockOffsetH[1]}
			step="0.25"
			value={draft.clockOffsetH}
			oninput={(e) => (draft.clockOffsetH = Number(e.currentTarget.value))}
		/>
	</label>

	<Toggle checked={draft.blindOpen} label="Blind open" onchange={(v) => (draft.blindOpen = v)} />
	<Toggle
		checked={draft.rotate}
		label="Rotate destinations"
		description="Off pins the wall to the chosen destination."
		onchange={(v) => (draft.rotate = v)}
	/>

	<div class="push-row">
		<button type="button" class="push-btn" onclick={push} disabled={pushing}>
			{pushing ? 'Pushing…' : 'Push to wall'}
		</button>
		{#if countdown !== null}
			<span class="countdown">applies in {countdown}s</span>
		{:else if status}
			<span class="status">{status}</span>
		{/if}
	</div>
	<p class="applied">applied version: {wall.appliedVersion || 'none yet'}</p>
</div>

<style>
	.token-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 10px 0 0;
		font-size: 0.8rem;
		color: var(--text-muted);
	}
	.token-field em {
		opacity: 0.6;
		font-style: normal;
		font-size: 0.72rem;
	}
	.library-status {
		margin: 0;
		font-size: 11px;
		opacity: 0.7;
	}
	.token-field input {
		padding: 6px 8px;
		background: rgba(0, 0, 0, 0.35);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 4px;
		color: var(--text-primary);
		font-size: 0.8rem;
		font-family: monospace;
	}

	.wall-tab {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.explain,
	.applied {
		margin: 0;
		font-size: 11px;
		opacity: 0.6;
	}
	.push-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 6px;
	}
	.push-btn {
		flex: 1;
		padding: 8px 12px;
		border-radius: 8px;
		border: 1px solid rgba(255, 255, 255, 0.25);
		background: rgba(255, 255, 255, 0.1);
		color: inherit;
		font: inherit;
		cursor: pointer;
	}
	.push-btn:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.offset {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: 12px;
	}
	.offset em {
		opacity: 0.7;
		font-style: normal;
	}
	.countdown,
	.status {
		font-size: 11px;
		opacity: 0.8;
		white-space: nowrap;
	}
</style>
