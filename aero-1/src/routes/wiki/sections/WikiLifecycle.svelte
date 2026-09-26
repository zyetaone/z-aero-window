<!-- WikiLifecycle — wiki section, extracted verbatim from +page.svelte. -->
	<!-- ═══════════════════════════════════════════════════════════════ LIFECYCLE -->
	<section id="lifecycle">
		<h2>Product Lifecycle — 6 Months</h2>
		<p class="hidden-blurb">
			The supported lifecycle for an install is <strong>six months from handover</strong>,
			covering the whole product — the Raspberry Pi 5 units and displays, the software on
			them, and the authored content they play. The date is set per install and recorded with
			the handover, not derived from this page.
		</p>
		<div class="verdict-stats">
			<div class="verdict-stat">
				<span class="big-num">6</span>
				<span class="stat-label">months supported</span>
			</div>
			<div class="verdict-stat">
				<span class="big-num">15</span>
				<span class="stat-label">min update poll</span>
			</div>
			<div class="verdict-stat">
				<span class="big-num">0</span>
				<span class="stat-label">cloud services required</span>
			</div>
		</div>
		<div class="omission-list">
			<div class="omission-item">
				<h4>During the term</h4>
				<p>
					Fixes and content ship over the air: CI gates every commit behind type-check,
					tests and a boot smoke test, then advances the <code>release</code> branch, which
					each device polls every 15 minutes and installs with automatic rollback on a bad
					build. Hardware faults in the supplied units are covered, and the admin surface
					stays supported for operator changes.
				</p>
			</div>
			<div class="omission-item">
				<h4>At end of life</h4>
				<p>
					The wall does not go dark. Updates simply stop being published — the device keeps
					running the last release it installed, with its packaged tiles, on the local
					network, indefinitely and without any service to phone home to. What ends is new
					work, not the display.
				</p>
			</div>
			<div class="omission-item">
				<h4>What is not covered</h4>
				<p>
					Operating-system and firmware patching on the fielded devices, network and power
					at the site, physical damage, and any content or location added after handover
					are the operator's, unless a maintenance term says otherwise.
				</p>
			</div>
			<div class="omission-item">
				<h4>Continuing past six months</h4>
				<p>
					Extension is a renewal, not a default — a further support term, or handover of
					the repository and provisioning scripts so the operator runs the pipeline itself.
					Both paths are deliberate: nothing in the device requires our infrastructure to
					keep working.
				</p>
			</div>
		</div>
	</section>
