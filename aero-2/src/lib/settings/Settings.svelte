<script lang="ts">
	/**
	 * Settings — Operator Tuning Drawer & System Diagnostics Panel.
	 * Categorized into 3 operator tabs (flight, cabin, wall) with dual range/number inputs and toggle switches.
	 */
	import { useDisplay } from '../display/display.svelte.js';
	import { Location, LOCATIONS } from './locations.js';
		import { FLEET_ROLES, AUDIO_MODES } from './settings.svelte.js';
	import { DWELL_SEC } from '../display/flight/flight-path.js';

	import { fetchStatus, type KioskStatus } from '#lib/status.js';
	import { formatClock } from '#lib/format.js';
	import Knob from './Knob.svelte';
	import Toggle from './Toggle.svelte';
	import Segmented from './Segmented.svelte';
	import Wall from './Wall.svelte';

	interface Props {
		showSettings?: boolean;
		showAdmin?: boolean;
	}

	let { showSettings = $bindable(false), showAdmin = $bindable(false) }: Props = $props();

	const display = useDisplay();
	const config = display.config;
	const cities = Location.cities();
	const features = Location.features();

	type TabId = 'flight' | 'cabin' | 'wall';
	let activeTab = $state<TabId>('flight');

	// `formatClock`, not a private stamp: this drawer's copy ROUNDED the
	// minutes while the Hud floored them, so the two clocks on one pane could
	// disagree by a minute for thirty seconds at a time.
	const clockLabel = $derived.by(() => {
		const stamp = formatClock(display.view.timeOfDay);
		const off = config.clockOffsetH;
		return off === 0 ? `${stamp} local` : `${stamp} · ${off > 0 ? '+' : ''}${off}h`;
	});

	let networkStatus = $state<KioskStatus | null>(null);
	let networkError = $state<string | null>(null);

	/**
	 * The panel used to swallow this failure and render `127.0.0.1` from a `||`
	 * fallback further down -- a plausible address, presented as measured, when
	 * in fact nothing had been reached. Aborted on teardown so toggling the
	 * panel cannot race two responses into the same field.
	 */
	$effect(() => {
		if (!showAdmin) return;
		const ctrl = new AbortController();
		fetchStatus(ctrl.signal)
			.then((data) => {
				networkStatus = data;
				networkError = null;
			})
			.catch((err: unknown) => {
				if (err instanceof Error && err.name === 'AbortError') return;
				networkStatus = null;
				networkError = err instanceof Error ? err.message : 'unreachable';
			});
		return () => ctrl.abort();
	});

	function reload() {
		if (typeof window !== 'undefined') window.location.reload();
	}
</script>

{#snippet tuningDrawer()}
	<aside class="glass-pane right">
		<header class="header">
			<h3>Settings & Operator Tuning</h3>
			<button
				type="button"
				class="close-btn"
				onclick={() => (showSettings = false)}
				aria-label="Close settings">✕</button
			>
		</header>

		<!-- Three tabs. The camera, airframe, atmosphere and terrain tabs
		     went in the Sep-22 simplification: nineteen knobs nobody at the wall
		     should touch. The fields and URL knobs still exist for tuning. -->
		<nav class="tab-bar">
			<button
				type="button"
				class="tab-btn"
				class:active={activeTab === 'flight'}
				onclick={() => (activeTab = 'flight')}>✈️ Flight</button
			>
			<button
				type="button"
				class="tab-btn"
				class:active={activeTab === 'cabin'}
				onclick={() => (activeTab = 'cabin')}>🎛️ Cabin</button
			>
			<button
				type="button"
				class="tab-btn"
				class:active={activeTab === 'wall'}
				onclick={() => (activeTab = 'wall')}>🧱 Wall</button
			>
		</nav>

		<div class="content">
			{#if activeTab === 'flight'}
				<section class="section">
					<h4>Destination Selector</h4>
					<div class="location-select-wrap">
						<select
							class="glass-select"
							value={config.place.id}
							onchange={(e) => {
								const loc = Location.byId(e.currentTarget.value);
								if (loc) config.setPlace(loc);
							}}
							aria-label="Select destination"
						>
							<optgroup label="Cities (Orbital Tour)">
								{#each cities as city}
									<option value={city.id}>{city.name} ({city.groundElevationM}m MSL)</option>
								{/each}
							</optgroup>
							<optgroup label="Natural Features (Cross-Country)">
								{#each features as feat}
									<option value={feat.id}>{feat.name} ({feat.groundElevationM}m MSL)</option>
								{/each}
							</optgroup>
						</select>
					</div>

				</section>

				<section class="section">
					<h4>Conditions</h4>
					<!-- Rotation and weather are wall keys; they are set from the Wall tab
					     so all three panes change together (ADR-007). A local weather
					     control lived here and split the panorama. -->
					<Knob
						{config}
						key="clockOffsetH"
						label="Circadian Time of Day"
						step={0.25}
						format={() => clockLabel}
					/>
				</section>
			{:else if activeTab === 'cabin'}
				<section class="section">
					<h4>Cabin Chrome & Soundscape</h4>
					<Toggle
						checked={config.blindOpen}
						label="Window Blind Open"
						description="Motorized passenger window blind"
						onchange={(val) => (config.blindOpen = val)}
					/>
					<Toggle
						checked={config.miniMapVisible}
						label="Route Map"
						description="The inset showing the orbit, the aircraft and the terrain strip"
						onchange={(val) => (config.miniMapVisible = val)}
					/>
					<Toggle
						checked={config.audioEnabled}
						label="Cabin Audio Soundscape"
						description="Jet engine turbine drone and atmospheric airflow"
						onchange={(val) => (config.audioEnabled = val)}
					/>

					{#if config.audioEnabled}
						<Segmented
							label="Audio Source"
							options={AUDIO_MODES}
							isActive={(m) => config.audioMode === m}
							onselect={(m) => (config.audioMode = m)}
							format={(m) => (m === 'synth' ? 'SYNTH ENGINE' : 'AUDIO PLAYLIST')}
						/>

						<Knob
							{config}
							key="audioVolume"
							label="Audio Volume"
							step={0.05}
							format={(v) => `${Math.round(v * 100)}%`}
						/>
					{/if}
				</section>

				<Segmented
					label="Render Quality"
					options={['performance', 'balanced', 'ultra'] as const}
					isActive={(q) => config.qualityMode === q}
					onselect={(q) => (config.qualityMode = q)}
				/>

				<Segmented
					label="Multi-Pi Fleet Parallax Role"
					options={FLEET_ROLES}
					isActive={(role) => config.fleetRole === role}
					onselect={(role) => (config.fleetRole = role)}
				/>
			{:else if activeTab === 'wall'}
				<Wall {config} wall={display.wall} nowSec={() => display.view.wallSec} />
			{/if}
		</div>
	</aside>
{/snippet}

{#snippet adminDrawer()}
	<aside class="glass-pane left">
		<header class="header">
			<h3>Admin & System Diagnostics</h3>
			<button
				type="button"
				class="close-btn"
				onclick={() => (showAdmin = false)}
				aria-label="Close admin">✕</button
			>
		</header>

		<div class="content">
			<section class="section">
				<h4>System Telemetry</h4>
				<div class="diag-list">
					<div class="diag-item">
						<span class="diag-label">FPS Target:</span>
						<span class="diag-value">{Math.round(display.fps)} FPS</span>
					</div>
					<div class="diag-item">
						<span class="diag-label">Frame Time:</span>
						<span class="diag-value">{display.frameTimeMs.toFixed(1)} ms</span>
					</div>
					<div class="diag-item">
						<!--
							Terrain clearance is the codebase's classic silent failure: when no
							DEM tile decodes, the query returns nothing, the regional mean wins,
							and the camera flies a plausible altitude over flat ground. Nothing
							throws. This line is the only place that absence is visible.
						-->
						<span class="diag-label">Terrain sampled:</span>
						<span
							class="diag-value"
							class:warn={display.terrain.sampled + display.terrain.fallback > 60 &&
								display.terrainSampledPct < 50}
						>
							{display.terrainSampledPct.toFixed(0)}% ({display.terrain.sampled}/{display.terrain
								.sampled + display.terrain.fallback})
						</span>
					</div>
					<div class="diag-item">
						<span class="diag-label">Altitude:</span>
						<span class="diag-value">{display.view.aglM.toLocaleString()} m AGL</span>
					</div>
					<div class="diag-item">
						<span class="diag-label">Flight Heading:</span>
						<span class="diag-value">{Math.round(display.view.planeHeadingDeg)}°</span>
					</div>
				</div>
			</section>

			{#if networkStatus}
				<section class="section">
					<h4>Network Host Discovery</h4>
					<div class="diag-list">
						<div class="diag-item">
							<span class="diag-label">Hostname:</span>
							<span class="diag-value">{networkStatus.hostname}</span>
						</div>
						<div class="diag-item">
							<span class="diag-label">Primary IP:</span>
							<span class="diag-value"
								>{networkStatus?.primaryLanIp ??
									(networkError ? `unreachable — ${networkError}` : '…')}</span
							>
						</div>
						<div class="diag-item">
							<span class="diag-label">Port:</span>
							<span class="diag-value">{networkStatus.port}</span>
						</div>
					</div>
				</section>
			{/if}

			<section class="section">
				<h4>Kiosk Actions</h4>
				<div class="action-buttons">
					<button type="button" class="glass-btn primary" onclick={reload}> 🔄 Soft Reload </button>
					<a
						href="/admin"
						class="glass-btn secondary"
						style="text-align: center; text-decoration: none;"
					>
						🖥️ Open Fleet Cockpit
					</a>
				</div>
			</section>
		</div>
	</aside>
{/snippet}

<!-- Floating Operator Quick-Access Trigger Buttons (Top-Right) -->
<div class="operator-triggers" aria-label="Operator Controls">
	<button
		type="button"
		class="trigger-btn"
		class:active={showSettings}
		onclick={() => (showSettings = !showSettings)}
		title="Open Operator Settings (Hotkey: S)"
		aria-label="Toggle Operator Settings"
	>
		⚙️ <span class="trigger-label">Settings</span>
	</button>

	<button
		type="button"
		class="trigger-btn"
		class:active={showAdmin}
		onclick={() => (showAdmin = !showAdmin)}
		title="Open Telemetry & Admin (Hotkey: A)"
		aria-label="Toggle Telemetry Panel"
	>
		📊 <span class="trigger-label">Telemetry</span>
	</button>
</div>

{#if showSettings}
	{@render tuningDrawer()}
{/if}

{#if showAdmin}
	{@render adminDrawer()}
{/if}

<style>
	.operator-triggers {
		position: fixed;
		top: 1rem;
		right: 1.25rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		z-index: 90;
		pointer-events: auto;
	}

	.trigger-btn {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.45rem 0.85rem;
		font-size: 0.82rem;
		font-weight: 500;
		color: rgba(255, 255, 255, 0.9);
		background: rgba(11, 17, 30, 0.75);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 9999px;
		cursor: pointer;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
		transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
		user-select: none;
	}

	.trigger-btn:hover {
		background: rgba(56, 189, 248, 0.25);
		border-color: rgba(56, 189, 248, 0.6);
		color: #ffffff;
		transform: translateY(-1px);
		box-shadow: 0 6px 20px rgba(56, 189, 248, 0.25);
	}

	.trigger-btn.active {
		background: rgba(56, 189, 248, 0.35);
		border-color: var(--accent-cyan);
		color: #ffffff;
	}

	.trigger-label {
		font-size: 0.78rem;
		letter-spacing: 0.02em;
	}

	.glass-pane {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 380px;
		background: rgba(11, 17, 30, 0.88);
		backdrop-filter: blur(16px);
		border: 1px solid var(--glass-border);
		z-index: 100;
		display: flex;
		flex-direction: column;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
		color: var(--text-primary);
	}
	.glass-pane.right {
		right: 0;
		border-right: none;
	}
	.glass-pane.left {
		left: 0;
		border-left: none;
	}

	.header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 1rem 1.25rem;
		border-bottom: 1px solid rgba(255, 255, 255, 0.1);
	}
	.header h3 {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.close-btn {
		background: none;
		border: none;
		color: var(--text-muted);
		font-size: 1.2rem;
		cursor: pointer;
		padding: 4px;
	}
	.close-btn:hover {
		color: #ffffff;
	}

	.tab-bar {
		display: flex;
		overflow-x: auto;
		background: rgba(0, 0, 0, 0.25);
		border-bottom: 1px solid var(--glass-border-subtle);
		padding: 4px 8px;
		gap: 4px;
		scrollbar-width: none;
	}
	.tab-btn {
		background: none;
		border: none;
		padding: 6px 10px;
		color: var(--text-muted);
		font-size: 0.78rem;
		font-weight: 500;
		border-radius: 4px;
		cursor: pointer;
		white-space: nowrap;
		transition: all 0.15s ease;
	}
	.tab-btn:hover {
		color: var(--text-primary);
		background: rgba(255, 255, 255, 0.05);
	}
	.tab-btn.active {
		color: #ffffff;
		background: var(--accent-cyan, #38bdf8);
		font-weight: 600;
	}

	.content {
		flex: 1;
		overflow-y: auto;
		padding: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
	}

	.section {
		display: flex;
		flex-direction: column;
		gap: 0.8rem;
	}
	.section h4 {
		margin: 0;
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-muted);
		border-bottom: 1px solid var(--glass-border-subtle);
		padding-bottom: 0.4rem;
	}


	.glass-select {
		width: 100%;
		padding: 8px 12px;
		background: rgba(0, 0, 0, 0.45);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 6px;
		color: #ffffff;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.glass-select:focus {
		outline: none;
		border-color: var(--accent-cyan, #38bdf8);
	}
	.glass-select option,
	.glass-select optgroup {
		background: #0f172a;
		color: #ffffff;
	}

	.diag-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		background: rgba(0, 0, 0, 0.3);
		padding: 10px;
		border-radius: 6px;
		border: 1px solid var(--glass-border-subtle);
	}
	.diag-item {
		display: flex;
		justify-content: space-between;
		font-size: 0.8rem;
	}
	.diag-label {
		color: var(--text-muted);
	}
	.diag-value.warn {
		color: #ffb454;
	}

	.diag-value {
		color: var(--text-primary);
		font-family: monospace;
	}

	.action-buttons {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.glass-btn {
		padding: 8px 14px;
		border-radius: 6px;
		font-size: 0.82rem;
		font-weight: 500;
		cursor: pointer;
		transition: all 0.15s ease;
		border: 1px solid rgba(255, 255, 255, 0.15);
	}
	.glass-btn.primary {
		background: var(--accent-cyan, #38bdf8);
		color: #0b111e;
		font-weight: 600;
	}
	.glass-btn.secondary {
		background: var(--glass-border-subtle);
		color: #ffffff;
	}
	.glass-btn:hover {
		opacity: 0.9;
	}
</style>
