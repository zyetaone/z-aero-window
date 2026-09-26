<!-- WikiPillarsCore — wiki section, extracted verbatim from +page.svelte. -->
	<!-- ═══════════════════════════════════════════════════════════════ GAME LOOP -->
	<section>
		<h2>Pillar 1 — The Game Loop</h2>
		<div class="flow-diagram">
			<div class="flow-node root">requestAnimationFrame<div class="flow-sub">60 Hz heartbeat</div></div>
			<div class="flow-arrow">↓ dt</div>
			<div class="flow-node">model.tick(dt)<div class="flow-sub">flight · motion · director</div></div>
			<div class="flow-arrow">↓</div>
			<div class="flow-node">Svelte $derived<div class="flow-sub">re-computes only what changed</div></div>
			<div class="flow-arrow">↓</div>
			<div class="flow-row">
				<div class="flow-node">Cesium render<div class="flow-sub">WebGL globe</div></div>
				<span class="flow-plus">+</span>
				<div class="flow-node">Pane<div class="flow-sub">shell layers + chrome</div></div>
				<span class="flow-plus">+</span>
				<div class="flow-node">Three overlay<div class="flow-sub">flag-gated</div></div>
			</div>
		</div>
		<div class="pillar-detail">
			<div class="detail-box good">
				<h4>✓ Solid</h4>
				<ul>
					<li>Single RAF source — no competing timers</li>
					<li>Visibility-aware — pauses when tab hidden</li>
					<li>dt clamped to 0.1s — prevents spiral-of-death</li>
					<li>10 consecutive errors → emergency reload</li>
				</ul>
			</div>
			<div class="detail-box note">
				<h4>○ Note</h4>
				<ul>
					<li>Variable timestep — fine for locked-refresh kiosk</li>
					<li>Fixed-timestep accumulator would help variable-rate displays</li>
				</ul>
			</div>
		</div>
	</section>

	<!-- ═══════════════════════════════════════════════════════════════ STATE -->
	<section>
		<h2>Pillar 2 — State</h2>
		<div class="state-diagram">
			<div class="state-box root-state">
				<div class="state-label">config ($state)</div>
				<div class="state-namespaces">
					<span>atmosphere</span><span>camera</span><span>director</span><span>world</span><span>shell</span>
				</div>
			</div>
			<div class="flow-arrow">↓ setByPath + CRDT</div>
			<div class="state-box">
				<div class="state-label">AeroWindow</div>
				<div class="state-namespaces">
					<span>location</span><span>timeOfDay</span><span>weather</span><span>$derived</span>
				</div>
			</div>
			<div class="flow-arrow">↓ Svelte context DI</div>
			<div class="state-row">
				<div class="state-box small">Pane</div>
				<div class="state-box small">Blind</div>
				<div class="state-box small">HUD</div>
				<div class="state-box small">SidePanel</div>
				<div class="state-box small">Three</div>
			</div>
		</div>
		<div class="pillar-detail">
			<div class="detail-box good">
				<h4>✓ Solid</h4>
				<ul>
					<li>One flat config tree — no nested stores, no Redux</li>
					<li>setByPath('atmosphere.clouds.density', 0.5) — one function writes anywhere</li>
					<li>CRDT LWW timestamps → fleet sync across 6 Pis with no central server</li>
					<li>Prototype-pollution hardened (__proto__ / constructor / prototype rejected)</li>
					<li>Content/control split: content/ vs src/ at filesystem level</li>
				</ul>
			</div>
		</div>
	</section>

	<!-- ═══════════════════════════════════════════════════════════════ RENDERING -->
	<section>
		<h2>Pillar 3 — Rendering (Z-Layer Stack)</h2>
		<div class="z-stack">
			<div class="z-layer" style="--z:11; --alpha:0.12">
				<span class="z-num">z:11</span>
				<span class="z-name">glass</span>
				<span class="z-desc">rim depth shadow + corner vignette + rim darkening — one element, stacked gradients (was glass-recess / vignette / glass-vignette)</span>
			</div>
			<div class="z-layer wing" style="--z:7; --alpha:0.22">
				<span class="z-num">z:7</span>
				<span class="z-name">wing silhouette</span>
				<span class="z-desc">dark gradient, bank-shifted — grounds the view</span>
			</div>
			<div class="z-layer frost" style="--z:5; --alpha:0.28">
				<span class="z-num">z:5</span>
				<span class="z-name">frost overlay</span>
				<span class="z-desc">altitude-gated ice crystals at 25K–40K ft</span>
			</div>
			<div class="z-layer micro" style="--z:3; --alpha:0.34">
				<span class="z-num">z:3</span>
				<span class="z-name">micro-events</span>
				<span class="z-desc">birds, shooting stars, contrails — moments of surprise</span>
			</div>
			<div class="z-layer storm" style="--z:2; --alpha:0.40">
				<span class="z-num">z:2</span>
				<span class="z-name">lightning + rain</span>
				<span class="z-desc">radial-gradient flash, CSS streak layers</span>
			</div>
			<div class="z-layer clouds" style="--z:1; --alpha:0.46">
				<span class="z-num">z:1</span>
				<span class="z-name">cloud sprites</span>
				<span class="z-desc">CSS3D / ArtsyClouds — weather-tuned density</span>
			</div>
			<div class="z-layer cesium" style="--z:0; --alpha:0.55">
				<span class="z-num">z:0</span>
				<span class="z-name">Cesium × WebGL</span>
				<span class="z-desc">terrain · OSM buildings · NASA VIIRS night lights · car-lights billboards</span>
			</div>
		</div>
		<div class="pillar-detail">
			<div class="detail-box good">
				<h4>✓ Solid</h4>
				<ul>
					<li>Z-order is local to Pane.svelte — no shared z-table, each layer declares its own stacking</li>
					<li>Single mount point: effect layers composed directly in shell/pane/Pane.svelte</li>
					<!-- `&#123;#if&#125;` is escaped: written literally, Svelte parses it as a
					     real block-open and the whole page fails to compile. -->
					<li>Adding an effect = a component plus an <code>&#123;#if&#125;</code> mount in Pane.svelte</li>
					<li>Cesium exposure / Three post — no CSS filter over WebGL (was a GPU thrash)</li>
					<li>Operator chrome (SidePanel) vs passenger chrome (HUD/clock) gated by fleet role SSOT</li>
				</ul>
			</div>
		</div>
	</section>
