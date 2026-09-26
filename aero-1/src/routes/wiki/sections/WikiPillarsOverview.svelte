<!-- WikiPillarsOverview — wiki section, extracted verbatim from +page.svelte. -->
	<!-- ═══════════════════════════════════════════════════════════════ PILLARS -->
	<section>
		<h2>The 7 Pillars</h2>
		<div class="pillar-grid">
			<div class="pillar-card built">
				<span class="pillar-num">1</span>
				<h3>Game Loop</h3>
				<p>Single RAF heartbeat. Visibility-aware. Error-resilient.</p>
				<span class="badge">built</span>
			</div>
			<div class="pillar-card built">
				<span class="pillar-num">2</span>
				<h3>State</h3>
				<p>Flat $state tree. CRDT sync across 6 Pis. One setByPath.</p>
				<span class="badge">built</span>
			</div>
			<div class="pillar-card built">
				<span class="pillar-num">3</span>
				<h3>Rendering</h3>
				<p>Z-layered compositor. Cesium WebGL → CSS effects → glass chrome.</p>
				<span class="badge">built</span>
			</div>
			<div class="pillar-card built">
				<span class="pillar-num">4</span>
				<h3>Camera</h3>
				<p>Orbit + cruise. Warp transitions. Six motion layers.</p>
				<span class="badge">built</span>
			</div>
			<div class="pillar-card built">
				<span class="pillar-num">5</span>
				<h3>Input</h3>
				<p>One passenger gesture: pull the blind. Everything else is operator surface.</p>
				<span class="badge">built</span>
			</div>
			<div class="pillar-card built">
				<span class="pillar-num">6</span>
				<h3>Content</h3>
				<p>Authorable by non-engineers. 12 locations. 21 scenarios.</p>
				<span class="badge">built</span>
			</div>
			<div class="pillar-card built">
				<span class="pillar-num">7</span>
				<h3>The Night</h3>
				<p>Five rendering stages. Smoothstep gates. The viewer never sees a transition.</p>
				<span class="badge">built</span>
			</div>
			<div class="pillar-card hidden">
				<span class="pillar-num">8</span>
				<h3>Time</h3>
				<p>Six consumers, no owner. Drives every smoothstep night gate.</p>
				<span class="badge">hidden</span>
			</div>
			<div class="pillar-card hidden">
				<span class="pillar-num">9</span>
				<h3>Networking</h3>
				<p>REST + SSE + CRDT + mDNS. Buried under "State." The field-failure pillar.</p>
				<span class="badge">hidden</span>
			</div>
		</div>
	</section>
