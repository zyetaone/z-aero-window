<!-- WikiNightDecisions — wiki section, extracted verbatim from +page.svelte. -->
	<!-- ═══════════════════════════════════════════════════════════════ NIGHT -->
	<section>
		<h2>Pillar 7 — The Night Pipeline</h2>
		<p class="hidden-blurb">Simplified Phase 15.5 (2026-05-21). The CartoDB Dark imagery overlay was dropped — the post-process shader's <code>mix()</code> to navy now carries the atmospheric darkening that layer used to provide. Three imagery layers → two; five shader ops → three. Same blue-hour beat, same VIIRS terminator-awareness, fewer moving parts. See <code>docs/ADR-003-night-pipeline-simplification.md</code>.</p>
		<div class="night-stages">
			<div class="night-stage">
				<span class="stage-num">1</span>
				<div>
					<h4>Base Saturation Lerp</h4>
					<p>EOX satellite imagery saturation lerped 1.4 → 0.05 at night. Brightness lerp dropped — the shader's mix() does the darkening now. Near-greyscale prevents green hue cast at deep night.</p>
				</div>
			</div>
			<div class="night-stage">
				<span class="stage-num">2</span>
				<div>
					<h4>VIIRS Night Lights</h4>
					<p>NASA city lights smoothstep in at 0.55–0.9, capped at 50% alpha. Terminator-aware (<code>dayAlpha=0</code> / <code>nightAlpha=1</code>) so lit cities stay lit. City-by-city reveal as night deepens.</p>
				</div>
			</div>
			<div class="night-stage">
				<span class="stage-num">3</span>
				<div>
					<h4>Cesium HDR + Bloom</h4>
					<p>Built-in tonemap (contrast 128, brightness −0.3, sigma 2.2). Handles the shadow crush + contrast that the shader used to do redundantly.</p>
				</div>
			</div>
			<div class="night-stage">
				<span class="stage-num">4</span>
				<div>
					<h4>Post-Process Shader (3 ops)</h4>
					<p><strong>brightGuard</strong> protects VIIRS amber + sun disc. <strong>Base mix to navy</strong> via smoothstep(0.45, 0.9) — replaces the dropped CartoDB layer's atmospheric ramp. <strong>Pollution corona</strong> on bright pixels for the warm city halo. That's it.</p>
				</div>
			</div>
			<div class="night-stage">
				<span class="stage-num">5</span>
				<div>
					<h4>Per-Effect Visibility</h4>
					<p>Car lights appear at nightFactor > 0.2. Haze switches color palette by sky state. Each effect independently gates on night progression.</p>
				</div>
			</div>
		</div>
		<div class="pillar-detail">
			<div class="detail-box good">
				<h4>✓ The Magic</h4>
				<ul>
					<li>Smoothstep gates — linear interpolation would reveal banding; smoothstep hides the transition</li>
					<li>VIIRS floor at 0.55 prevents "magenta leak" from colorToAlpha on bright city cores at early dusk</li>
					<li>Shader gate at 0.45 — atmospheric darkening naturally precedes visible city lights by 30+ min (same beat the CartoDB layer used to provide, now inline)</li>
					<li>Viewer never sees a transition — they just notice the city lights are on</li>
				</ul>
			</div>
			<div class="detail-box good">
				<h4>↗ Queued for post-hardware-validation</h4>
				<ul>
					<li><strong>Phase 3</strong> — altitude-aware buildings emissive (Cesium3DTileColorBlendMode.HIGHLIGHT)</li>
					<li><strong>Phase 4–5</strong> — vector OSM roads as night light source (`/api/roads/:city` + pre-bake + GeoJsonDataSource + PolylineGlow)</li>
					<li><strong>Phase 6</strong> — altitude-gate VIIRS to fade below 5km so vector roads own the city-light load at low altitude</li>
					<li>Reference: "the passenger window, not the satellite" — buildings + roads as light SOURCES, not light-on-ground</li>
				</ul>
			</div>
		</div>
	</section>

	<!-- ═══════════════════════════════════════════════════════════════ TRADE-OFFS -->
	<section>
		<h2>Trade-offs — The Decisions Behind the Design</h2>
		<p class="hidden-blurb">Every architectural choice is a rejection of alternatives. These are the key decisions that shaped the codebase — what was chosen, what was rejected, and why.</p>
		<div class="tradeoff-table">
			<div class="tradeoff-row header">
				<span>Decision</span><span>Chosen</span><span>Rejected</span><span>Why</span>
			</div>
			<div class="tradeoff-row"><span>Timestep</span><span>Variable dt (RAF)</span><span>Fixed accumulator</span><span>Pi kiosk runs locked refresh; simplicity wins</span></div>
			<div class="tradeoff-row"><span>CRDT clock</span><span>Wall-clock Date.now()</span><span>Vector clocks / HLC</span><span>6 Pis on same LAN with NTP; drift risk accepted</span></div>
			<div class="tradeoff-row"><span>Transport</span><span>SSE + REST</span><span>WebSocket <span class="tr-note">(removed post-WS)</span></span><span>SSE is standard, debuggable, no custom framing</span></div>
			<div class="tradeoff-row"><span>State</span><span>Flat $state tree</span><span>Redux / stores</span><span>Svelte 5 runes are the reactivity primitive</span></div>
			<div class="tradeoff-row"><span>Rendering</span><span>CSS effects over WebGL</span><span>All-WebGL</span><span>CSS is lighter on Pi GPU; compositor thread is free</span></div>
			<div class="tradeoff-row"><span>Fleet</span><span>mDNS + LAN REST</span><span>Central server</span><span>Offline-first; no internet dependency</span></div>
			<div class="tradeoff-row"><span>Config sync</span><span>CRDT LWW per-path</span><span>OT / state machine</span><span>LWW is simple, path-granular, no server</span></div>
			<div class="tradeoff-row"><span>Auth</span><span>Bearer token, constant-time compare</span><span>JWT / OAuth</span><span>Pi may lack clock sync at boot; dead-simple</span></div>
			<div class="tradeoff-row"><span>Content</span><span>TypeScript union files</span><span>JSON / YAML / CMS</span><span>TypeScript narrows LocationId union automatically</span></div>
		</div>
	</section>

	<!-- ═══════════════════════════════════════════════════════════════ CONSTRAINTS -->
	<section>
		<h2>Constraints — The Box the Architecture Fits In</h2>
		<div class="constraint-grid">
			<div class="constraint-card">
				<h4>Hardware</h4>
				<p>Raspberry Pi 5, 8 GB RAM. Chromium kiosk mode. Single 1080p or 4K display. No dedicated GPU — WebGL runs on the VideoCore VII.</p>
			</div>
			<div class="constraint-card">
				<h4>Network</h4>
				<p>LAN-only fleet — 6 Pis on a private VLAN. No internet dependency except Cesium terrain tiles. mDNS for discovery. REST for admin. Offline-capable with pre-cached tiles.</p>
			</div>
			<div class="constraint-card">
				<h4>Deployment</h4>
				<p>Route-split client output (SvelteKit default), so the kiosk route never parses the admin or lab UI. No service worker. No CDN. Kiosk boots directly into Chromium pointed at localhost:3000.</p>
			</div>
			<div class="constraint-card">
				<h4>Interaction</h4>
				<p>Touch-only kiosk — no keyboard, no mouse. Cursor hidden globally. One passenger gesture (blind drag). Admin access via LAN browser on a laptop.</p>
			</div>
			<div class="constraint-card">
				<h4>Content</h4>
				<p>Curated by non-engineers. Adding a location must not touch control-plane code. TypeScript unions widen automatically. Shows are the curation primitive.</p>
			</div>
			<div class="constraint-card">
				<h4>Reliability</h4>
				<p>Runs 24/7 on a corridor wall. Must survive power cycles, NTP desync, LAN partitions, browser crashes. Emergency reload after 10 consecutive RAF errors.</p>
			</div>
		</div>
	</section>

	<!-- ═══════════════════════════════════════════════════════════════ OMISSIONS -->
	<section>
		<h2>Deliberately Not Built</h2>
		<p class="hidden-blurb">What a codebase doesn't build is as architectural as what it does. These are explicit omissions — rejected with intent, not overlooked.</p>
		<div class="omission-list">
			<div class="omission-item">
				<h4>No ECS</h4>
				<p>Entity-Component-System is overkill for a single-entity product. The window IS the entity. There is no second entity to justify the pattern. What we <em>do</em> have is the Subsystem Manager Pattern (8 leaf subsystems in <code>src/lib/world/</code>) — the conceptual sibling of ECS for the single-entity case. Manager per Cesium primitive; orchestrator fans ticks.</p>
			</div>
			<div class="omission-item">
				<h4>No event queue</h4>
				<p>The RAF tick is synchronous — flight, motion, director, and rendering run in lockstep each frame. No deferred events, no message bus between systems. Simplicity over flexibility.</p>
			</div>
			<div class="omission-item">
				<h4>No server authority</h4>
				<p>State is browser-side ($state). The Bun server is a relay — it forwards REST patches to the local browser via SSE, but has no state of its own beyond the peer registry. No database. No session store.</p>
			</div>
			<div class="omission-item">
				<h4>No WebSocket</h4>
				<p>Deliberately removed in the post-WS cleanup. Replaced with SSE (server → browser) + REST (admin → device). Fewer lines, standard protocols, no custom framing, no reconnect state machine.</p>
			</div>
			<div class="omission-item">
				<h4>No WebRTC</h4>
				<p>Peer-to-peer between Pis was considered and rejected. Admin is the natural hub — a laptop on the LAN pushing config patches via REST. P2P adds NAT traversal complexity for zero gain.</p>
			</div>
			<div class="omission-item">
				<h4>No service worker</h4>
				<p>Single-bundle output makes SW caching unnecessary — there's one JS file to load. Offline tile caching is filesystem-based (PMTiles), not SW-based. Kiosk never navigates away from /.</p>
			</div>
		</div>
	</section>
