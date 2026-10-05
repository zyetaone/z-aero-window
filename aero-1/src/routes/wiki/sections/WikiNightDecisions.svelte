<!-- WikiNightDecisions — wiki section, extracted verbatim from +page.svelte. -->
	<!-- ═══════════════════════════════════════════════════════════════ NIGHT -->
	<section>
		<h2>Pillar 7 — The Night Pipeline</h2>
		<p class="hidden-blurb">Simplified in Phase 15.5 (2026-05-21); the numbers below are the current tuning, de-soaked 2026-08 (the 50% VIIRS cap read as a cream sheet, so it fell to 15% and the road lamps took the structure). The CartoDB Dark imagery overlay is gone — the grade stage's base crush now carries the atmospheric darkening that layer used to provide. Two imagery layers, one grade stage. See <code>docs/ADR-003-night-pipeline-simplification.md</code>.</p>
		<div class="night-stages">
			<div class="night-stage">
				<span class="stage-num">1</span>
				<div>
					<h4>Base Saturation Lerp</h4>
					<p>EOX satellite imagery saturation lerped 1.3 → 0.50 at night (night gamma 1.25 → 1.1). No brightness lerp — the grade stage's base crush does the darkening. The mid-floor (not near-greyscale) keeps the dusk cast while the shader desat handles deep night.</p>
				</div>
			</div>
			<div class="night-stage">
				<span class="stage-num">2</span>
				<div>
					<h4>VIIRS Night Lights</h4>
					<p>NASA city lights smoothstep in at 0.55–0.9, capped at 15% alpha (the 2026-08 de-soak: the old 50% cap pasted a cream sheet over conurbations — roads carry the structure, VIIRS carries the pooled halo). Terminator-aware (<code>dayAlpha=0</code> / <code>nightAlpha=1</code>) so lit cities stay lit. City-by-city reveal as night deepens.</p>
				</div>
			</div>
			<div class="night-stage">
				<span class="stage-num">3</span>
				<div>
					<h4>Cesium HDR + Bloom</h4>
					<p>Built-in tonemap + bloom (contrast 128, brightness −0.22, sigma 2.8 — tightened so city cores keep road strokes and window points distinct instead of pooling into one amber blur). Handles the shadow crush + contrast the shader used to do redundantly.</p>
				</div>
			</div>
			<div class="night-stage">
				<span class="stage-num">4</span>
				<div>
					<h4>Post-Process Grade (hash palette)</h4>
					<p>The shipped stage (<code>useHashPalette</code>, default on). <strong>brightGuard</strong> protects the sun disc and bright cores. <strong>VIIRS as a glow mask</strong> — <code>lightMask</code> raised to gamma 2.4, textured by district noise and a wall-clock glimmer — deals an additive sodium/amber/warm-white UV-hash palette (3% traffic-red sparks) over the lit ground. <strong>Base crush</strong> pulls the dark ground toward near-black on the same 0.45–0.9 gate, plus a pollution corona on bright pixels and a warm ambient floor. Day half: non-clipping S-curve contrast (0.35) + headroom-aware vibrance (0.20). The older 3-op <code>aero-color-grade</code> still exists but is disabled while the hash palette is active.</p>
				</div>
			</div>
			<div class="night-stage">
				<span class="stage-num">5</span>
				<div>
					<h4>Per-Effect Visibility</h4>
					<p>Road lamp bins appear at nightFactor &gt; 0.45 (<code>cityLightAmount</code>); the city glow follows at 0.58 — atmospheric darkening precedes visible lights by 30+ min. Building-window density is gated live from VIIRS sampled around the camera. Haze switches color palette by sky state.</p>
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
				<h4>✓ Shipped since this snapshot</h4>
				<ul>
					<li><strong>Building windows</strong> — per-building procedural window grid in the building shader, lit-DENSITY gated live from VIIRS sampled around the camera, Reinhard tone-mapped so gains never clip to white</li>
					<li><strong>Vector OSM road lamps</strong> — <code>/api/roads/:city</code>, one deterministic sodium/amber/cool colour per road, brightness sampled from the local VIIRS tile at each road's midpoint, wall-clock flicker per material bin</li>
					<li><strong>Altitude split</strong> — the VIIRS raster detail fades as the camera descends so the vector lamps own the city at low altitude</li>
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
			<div class="tradeoff-row"><span>CRDT clock</span><span>Wall-clock Date.now()</span><span>Vector clocks / HLC</span><span>3 Pis on same LAN with NTP; drift risk accepted</span></div>
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
				<p>LAN-only fleet — 3 Pis on a private VLAN forming one panoramic window. No internet dependency except Cesium tile fallback. mDNS for discovery. REST for admin. Offline-capable with pre-cached tiles.</p>
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
				<p>Runs 24/7 on a corridor wall. Must survive power cycles, NTP desync, LAN partitions, browser crashes. Liveness watchdog: 30 s context-lost / fps-stall check with a bounded self-heal — 3 reloads per hour, budget shared by every healing path.</p>
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
				<p>Route-split client output — the kiosk route loads only its own chunks, so a service worker caching a single bundle is a non-question. Offline tile caching is filesystem-based, not SW-based. Kiosk never navigates away from /.</p>
			</div>
		</div>
	</section>
