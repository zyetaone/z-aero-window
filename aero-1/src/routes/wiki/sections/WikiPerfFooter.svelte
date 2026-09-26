<!-- WikiPerfFooter — wiki section, extracted verbatim from +page.svelte. -->
<script lang="ts">
	import {
		PRODUCT_CREDIT_LINE,
		PRODUCT_YEAR,
		PRODUCT_OWNER,
		ENGINEERED_BY,
	} from '$lib/credits';
</script>

	<!-- ═══════════════════════════════════════════════════════════════ PI PERF -->
	<section id="perf">
		<h2>Pi performance — local process</h2>
		<p class="hidden-blurb">
			Measured kiosk reality (2026-07): ~2–4 fps at 2560×1080, with <em>simulation</em>
			under 1 ms — the cost is Cesium scene / tiles / postprocess, not Svelte. Full write-up:
			<code>docs/PERF-2026-07-27-fps-investigation.md</code> and
			<code>docs/PI-PERF-PROCESS.md</code>.
		</p>
		<div class="omission-list">
			<div class="omission-item">
				<h4>Measure with a pinned scene</h4>
				<p>
					Autopilot rotates cities; single fps samples are noise. Fix location, weather,
					time, and disable director before comparing builds. Prefer median of several
					runs on the same commit.
				</p>
			</div>
			<div class="omission-item">
				<h4>Ship defaults already lean</h4>
				<p>
					<code>qualityMode: 'performance'</code>, offline tiles first, local buildings.
					Do not lower panel resolution as a "fix" — fill rate is not the bottleneck.
					Do not trust a Chromium GL flag without reading GPU process argv.
				</p>
			</div>
			<div class="omission-item">
				<h4>Local process (engineer laptop → Pi)</h4>
				<p>
					1) <code>bun run check && bun run test && bun run build</code> on main.
					2) Deploy only via the <code>release</code> branch gate.
					3) On device: confirm tile cache health, <code>qualityMode</code>, Three overlay
					off if A/B shows cost.
					4) Ablate postprocess / buildings SSE before chasing app logic.
				</p>
			</div>
		</div>
	</section>

	<footer class="arch-footer">
		<p>{PRODUCT_CREDIT_LINE}</p>
		<p class="arch-footer-sub">
			SvelteKit 2 + Cesium + Bun · Raspberry Pi 5 kiosk · SWA field install.
			Living architecture: this page + <code>docs/ARCHITECTURE.md</code> + <code>AGENTS.md</code>.
			Subsystem pattern formalised under <code>src/lib/world/</code>; Z-order local to
			<code>Pane.svelte</code>. Wiki route is SSR-only (<code>csr=false</code>) so kiosk
			bundles never pay for this prose.
		</p>
		<p class="arch-footer-sub">© {PRODUCT_YEAR} {PRODUCT_OWNER} · engineered by {ENGINEERED_BY}</p>
	</footer>
