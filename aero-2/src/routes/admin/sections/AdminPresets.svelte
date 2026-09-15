<script lang="ts">
	import { LOCATIONS } from '#lib/settings/locations.js';
	import { SCENE_PRESETS } from '#lib/settings/presets.js';

	let { origin }: { origin: string } = $props();
</script>

<section class="card">
	<h2>🎨 Scene Composition Presets</h2>
	<p class="card-desc">Push curated atmospheric, lighting, and terrain compositions to kiosks.</p>

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
