<!-- WikiTerms — wiki section, extracted verbatim from +page.svelte. -->
<script lang="ts">
	import {
		PRODUCT_NAME,
		PRODUCT_SHORT,
		PRODUCT_OWNER,
		ENGINEERED_BY,
	} from '$lib/credits';
</script>

	<!-- ═══════════════════════════════════════════════════════════════ TERMS -->
	<section id="terms">
		<h2>Terms of Operation</h2>
		<p class="hidden-blurb">
			What the system does, what it needs, and what it owes third parties. This is the
			<strong>operational statement of terms</strong> for the {PRODUCT_NAME} product
			({PRODUCT_OWNER}, engineered by {ENGINEERED_BY}). Where a signed supply or service
			agreement exists for an install, <em>that agreement governs</em>; this section
			describes field behaviour rather than replacing contract language.
		</p>
		<div class="omission-list">
			<div class="omission-item">
				<h4>1. Product identity</h4>
				<p>
					{PRODUCT_NAME} ({PRODUCT_SHORT}) is a {PRODUCT_OWNER} product. Engine, architecture,
					and fleet systems were engineered by {ENGINEERED_BY}. Install branding (for example
					Southwest Airlines on a fielded wall) is a customer face; it does not transfer
					software ownership or inventorship.
				</p>
			</div>
			<div class="omission-item">
				<h4>2. No people are recorded</h4>
				<p>
					There is no camera, no microphone, no sensor pointed at the room. The display is
					output-only. Nothing about who walks past it is measured, stored, or transmitted —
					the only inputs are the clock, the config tree, and an optional touch on the blind.
				</p>
			</div>
			<div class="omission-item">
				<h4>3. Telemetry stays on the LAN</h4>
				<p>
					Each device posts a heartbeat — frame rate, uptime, commit hash, recent error
					lines, optional apply-ack id — to the admin surface on the local network. It
					contains no personal data and leaves the premises only if the operator opts a
					device into a remote push worker. Apply-ack is best-effort observability
					("published ≠ applied" is the failure mode it exists to catch); it is not a
					cryptographic proof of integrity.
				</p>
			</div>
			<div class="omission-item">
				<h4>4. Network egress is bounded and listed</h4>
				<p>
					Map tiles, terrain and night-light imagery are packaged offline before install, so
					a fielded device runs on a dark LAN. When a tile is missing it falls back to its
					origin CDN. The full outbound list is NASA GIBS / VIIRS and — only when
					configured — the operator's own update worker. Imagery and terrain have no
					remote fallback on a fielded device: they are packed from open data before
					install (Copernicus Sentinel-2 COGs, AWS terrain tiles) and served from disk.
				</p>
			</div>
			<div class="omission-item">
				<h4>5. Third-party data carries attribution</h4>
				<p>
					Terrain and imagery are open data, not owned. Day imagery contains modified
					Copernicus Sentinel data (2026), which permits commercial use and requires this
					attribution; terrain is built from Mapzen / AWS Open Data elevation tiles
					(public domain); VIIRS night-lights radiance is NASA public-domain; road and
					building geometry is © OpenStreetMap contributors under ODbL. The earlier EOX
					Sentinel-2 Cloudless mosaic (CC BY-NC-SA) and CARTO basemaps are no longer
					packaged or fielded. Attribution travels with any install or screenshot that
					shows the data. Software stack credits: Svelte / SvelteKit, CesiumJS, Three.js
					(optional overlay), Bun, Raspberry Pi OS / Chromium.
				</p>
				<p>
					<strong>Audio carries no third-party licence at all.</strong> The cabin bed is
					synthesized at runtime — looped white noise shaped by a lowpass for the engine
					and a bandpass for weather — so no recording is sampled, bundled or redistributed,
					and the engine's cutoff can track altitude in a way a fixed loop cannot. The only
					exception is the optional music bed, which is a URL the operator supplies;
					whatever plays there is licensed by whoever configures it, not by this product.
				</p>
			</div>
			<div class="omission-item">
				<h4>6. Admin actions are token-gated</h4>
				<p>
					Every mutating endpoint — config patch, command fan-out, content upload, update
					trigger, WiFi reset — requires a bearer token and returns 503 when its token is
					unset, so an unconfigured device fails closed rather than open. Holding the token
					means holding control of the wall; it is the operator's to protect. Fleet
					heartbeat tokens are lower privilege and cannot push scenes.
				</p>
			</div>
			<div class="omission-item">
				<h4>7. Not a safety or information system</h4>
				<p>
					The view is composed, not reported. Sun position and moon phase are real; weather,
					location, altitude and traffic are authored fiction on a rotation. Nothing on the
					screen should be read as a forecast, a flight, or a status board. Do not use the
					wall for emergency egress guidance, operational aviation, or medical environments
					that require certified displays.
				</p>
			</div>
			<div class="omission-item">
				<h4>8. Operator responsibilities</h4>
				<p>
					Site power, LAN, physical security of the Pis, and protection of admin tokens
					remain the operator's. The device will keep showing its last good release without
					cloud contact; that is by design (see Lifecycle).
				</p>
			</div>
			<div class="omission-item">
				<h4>9. Warranty &amp; disclaimer (software)</h4>
				<p>
					Unless a signed agreement says otherwise, the software is provided for the
					supported lifecycle as-is for the intended kiosk use. {PRODUCT_OWNER} and
					{ENGINEERED_BY} disclaim liability for consequential damage from misuse, modified
					firmware, or operation outside the documented Raspberry Pi 5 kiosk profile.
				</p>
			</div>
		</div>
	</section>
