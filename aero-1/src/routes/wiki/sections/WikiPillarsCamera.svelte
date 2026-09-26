<!-- WikiPillarsCamera — wiki section, extracted verbatim from +page.svelte. -->
	<!-- ═══════════════════════════════════════════════════════════════ CAMERA -->
	<section>
		<h2>Pillar 4 — Camera &amp; Motion</h2>
		<div class="camera-compare">
			<div class="camera-mode">
				<h3>Orbit Mode</h3>
				<div class="camera-viz orbit-viz">
					<div class="orbit-ring"></div>
					<div class="orbit-dot"></div>
				</div>
				<ul>
					<li>Elliptical path around city center</li>
					<li>Breathes in/out — 180s cycle</li>
					<li>Drifts at 1.4× speed</li>
					<li>Heading wanders via 3 sines</li>
					<li>Altitude seeks night vs day target</li>
				</ul>
			</div>
			<div class="camera-arrow">blind pull →</div>
			<div class="camera-mode">
				<h3>Cruise Mode</h3>
				<div class="camera-viz cruise-viz">
					<div class="cruise-trail"></div>
					<div class="cruise-dot"></div>
				</div>
				<ul>
					<li>Warp departure: smoothstep to 100× speed</li>
					<li>Blind CLOSES during transit</li>
					<li>CSS blur peaks at warpFactor × 5px</li>
					<li>2s transit → blind OPENS at destination</li>
					<li>Director resets, new scenario chosen</li>
				</ul>
			</div>
		</div>
		<div class="motion-grid">
			<div class="motion-card"><h4>Engine Vibe</h4><p>7Hz + 11Hz detuned<br/>0.35px amplitude<br/>Never repeats</p></div>
			<div class="motion-card"><h4>Turbulence</h4><p>Multi-octave noise<br/>Discrete bumps + ring decay<br/>Weather-scaled (1×–3×)</p></div>
			<div class="motion-card"><h4>Banking</h4><p>Heading delta → bank<br/>2.5× smoothing<br/>Max 6° tilt</p></div>
			<div class="motion-card"><h4>Breathing</h4><p>22s pitch oscillation<br/>±1.5°<br/>Prevents screenshot feel</p></div>
			<div class="motion-card"><h4>Altitude Seek</h4><p>Drifts to night/day target<br/>0.1× rate<br/>Night: lower over cities</p></div>
			<div class="motion-card"><h4>Frost</h4><p>25K–40K ft fade-in<br/>Ice crystal overlay<br/>Breathes at 8s cycle</p></div>
		</div>
	</section>

	<!-- ═══════════════════════════════════════════════════════════════ INPUT -->
	<section>
		<h2>Pillar 5 — Input</h2>
		<div class="input-focus">
			<div class="input-hero">
				<h3>The Blind</h3>
				<p class="big-gesture">Drag down → close blind → fly somewhere new</p>
			</div>
			<div class="input-details">
				<div class="input-item"><strong>Primary</strong> Drag the pull-down shade</div>
				<div class="input-item"><strong>Keyboard</strong> Enter / Space toggles blind</div>
				<div class="input-item"><strong>Touch</strong> Long-press → 3× speed acceleration</div>
				<div class="input-item"><strong>Discover</strong> Animated chevrons → timed hint → auto-dismiss</div>
				<div class="input-item"><strong>Chrome</strong> F key → toggle window frame</div>
				<div class="input-item"><strong>Debug</strong> Shift+T → telemetry panel</div>
			</div>
		</div>
		<div class="pillar-detail">
			<div class="detail-box good">
				<h4>✓ Design Philosophy</h4>
				<ul>
					<li>One <em>passenger</em> physical metaphor — not "click here," "pull the shade"</li>
					<li>Discoverable without words — the handle animates, the chevrons cascade</li>
					<li>Satisfying to perform — maps to a real-world action everyone knows</li>
					<li>Long-press accel, keyboard, URL params, Shift+T, side panel — all real, all deliberately invisible to passengers</li>
					<li>The honest framing isn't "ONE gesture" — it's "one gesture for the cabin, everything else for the operator"</li>
					<li>Ambient, not tutorial — viewer discovers it or doesn't; either is fine</li>
				</ul>
			</div>
		</div>
	</section>

	<!-- ═══════════════════════════════════════════════════════════════ CONTENT -->
	<section>
		<h2>Pillar 6 — Content Pipeline</h2>
		<div class="content-split">
			<div class="content-side control">
				<h3>src/ — Control Plane</h3>
				<div class="file-tree">
					<div class="ft-item">lib/world/ — Cesium + Three overlay</div>
					<div class="ft-item">lib/flight/ — Flight + motion sim</div>
					<div class="ft-item">lib/director/ — Autopilot + scenarios</div>
					<div class="ft-item">lib/bundle/ — Content-bundle wire types</div>
					<div class="ft-item">lib/shell/ — pane · passenger · operator · window</div>
					<div class="ft-item">lib/fleet/ — Multi-Pi networking</div>
					<div class="ft-item">lib/model/ — State, CRDT, telemetry</div>
				</div>
				<span class="split-label">Engineers</span>
			</div>
			<div class="content-divider">⟷</div>
			<div class="content-side authored">
				<h3>content/ — Authored Artifacts</h3>
				<div class="file-tree">
					<div class="ft-item">locations/ — 14 cities + natural wonders</div>
					<div class="ft-item">weather/ — 5 recipes (clear→storm)</div>
					<div class="ft-item">scenarios/ — 21 hand-crafted flight paths</div>
					<div class="ft-item">palettes/ — Sky + car-light color tables</div>
					<div class="ft-item">shows/ — Opening experience</div>
				</div>
				<span class="split-label">Curators</span>
			</div>
		</div>
		<div class="pillar-detail">
			<div class="detail-box good">
				<h4>✓ Rule 0 — Content/Control Split</h4>
				<ul>
					<li>Adding a location: one object in catalog.ts — LocationId union widens automatically</li>
					<li>Adding a scenario: one object in scenarios/catalog.ts — director picks it up</li>
					<li>Adding a weather type: one entry in recipes.ts + one union member — no code changes</li>
					<li>Shows are the curation primitive — opening state today, narrative arcs tomorrow</li>
				</ul>
			</div>
		</div>
	</section>
