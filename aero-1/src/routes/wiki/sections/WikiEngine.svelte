<!-- WikiEngine — wiki section, extracted verbatim from +page.svelte. -->
	<!-- ═══════════════════════════════════════════════════════════════ ARCHITECTURE -->
	<section id="architecture">
		<h2>Engine Architecture — Five Layers</h2>
		<p class="hidden-blurb">AeroWindow is a real-time engine, not an SPA. The architecture follows Svelte 5's reactive model above Cesium's native render graph — state and computation in runes, synchronisation into Cesium via <code>$effect</code>, only one imperative subsystem (the Flight Engine).</p>
		<div class="arch-stack">
			<div class="arch-layer title">
				<span>SvelteKit Application</span>
				<span class="arch-sub">+layout · +page · Pane · HUD · Settings · Telemetry</span>
			</div>
			<div class="arch-layer svelte">
				<span>Svelte 5 Reactive Model</span>
				<span class="arch-sub">$state · $derived · $effect</span>
			</div>
			<div class="arch-layer cesium">
				<span>Cesium Native Engine</span>
				<span class="arch-sub">Viewer · Scene · Terrain · Imagery · Buildings · Atmosphere · PostProcess</span>
			</div>
			<div class="arch-layer data">
				<span>Open Data Sources</span>
				<span class="arch-sub">Copernicus DEM · Sentinel-2 · VIIRS · OSM Buildings · Open-Meteo</span>
			</div>
			<div class="arch-layer gpu">
				<span>WebGL</span>
			</div>
		</div>
		<div class="ownership-grid">
			<div class="ownership-card">
				<h4>Model</h4>
				<p>Owns application state. Configuration, flight, weather, lighting. It never renders.</p>
			</div>
			<div class="ownership-card">
				<h4>World</h4>
				<p>Owns Earth. Terrain, imagery, atmosphere, buildings, night lights. It never decides <em>where</em> to fly.</p>
			</div>
			<div class="ownership-card">
				<h4>Camera</h4>
				<p>Owns movement. Camera pose, bank, parallax, seat-look frame. Nothing visual.</p>
			</div>
			<div class="ownership-card">
				<h4>Flight</h4>
				<p>Owns behaviour. Pick location, change weather, advance time, start flyover. Imperative — simulation isn't reactive.</p>
			</div>
			<div class="ownership-card">
				<h4>Scene</h4>
				<p>Owns decorative effects. Car lights, clouds, video bundles. Independent of Cesium.</p>
			</div>
			<div class="ownership-card">
				<h4>Shell</h4>
				<p>Owns presentation. Window frame, glass, wing, HUD, panels. Independent of simulation.</p>
			</div>
		</div>
		<div class="detail-box note">
			<h4>○ Single-Viewer Rule</h4>
			<p>Exactly one Cesium <code>Viewer</code> per process. The only call site is <code>src/lib/world/CesiumViewer.svelte</code>. A second Viewer doubles GPU memory and produces no coherent compositing result. If you think you need a second canvas, design a different pattern — not a second Viewer.</p>
		</div>
		<p class="arch-footer-line">See <code>docs/ARCHITECTURE.md</code> for the full architecture document, including the manager-to-feature migration map.</p>
	</section>
