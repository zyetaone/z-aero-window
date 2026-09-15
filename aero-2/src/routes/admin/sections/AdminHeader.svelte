<script lang="ts">
	import { PRODUCT_NAME, PRODUCT_STAGE } from '#lib/credits.js';
</script>

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
