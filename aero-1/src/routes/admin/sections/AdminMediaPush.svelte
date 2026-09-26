<!-- AdminMediaPush — owns media draft state; page pushes via onPushMode(draft). -->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { AssetInfo } from '$lib/server/bundle/assets';
	import { isAllowedMediaUrl, isRelativeAssetUrl, MAX_SLIDESHOW_URLS, DEFAULT_SLIDESHOW_INTERVAL_SEC } from '$lib/fleet/display-payload';
	import { DISPLAY_MODES, DISPLAY_MODE_LABELS, type DisplayMode } from '$lib/types';

	let { selectedCount, onPushMode }: {
		selectedCount: number,
		onPushMode: (draft: { pushMode: DisplayMode; videoUrl: string; slideUrls: string[]; slideIntervalSec: number }) => void
	} = $props();

	let pushMode = $state<DisplayMode>('flight');
	let videoUrl = $state('');
	let slideUrls = $state<string[]>([]);
	let slideIntervalSec = $state(DEFAULT_SLIDESHOW_INTERVAL_SEC);
	let slideUrlDraft = $state('');
	let assets = $state.raw<AssetInfo[]>([]);

	const VIDEO_EXT = /\.(mp4|webm)$/i;
	const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
	const videoAssets = $derived(assets.filter((a) => VIDEO_EXT.test(a.filename)));
	const imageAssets = $derived(assets.filter((a) => IMAGE_EXT.test(a.filename)));
	const adminOrigin = $derived(typeof window !== 'undefined' ? window.location.origin : '');
	const usesRelativeAssets = $derived.by(() => {
		if (pushMode === 'video') return isRelativeAssetUrl(videoUrl);
		if (pushMode === 'screensaver') return slideUrls.some(isRelativeAssetUrl);
		return false;
	});

	async function refreshAssets() {
		try {
			const res = await fetch('/api/assets');
			if (!res.ok) return;
			const data = await res.json();
			assets = (data.assets ?? []) as AssetInfo[];
		} catch { /* assets optional offline */ }
	}
	onMount(() => { void refreshAssets(); });

	function pickVideoAsset(url: string) { videoUrl = url; }
	function toggleSlideAsset(url: string) {
		if (slideUrls.includes(url)) slideUrls = slideUrls.filter((u) => u !== url);
		else slideUrls = [...slideUrls, url];
	}
	function addSlideUrlDraft() {
		const u = slideUrlDraft.trim();
		if (!isAllowedMediaUrl(u) || slideUrls.includes(u)) return;
		slideUrls = [...slideUrls, u];
		slideUrlDraft = '';
	}
	function removeSlideUrl(url: string) { slideUrls = slideUrls.filter((u) => u !== url); }
	function moveSlide(url: string, dir: -1 | 1) {
		const i = slideUrls.indexOf(url);
		if (i < 0) return;
		const j = i + dir;
		if (j < 0 || j >= slideUrls.length) return;
		const next = [...slideUrls];
		[next[i], next[j]] = [next[j], next[i]];
		slideUrls = next;
	}

	const MODE_OPTIONS: { value: DisplayMode; label: string }[] =
		DISPLAY_MODES.map((value) => ({ value, label: DISPLAY_MODE_LABELS[value].long }));
</script>

			<section class="control-section">
				<h3>Mode</h3>
				<p class="section-caption">
					Flight = globe. Video = looped fullscreen. Slideshow = image playlist
					(screensaver). Upload media on <a href="/admin/content">Content</a>, then pick here.
					Asset paths are rewritten to absolute URLs against this admin host so every Pi can fetch them.
				</p>
				{#if usesRelativeAssets}
					<p class="media-warn">
						Devices must reach <code>{adminOrigin}</code> for these assets
						(or use absolute CDN/http URLs).
					</p>
				{/if}
				<div class="mode-buttons">
					{#each MODE_OPTIONS as opt (opt.value)}
						<button
							class={['btn', 'btn-mode', pushMode === opt.value && 'active']}
							onclick={() => pushMode = opt.value}
						>
							{opt.label}
						</button>
					{/each}
				</div>

				{#if pushMode === 'video'}
					<label>
						<span>Video URL</span>
						<input
							type="url"
							placeholder="https://… or /api/assets/…"
							bind:value={videoUrl}
							class="input"
						/>
					</label>
					{#if videoAssets.length > 0}
						<p class="asset-hint">Installed videos — click to select</p>
						<div class="asset-grid">
							{#each videoAssets as a (a.filename)}
								<button
									type="button"
									class={['asset-chip', videoUrl === a.url && 'active']}
									onclick={() => pickVideoAsset(a.url)}
									title={a.filename}
								>
									{a.filename}
								</button>
							{/each}
						</div>
					{:else}
						<p class="asset-hint muted">No video assets yet — drop .mp4/.webm on Content.</p>
					{/if}
				{:else if pushMode === 'screensaver'}
					<label>
						<div class="slider-header">
							<span>Slide interval</span>
							<span class="slider-value">{slideIntervalSec}s</span>
						</div>
						<input
							type="range"
							min="3"
							max="60"
							step="1"
							bind:value={slideIntervalSec}
							class="range"
						/>
					</label>
					{#if imageAssets.length > 0}
						<p class="asset-hint">Installed images — click to toggle in playlist</p>
						<div class="asset-grid">
							{#each imageAssets as a (a.filename)}
								<button
									type="button"
									class={['asset-chip', slideUrls.includes(a.url) && 'active']}
									onclick={() => toggleSlideAsset(a.url)}
									title={a.filename}
								>
									{a.filename}
								</button>
							{/each}
						</div>
					{:else}
						<p class="asset-hint muted">No image assets yet — drop .png/.jpg/.webp on Content.</p>
					{/if}
					<div class="slide-url-row">
						<input
							type="url"
							placeholder="Add external image URL…"
							bind:value={slideUrlDraft}
							class="input"
							onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSlideUrlDraft(); } }}
						/>
						<button type="button" class="btn btn-secondary" onclick={addSlideUrlDraft}>Add</button>
					</div>
					{#if slideUrls.length > 0}
						<p class="asset-hint">
							{slideUrls.length} / {MAX_SLIDESHOW_URLS} images in playlist
							{#if slideUrls.length > MAX_SLIDESHOW_URLS}
								<span class="media-warn-inline"> — over limit</span>
							{/if}
						</p>
						<ol class="slide-list">
							{#each slideUrls as url, i (url)}
								<li>
									<span class="slide-idx">{i + 1}</span>
									<code class="slide-url" title={url}>{url}</code>
									<div class="slide-actions">
										<button type="button" class="icon-btn" onclick={() => moveSlide(url, -1)} disabled={i === 0} title="Up">↑</button>
										<button type="button" class="icon-btn" onclick={() => moveSlide(url, 1)} disabled={i === slideUrls.length - 1} title="Down">↓</button>
										<button type="button" class="icon-btn" onclick={() => removeSlideUrl(url)} title="Remove">×</button>
									</div>
								</li>
							{/each}
						</ol>
					{/if}
				{/if}

				<button class="btn btn-secondary" onclick={() => onPushMode({ pushMode, videoUrl, slideUrls, slideIntervalSec })}>
					Push Mode {selectedCount > 0 ? `(${selectedCount})` : '(All)'}
				</button>
			</section>
