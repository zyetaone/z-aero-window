<!-- WikiHiddenVerdict — wiki section, extracted verbatim from +page.svelte. -->
<script lang="ts">
	import {
		PRODUCT_CREDIT_BLURB,
	} from '$lib/credits';
</script>

	<!-- ═══════════════════════════════════════════════════════════════ HIDDEN PILLARS -->
	<section>
		<h2>The Hidden Pillars — Time + Networking</h2>
		<p class="hidden-intro">An earlier framing of this document named Audio as the missing pillar. An ultrathink audit (2026-05-20) showed the real missing pillars sit closer to the load-bearing centre — they're not absent, they're hiding inside other pillars, doing real work with no owner. The v1 framing is preserved at <code>docs/ARCHITECTURE-original-framing.md</code>.</p>

		<h3 class="hidden-h3">Hidden Pillar 8 — Time</h3>
		<p class="hidden-blurb">Six consumers, no owner. A <code>$state(12)</code> field plus thresholds in <code>night/index.ts</code>. Every smoothstep night gate is a function of <code>timeOfDay</code>. The triptych sync between three Pis depends on three independent <code>Date.now()</code> readings, padded by 2.5s to absorb drift. Promoting Time to its own module is the cheapest structural fix in the codebase.</p>
		<div class="audio-map">
			<div class="audio-pair">
				<span class="audio-source">Director</span>
				<span class="audio-arrow">←</span>
				<span class="audio-target">scenario + weather cycling</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">Night pipeline</span>
				<span class="audio-arrow">←</span>
				<span class="audio-target">nightFactor, skyState, dawnDuskFactor</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">Camera</span>
				<span class="audio-arrow">←</span>
				<span class="audio-target">altitude target (day vs night)</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">Sky palette</span>
				<span class="audio-arrow">←</span>
				<span class="audio-target">sodium → amber → cool → blue-white</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">Car-lights</span>
				<span class="audio-arrow">←</span>
				<span class="audio-target">visibility @ nightFactor &gt; 0.2</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">Content/Show</span>
				<span class="audio-arrow">←</span>
				<span class="audio-target">default.show.opening.timeOfDay</span>
			</div>
		</div>
		<p class="audio-note">Day 6 hardening adds the first watchdog here: <code>MIN_SANE_TIMESTAMP</code> gate on fleet connect, NTP-drift echo in heartbeat, frame-budget watchdog that auto-downgrades quality.</p>

		<h3 class="hidden-h3">Hidden Pillar 9 — Networking</h3>
		<p class="hidden-blurb">REST + SSE + CRDT + mDNS + peer-sync = <code>src/lib/fleet/</code> (12 files). The v1 framing rolls it under State's CRDT bullet — that describes the merge semantics, not the transport. Naming Networking makes field-failure modes first-class architectural concerns rather than footnotes.</p>
		<div class="detail-box good">
			<h4>✓ API security posture (v1.2)</h4>
			<ul>
				<li>18 routes, all reviewed; bearer-gated mutating endpoints fail-closed 503 when env unset</li>
				<li>Stream-counted body caps via <code>readLimitedJson</code> / <code>readLimitedBlob</code> — rejects oversized payloads mid-stream, not just by Content-Length header</li>
				<li>Auth runs BEFORE the body parser — unauthenticated callers never reach the buffer</li>
				<li>LAN-only CORS via <code>lanCorsHeaders</code>; same-origin endpoints (buildings/roads/bundle) deliberately have no CORS to keep the LAN surface small</li>
				<li>Path traversal on <code>/api/tiles/[...path]</code> defended with <code>realpathSync</code> + prefix check; hash format validated at <code>/api/bundle/[hash]</code> route boundary (defense-in-depth on top of the SSOT)</li>
				<li>Two shared helpers own the surface: <code>http/auth.ts</code> (timing-safe bearer compare) and <code>http/publish-route.ts</code> (one handler covers PATCH /api/config + POST /api/command)</li>
			</ul>
		</div>
		<div class="audio-map">
			<div class="audio-pair">
				<span class="audio-source">client.svelte.ts</span>
				<span class="audio-arrow">→</span>
				<span class="audio-target">SSE listener + REST commands</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">rest-admin.svelte.ts</span>
				<span class="audio-arrow">→</span>
				<span class="audio-target">admin store + peer discovery</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">peer-sync.svelte.ts</span>
				<span class="audio-arrow">→</span>
				<span class="audio-target">$effect → POST config to every peer</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">server/fleet/heartbeat.ts</span>
				<span class="audio-arrow">→</span>
				<span class="audio-target">60s ring buffer per device</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">parallax.svelte.ts</span>
				<span class="audio-arrow">→</span>
				<span class="audio-target">URL / fingerprint / self role binding</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">server/fleet/sse-bus.ts</span>
				<span class="audio-arrow">→</span>
				<span class="audio-target">in-process pub/sub</span>
			</div>
			<div class="audio-pair">
				<span class="audio-source">server/fleet/lan-peers.ts</span>
				<span class="audio-arrow">→</span>
				<span class="audio-target">mDNS announcement</span>
			</div>
		</div>
		<p class="audio-note">Field-failure modes that "State" doesn't capture: LAN partition, mDNS race, captive portal not dismissed, cold-boot Pi with un-converged NTP, peer not yet discovered. Day 6 + Day 7 hardening promotes these from footnotes to first-class concerns.</p>

		<h3 class="hidden-h3">What about Audio?</h3>
		<p class="hidden-blurb">Audio is a v2 feature, not the missing pillar. Implementation reality: zero <code>AudioContext</code> references in <code>src/</code>; the motion module's <code>engineVibeFreqX</code> (7Hz) / <code>engineVibeFreqY</code> (11Hz) are <em>state-update rates</em>, not waveforms — feeding <code>breathingPeriod</code> (a multi-second period) to a Web Audio oscillator gives sub-audible LFO, not engine drone. Worth doing post-ship; not architectural foundation.</p>
		<p class="hidden-blurb">
			<strong>Both hardware prerequisites are met.</strong> Output: the Waveshare panels carry
			built-in speakers, so the fleet needs no external audio hardware — the Pi 5 has no
			headphone jack and would otherwise have required a USB device per pane. Playback:
			<code>--autoplay-policy=no-user-gesture-required</code> is already set in the kiosk
			flags, so a page nobody ever clicks can still start sound.
		</p>
		<p class="hidden-blurb">
			The shape when it is built: one Web Audio gain node per layer — cabin rumble,
			weather-matched rain, chimes, music bed — with layer volumes as ordinary config leaves,
			so the admin mixer inherits the existing patch and peer-sync path rather than needing a
			second control plane. One constraint is specific to this install: a music bed must play
			on the <em>leader alone</em>. Three panes sounding the same bed a few milliseconds apart
			phase against each other, and a wall that comb-filters itself sounds broken in a way no
			single screen ever would.
		</p>
	</section>

	<!-- ═══════════════════════════════════════════════════════════════ VERDICT -->
	<section class="verdict-section">
		<h2>Verdict</h2>
		<div class="verdict-grid">
			<div class="verdict-stat">
				<span class="big-num">7+2</span>
				<span class="stat-label">pillars (built / hidden)</span>
			</div>
			<div class="verdict-stat">
				<span class="big-num">115</span>
				<span class="stat-label">source files</span>
			</div>
			<div class="verdict-stat">
				<span class="big-num">800+</span>
				<span class="stat-label">tests passing</span>
			</div>
			<div class="verdict-stat">
				<span class="big-num">15</span>
				<span class="stat-label">locations</span>
			</div>
			<div class="verdict-stat">
				<span class="big-num">10</span>
				<span class="stat-label">daily show slots</span>
			</div>
			<div class="verdict-stat">
				<span class="big-num">6</span>
				<span class="stat-label">Pis per fleet</span>
			</div>
		</div>
		<div class="verdict-body">
			<p><strong>Seven pillars stand.</strong> The architecture is clean — single RAF, single flat state tree, single compositor, single Z-source. The content pipeline is authorable by non-engineers. CRDT syncs 6 Pis without a central server.</p>
			<p><strong>Two more pillars are hiding in plain sight.</strong> Time has six consumers and no owner — every smoothstep night gate reads it, the triptych sync depends on it, no module owns it. Networking is buried under State's CRDT bullet, but it's a full fleet stack with its own failure modes — LAN partition, mDNS race, NTP drift.</p>
			<p><strong>Audio is a v2 feature, not the missing pillar.</strong> Interesting, but not load-bearing.</p>
			<p class="credit-inline">{PRODUCT_CREDIT_BLURB} Full source map: <code>docs/ARCHITECTURE.md</code>.</p>
		</div>
	</section>
