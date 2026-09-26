<script lang="ts">
	// Static project wiki — architecture, terms, lifecycle, credits.
	// csr=false: no client JS (see +page.ts). Import pure modules only.
	import {
		ENGINEERED_BY,
		PRODUCT_CREDIT_BLURB,
		PRODUCT_NAME,
		PRODUCT_OWNER,
		PRODUCT_SHORT,
		PRODUCT_STAGE,
	} from '$lib/credits';
	import './wiki.css';
	import WikiPillarsOverview from './sections/WikiPillarsOverview.svelte';
	import WikiEngine from './sections/WikiEngine.svelte';
	import WikiPillarsCore from './sections/WikiPillarsCore.svelte';
	import WikiPillarsCamera from './sections/WikiPillarsCamera.svelte';
	import WikiNightDecisions from './sections/WikiNightDecisions.svelte';
	import WikiHiddenVerdict from './sections/WikiHiddenVerdict.svelte';
	import WikiTerms from './sections/WikiTerms.svelte';
	import WikiLifecycle from './sections/WikiLifecycle.svelte';
	import WikiCredits from './sections/WikiCredits.svelte';
	import WikiPerfFooter from './sections/WikiPerfFooter.svelte';
</script>

<svelte:head>
	<title>Wiki — {PRODUCT_SHORT}</title>
	<meta
		name="description"
		content="{PRODUCT_NAME} — architecture, terms of operation, lifecycle, and credits ({PRODUCT_OWNER} · {ENGINEERED_BY})"
	/>
</svelte:head>

<main class="arch-doc">
	<!-- ═══════════════════════════════════════════════════════════════ HERO -->
	<header class="hero">
		<h1>{PRODUCT_SHORT}</h1>
		<p class="subtitle">Wiki — Architecture · Terms · Lifecycle · Credits</p>
		<p class="deck">
			A circadian-aware digital airplane window for office wellbeing.
			{PRODUCT_CREDIT_BLURB}
		</p>
		<nav class="wiki-toc" aria-label="Wiki sections">
			<a href="#architecture">Architecture</a>
			<a href="#terms">Terms</a>
			<a href="#lifecycle">Lifecycle</a>
			<a href="#credits">Credits</a>
			<a href="#perf">Pi performance</a>
		</nav>
		<div class="hero-meta">
			{#if PRODUCT_STAGE}<span class="stage-badge">{PRODUCT_STAGE}</span>{/if}
			<span>SvelteKit 2 + Svelte 5 Runes</span>
			<span>Cesium + WebGL</span>
			<span>Bun Runtime</span>
			<span>Raspberry Pi 5 Kiosk</span>
			<span>{PRODUCT_OWNER} · {ENGINEERED_BY}</span>
		</div>
	</header>


	<WikiPillarsOverview />

	<WikiEngine />

	<WikiPillarsCore />

	<WikiPillarsCamera />

	<WikiNightDecisions />

	<WikiHiddenVerdict />

	<WikiTerms />

	<WikiLifecycle />

	<WikiCredits />

	<WikiPerfFooter />
</main>
