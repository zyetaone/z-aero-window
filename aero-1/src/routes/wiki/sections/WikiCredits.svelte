<!-- WikiCredits — wiki section, extracted verbatim from +page.svelte. -->
<script lang="ts">
	import {
		PRODUCT_CREDIT_BLURB,
		PRODUCT_OWNER,
		ENGINEERED_BY,
	} from '$lib/credits';
</script>

	<!-- ═══════════════════════════════════════════════════════════════ CREDITS -->
	<section id="credits">
		<h2>Credits</h2>
		<p class="hidden-blurb">{PRODUCT_CREDIT_BLURB}</p>
		<div class="omission-list">
			<div class="omission-item">
				<h4>{PRODUCT_OWNER}</h4>
				<p>
					Product owner and fleet operator brand. Install relationships (for example SWA
					Hyderabad) sit with {PRODUCT_OWNER}.
				</p>
			</div>
			<div class="omission-item">
				<h4>{ENGINEERED_BY}</h4>
				<p>
					Engine, architecture, fleet protocol, offline tile pipeline, and kiosk runtime.
					Attribution SSOT lives in <code>src/lib/credits.ts</code> and is mirrored in boot
					lockup, package metadata, and this wiki — so a rebrand cannot leave three
					conflicting stories.
				</p>
			</div>
			<div class="omission-item">
				<h4>Open data &amp; stack</h4>
				<p>
					EOX Sentinel-2 Cloudless · NASA VIIRS · OpenStreetMap · CesiumJS · Svelte 5 /
					SvelteKit · Three.js (optional) · Bun · Raspberry Pi 5 / Chromium kiosk.
				</p>
			</div>
		</div>
	</section>
