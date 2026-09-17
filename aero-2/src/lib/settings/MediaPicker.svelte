<script lang="ts">
	/**
	 * MediaPicker — choose an ORDERED playlist from what this device holds.
	 *
	 * It replaces a comma-separated text input. That input was the only way to
	 * set `mediaUrls`, which meant an operator had to know a sixteen-hex content
	 * hash by heart to play a file they had just uploaded — and `audioUrls` had
	 * no control at all, so the field shipped, travelled in every snapshot, and
	 * could not be set.
	 *
	 * NOT `Segmented`, which is the only other picker here. Segmented is
	 * one-of-N by construction: `onselect` hands back a single option with no
	 * add/remove semantics and no ordering, and a playlist is an ordered list.
	 * Its `key`-function contract IS copied, because the default `String(option)`
	 * on object options took the whole drawer down once already.
	 *
	 * Like the rest of this tab it writes nothing to `config` — only `onchange`,
	 * which the parent applies to its draft. See Wall.svelte's header.
	 */
	import { mediaLibrary, humanSize } from './media-library.svelte.js';
	import type { MediaItem } from '#lib/server/media-store.js';

	interface Props {
		label: string;
		/** Which half of the library to offer. */
		kind: 'audio' | 'video';
		/** The current playlist, in order. */
		selected: string[];
		onchange: (urls: string[]) => void;
		placeholder?: string;
	}

	const { label, kind, selected, onchange, placeholder }: Props = $props();

	const available = $derived(kind === 'audio' ? mediaLibrary.audio : mediaLibrary.video);

	/**
	 * A selected URL may name a file this device does not hold — a CDN URL typed
	 * before this component existed, or a track deleted since. Those still have
	 * to be listed and removable, so the chosen list is built from `selected`,
	 * not by filtering `available`.
	 */
	const chosen = $derived(
		selected.map((url) => ({
			url,
			item: available.find((m: MediaItem) => m.url === url) ?? null
		}))
	);

	const nameOf = (url: string) => url.split('/').pop() ?? url;

	function toggle(url: string) {
		onchange(selected.includes(url) ? selected.filter((u) => u !== url) : [...selected, url]);
	}

	function move(index: number, by: number) {
		const next = selected.slice();
		const to = index + by;
		if (to < 0 || to >= next.length) return;
		[next[index], next[to]] = [next[to], next[index]];
		onchange(next);
	}

	async function onFile(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		await mediaLibrary.upload(file);
		// Clear it, or picking the same file twice after a failure is a no-op.
		input.value = '';
	}
</script>

<section class="picker">
	<h4>{label}</h4>

	{#if chosen.length === 0}
		<p class="empty">{placeholder ?? 'Nothing chosen — the panes keep what they have.'}</p>
	{:else}
		<ol class="chosen">
			{#each chosen as entry, i (entry.url)}
				<li>
					<span class="pos">{i + 1}</span>
					<span class="name" class:missing={!entry.item} title={entry.url}>
						{nameOf(entry.url)}
						{#if !entry.item}<em>not on this device</em>{/if}
					</span>
					<button type="button" onclick={() => move(i, -1)} disabled={i === 0} title="Move up"
						>↑</button
					>
					<button
						type="button"
						onclick={() => move(i, 1)}
						disabled={i === chosen.length - 1}
						title="Move down">↓</button
					>
					<button type="button" onclick={() => toggle(entry.url)} title="Remove">✕</button>
				</li>
			{/each}
		</ol>
	{/if}

	<div class="library">
		{#if mediaLibrary.loading}
			<p class="empty">Reading the library…</p>
		{:else if available.length === 0}
			<p class="empty">No {kind} on this device yet. Upload one, or import a drive.</p>
		{:else}
			<div class="grid">
				{#each available as item (item.filename)}
					<button
						type="button"
						class="opt"
						class:active={selected.includes(item.url)}
						onclick={() => toggle(item.url)}
						title="{item.filename} · {humanSize(item.size)}"
					>
						{item.filename}
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="add">
		<label class="file">
			<input type="file" accept={kind === 'audio' ? 'audio/*' : 'video/*'} onchange={onFile} />
			<span>Upload a file</span>
		</label>
		<button type="button" onclick={() => mediaLibrary.importUsb()}>Import from USB</button>
	</div>
</section>

<style>
	.picker {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	h4 {
		margin: 0;
		font-size: 0.75rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		opacity: 0.7;
	}
	.empty {
		margin: 0;
		font-size: 11px;
		opacity: 0.55;
	}
	.chosen {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.chosen li {
		display: flex;
		align-items: center;
		gap: 6px;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 4px;
		padding: 4px 6px;
		font-size: 0.72rem;
	}
	.pos {
		opacity: 0.5;
		font-variant-numeric: tabular-nums;
		min-width: 1.2em;
	}
	.name {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: monospace;
	}
	.name.missing {
		color: #fbbf24;
	}
	.name em {
		opacity: 0.7;
		font-style: normal;
		font-family: inherit;
	}
	.chosen button,
	.add button {
		background: rgba(255, 255, 255, 0.07);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 4px;
		color: inherit;
		font: inherit;
		cursor: pointer;
		padding: 2px 6px;
	}
	.chosen button:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 6px;
	}
	.opt {
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 4px;
		padding: 6px 4px;
		color: #cbd5e1;
		font-size: 0.68rem;
		font-family: monospace;
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		transition: all 0.15s ease;
	}
	.opt:hover {
		background: rgba(255, 255, 255, 0.1);
		color: #ffffff;
	}
	.opt.active {
		background: var(--accent-cyan, #38bdf8);
		color: #0b111e;
		font-weight: 600;
		border-color: var(--accent-cyan, #38bdf8);
	}
	.add {
		display: flex;
		gap: 6px;
		align-items: center;
		font-size: 0.72rem;
	}
	.file input {
		display: none;
	}
	.file span {
		display: inline-block;
		background: rgba(255, 255, 255, 0.07);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 4px;
		padding: 3px 8px;
		cursor: pointer;
	}
</style>
