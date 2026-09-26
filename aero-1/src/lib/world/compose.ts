/**
 * CesiumManager — thin orchestrator for the Cesium globe.
 *
 * Delegates to reactive feature modules:
 *   imagery.ts    — base imagery, VIIRS (+ the shared road alpha curve)
 *   roads-geojson — ODbL vector night street grid (replaced the CartoDB raster)
 *   buildings.ts  — OSM 3D Tiles + procedural shader
 *   atmosphere.ts — sky, fog, globe color, moonlight, exposure
 * Owns directly: viewer lifecycle, post-processing,
 * cloud billboards, lightning, and the per-frame render loop.
 * (Camera sync lives in ./camera — see syncCamera().)
 */

import type * as CesiumType from 'cesium';
import type { LocationId, WeatherType, QualityMode } from '$lib/types';
// Type-only: `world` is a live $state rune object, and compose.ts is a plain
// .ts module. A value import would put a runtime edge from the orchestrator to
// the reactive config module for no reason — the only use is `typeof world`
// below. `import type` erases entirely at build.
import type { world } from '$lib/model/config-tree.svelte';
import { T } from '$lib/utils';
import { syncCamera, type CameraRead, type CameraSyncSlice } from './camera';
import { COLOR_GRADE_STAGE, nightPostFxOn, qualityPaintGates } from './shaders';
import { VIEWER_OPTIONS, applySceneDefaults, CESIUM_QUALITY_PRESETS, localTilesAvailable } from './cesium-setup';
import { mountLightning, tickLightning } from './lightning-stage';
import { mountCesiumClouds, updateCesiumClouds } from './clouds/billboard-layer';
import { teardownViewerState } from './viewer-lifecycle';
import { initImagery, setupImagery, syncImagery } from './imagery';
import { initBuildings, setupBuildings, syncBuildings, syncOfflineBuildings, setBuildingsWireframe, updateBuildingsQuality } from './buildings';
import { initRoads, syncOfflineRoads } from './roads-geojson';
import { installHashPalette } from './hash-palette';
import { initAtmosphere, syncAtmosphere } from './atmosphere';
import { initTerrain, setupTerrain, syncTerrain } from './terrain';
import { lightingState } from './curves';
import { SKY_PALETTE } from '$content/palettes';

type WorldConfig = typeof world;

// The camera-facing half of this view is DERIVED from CameraSyncSlice rather
// than re-typed. It was duplicated field-for-field, so adding a term to the
// camera sync (a new motion coupling, another pose field) meant editing the
// same shape in two files, and TypeScript would happily accept them drifting
// apart — compose would still compile while passing a slice the sync no longer
// fully describes.
interface CesiumModelView extends CameraSyncSlice {
	flight: CameraSyncSlice['flight'] & {
		lat: number; lon: number; altitude: number; heading: number; pitch: number;
		warpFactor: number;
	};
	config: CameraSyncSlice['config'] & {
		camera: CameraSyncSlice['config']['camera'] & {
			parallax: { fovDeg: number };
		};
		world: WorldConfig;
		atmosphere: {
			haze: { amount: number };
			clouds: { density: number; speed: number; layerCount: number };
			weather: {
				hasLightning: boolean; lightningDecayRate: number;
				lightningMinInterval: number; lightningMaxInterval: number;
				filterBrightness: number;
			};
		};
	};
	timeOfDay: number; nightFactor: number; dawnDuskFactor: number;
	nightLightScale: number; qualityMode: QualityMode;
	location: LocationId; weather: WeatherType;
	/** Needed for SKY_PALETTE.filterBrightness → Cesium exposure. */
	skyState: import('$lib/types').SkyState;
	sceneFog: { dayDensity: number; nightDensity: number; dayBrightness: number; nightBrightness: number };
	terrainExaggeration: number;
}

export class CesiumManager {
	readonly #C: typeof CesiumType;
	readonly #model: CesiumModelView;
	readonly #viewer: CesiumType.Viewer;

	// Lightning stage is module-level state in lightning-stage.ts (not tracked here).
	// Cesium clouds are module-level state in clouds/billboard-layer.ts (not tracked here).
	#colorGradeStage: CesiumType.PostProcessStage | null = null;
	#lastQualityMode: QualityMode | null = null;
	#lastColorGradeEnabled: boolean | null = null;
	// Night post-FX latch. Read per tick with hysteresis (nightPostFxOn) and
	// folded into #syncQuality's memo key, so bloom + grade install once at
	// dusk and uninstall once at dawn instead of every frame.
	#nightFxOn = false;
	#lastNightFxOn: boolean | null = null;
	// Hash-palette stage lifecycle — installed/uninstalled reactively in
	// #syncQuality when config.world.useHashPalette changes, not once at boot.
	#hashPaletteCleanup: (() => void) | null = null;
	#lastUseHashPalette: boolean | null = null;

	// Clock-change gates — owned here; #syncClockCheck is their only consumer.
	#lastTimeOfDay = -1;
	#lastClockLon = -999;

	#lastPostRenderTime = performance.now();
	#boundTick: (() => void) | null = null;
	#started = false;

	#bootStartMs: number | null = null;
	static readonly BOOT_FADE_MS = 1600;
	#getBootFade(): number {
		if (this.#bootStartMs === null) this.#bootStartMs = performance.now();
		const t = (performance.now() - this.#bootStartMs) / CesiumManager.BOOT_FADE_MS;
		return t >= 1 ? 1 : t < 0 ? 0 : t;
	}
	#scratchDest: CesiumType.Cartesian3 | null = null;
	// Scratch for getCameraRead() — mutated in place at 60Hz, never reallocated.
	#cameraReadScratch: CameraRead = {
		position: { x: 0, y: 0, z: 0 },
		direction: { x: 0, y: 0, z: 0 },
		up: { x: 0, y: 0, z: 0 },
		fovDeg: NaN,
	};
	// Epsilon gate for the parallax fov write in #syncCamera.
	#lastFovDeg = -1;
	constructor(model: CesiumModelView, CesiumModule: typeof CesiumType, container: HTMLElement) {

		this.#C = CesiumModule;
		this.#model = model;
		this.#viewer = new CesiumModule.Viewer(container, VIEWER_OPTIONS);
		initImagery(CesiumModule, this.#viewer);
		initBuildings(CesiumModule, this.#viewer);
		initRoads(CesiumModule, this.#viewer);
		initAtmosphere(CesiumModule, this.#viewer);
		initTerrain(CesiumModule, this.#viewer);
	}

	getViewer(): CesiumType.Viewer { return this.#viewer; }
	getCesium(): typeof CesiumType { return this.#C; }

	/**
	 * Camera state in a project-frame-friendly shape. CameraMirror (and any
	 * other system that needs to mirror Cesium's camera each frame) reads
	 * through this instead of reaching into `viewer.camera.positionWC`
	 * directly. Plain `{x,y,z}` objects + a scalar fov, no Cesium types.
	 *
	 * Returns the shared scratch object (#cameraReadScratch), mutated in place
	 * every call — this runs at 60Hz, so a fresh allocation per frame would
	 * defeat the module's scratch-buffer discipline. Read-and-derive
	 * synchronously; never store the reference.
	 */
	getCameraRead(): CameraRead {
		const cam = this.#viewer.camera;
		const p = cam.positionWC;
		const d = cam.directionWC;
		const u = cam.upWC;
		const fovy = (cam.frustum as { fovy: number }).fovy;
		const r = this.#cameraReadScratch;
		r.position.x = p.x; r.position.y = p.y; r.position.z = p.z;
		r.direction.x = d.x; r.direction.y = d.y; r.direction.z = d.z;
		r.up.x = u.x; r.up.y = u.y; r.up.z = u.z;
		r.fovDeg = Number.isFinite(fovy) ? (fovy * 180) / Math.PI : NaN;
		return r;
	}

	// ── Start ────────────────────────────────────────────────────────────────

	async start(COLOR_GRADING_GLSL: string): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		const C = this.#C;
		const v = this.#viewer;

		applySceneDefaults(v, C);
		// initAtmosphere runs in the constructor with the other subsystem inits.
		// Nothing between construction and here (applySceneDefaults included)
		// touches atmosphere-owned state (scene.light), so re-initing would only
		// re-snapshot the same light and re-create the same moonlight.
		this.#scratchDest = new C.Cartesian3();

		// Snap camera to flight position immediately so the first frame
		// shows terrain at the right altitude — not the default far-out globe.
		this.#syncCamera();

		this.#boundTick = this.#tick.bind(this);
		v.scene.postRender.addEventListener(this.#boundTick);

		this.#setupPostProcess(COLOR_GRADING_GLSL);
		// Hash palette is NOT installed here — #syncQuality (run at the end of
		// #setupPostProcess and every tick) installs/uninstalls it reactively
		// from config.world.useHashPalette, so runtime toggles take effect.
		await setupTerrain();
		await setupImagery();
		await setupBuildings(
			this.#model.config.world.buildingsEnabled,
			this.#model.config.world.useDynamicEnvironmentMap,
		);

		mountLightning(C, v);
		mountCesiumClouds(C, v);

		this.#syncClock();
		this.#tick();
		// Apply the configured quality preset up front. The reactive effect in
		// CesiumViewer only fires when qualityMode CHANGES, so without this the
		// globe boots at Cesium's default maximumScreenSpaceError (=2) even
		// though qualityMode defaults to 'performance'.
		this.applyQualityMode(this.#model.config.world.qualityMode);
		v.resize();
		v.scene.requestRender();
	}

	// ── Render Loop ──────────────────────────────────────────────────────────

	#tick(): void {
		const now = performance.now();
		const dt = Math.min((now - this.#lastPostRenderTime) / 1000, 0.1);
		this.#lastPostRenderTime = now;

		this.#syncCamera();
		this.#syncClockCheck();
		syncTerrain(this.#model.terrainExaggeration);
		this.#syncImagery();
		this.#syncCloudBillboards();
		this.#syncLightning(dt);
		this.#syncBuildings(dt);
		this.#syncQuality();
	}

	// ── Clock ────────────────────────────────────────────────────────────────

	#syncClock(): void {
		const C = this.#C;
		const h = ((this.#model.timeOfDay % 24) + 24) % 24;
		const utcRaw = h - this.#model.flight.lon / 15;
		const utcHour = ((utcRaw % 24) + 24) % 24;
		const now = new Date();
		this.#viewer.clock.currentTime = C.JulianDate.fromDate(
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
				Math.floor(utcHour), Math.floor((utcHour % 1) * 60))),
		);
	}

	/** Sync clock when timeOfDay or longitude changed. Then sync atmosphere. */
	#syncClockCheck(): void {
		const m = this.#model;
		if (this.#lastTimeOfDay !== m.timeOfDay || Math.abs(this.#lastClockLon - m.flight.lon) > 0.5) {
			this.#lastTimeOfDay = m.timeOfDay;
			this.#lastClockLon = m.flight.lon;
			if (this.#viewer.scene.sun)
				this.#viewer.scene.sun.show = m.timeOfDay > T.DAWN_START && m.timeOfDay < T.DUSK_END;
			this.#syncClock();
		}
		const skyFb = SKY_PALETTE[m.skyState]?.filterBrightness ?? 1;
		const weatherFb = m.config.atmosphere.weather.filterBrightness ?? 1;
		syncAtmosphere(
			{
				timeOfDay: m.timeOfDay, nightFactor: m.nightFactor, dawnDuskFactor: m.dawnDuskFactor,
				flight: { lon: m.flight.lon, camAlt: m.flight.camAlt },
				config: { world: m.config.world },
				hazeAmount: m.config.atmosphere.haze.amount,
				sceneFog: m.sceneFog,
				// Was CSS filter on Pane — now multiplies Cesium exposure only.
				filterBrightness: skyFb * weatherFb,
				warpFactor: m.flight.warpFactor,
			},
			this.#viewer.clock.currentTime,
		);
	}

	// ── Delegated syncs ──────────────────────────────────────────────────────

	#syncImagery(): void {
		const m = this.#model;
		syncImagery(
			{
				nightFactor: m.nightFactor, nightLightScale: m.nightLightScale,
				altitude: m.flight.altitude,
				config: { world: m.config.world },
			},
			this.#getBootFade(),
		);
		// Latch the night post-FX decision for #syncQuality (called later in the
		// same tick). Hysteresis lives in nightPostFxOn so the dusk crossing
		// can't thrash the stage install.
		this.#nightFxOn = nightPostFxOn(m.nightFactor, this.#nightFxOn);
		if (this.#colorGradeStage && (this.#lastQualityMode !== 'performance' || this.#nightFxOn)) {
			// Hash palette wins when enabled: the two grading stages must never
			// stack (double-grade), so color-grade stays off under useHashPalette.
			const should = m.nightFactor >= 0.001 && !m.config.world.useHashPalette;
			if (should !== this.#lastColorGradeEnabled) {
				this.#colorGradeStage.enabled = should;
				this.#lastColorGradeEnabled = should;
			}
		}
	}

	#syncBuildings(dt: number): void {
		const m = this.#model;
		// Same civil-twilight gate as wing nav lights (curves.ts cityLightAmount).
		const cityLightAmount = lightingState(m.timeOfDay, m.nightFactor).cityLightAmount;
		syncBuildings(
			dt, m.nightFactor, m.nightLightScale, m.flight.altitude,
			m.config.world.buildingsEnabled, m.config.world.windowLightIntensity,
			this.#getBootFade(),
			cityLightAmount,
		);
		// Tier 2 — no-op when the Ion tileset is present. Cheap: does nothing
		// at all unless the location changed (see syncOfflineBuildings).
		syncOfflineBuildings(
			m.location,
			m.config.world.buildingsEnabled,
			m.terrainExaggeration,
		);
		// The night street grid, on the same lifecycle as the skyline it sits
		// under. Hidden outright in daylight, so this costs nothing before dusk.
		syncOfflineRoads(
			m.location, m.nightFactor, m.nightLightScale, m.flight.altitude,
			// timeOfDay drives the lamp flicker and is ALREADY fleet-synced —
			// see roadFlicker on why a local dt accumulator would desync the wall.
			m.timeOfDay,
			this.#getBootFade(), m.terrainExaggeration,
		);
	}

	#syncCloudBillboards(): void {
		const m = this.#model;
		updateCesiumClouds(
			m.flight.lat, m.flight.lon, m.weather,
			m.config.atmosphere.clouds.density, m.flight.altitude,
			m.config.world.useCesiumClouds && m.config.world.showClouds && !m.config.world.useThreeOverlay,
		);
	}

	#syncLightning(dt: number): void {
		// Shared wall clock, not an accumulator: strike instants must agree
		// across Pis within NTP drift (same doctrine as flight.svelte.ts).
		tickLightning(dt, {
			hasLightning: this.#model.config.atmosphere.weather.hasLightning,
			lightningDecayRate: this.#model.config.atmosphere.weather.lightningDecayRate,
			lightningMinInterval: this.#model.config.atmosphere.weather.lightningMinInterval,
			lightningMaxInterval: this.#model.config.atmosphere.weather.lightningMaxInterval,
		}, Date.now() / 1000);
	}

	// ── Camera ───────────────────────────────────────────────────────────────

	/** Thin orchestrator wrapper — body lives in ./camera so the math is
	 * testable in isolation. The viewer + scratch buffer stay here because
	 * they belong to the Cesium instance. */
	#syncCamera(): void {
		if (!this.#scratchDest) return;
		syncCamera(
			{ flight: this.#model.flight, motion: this.#model.motion, config: this.#model.config },
			{ Cesium: this.#C, viewer: this.#viewer },
			this.#scratchDest,
		);
		// Parallax FOV knob: LabControls writes camera.parallax.fovDeg per role.
		// Applied to the Cesium frustum here (epsilon-gated like the other sync
		// writes); CameraMirror then mirrors it into the Three camera for free
		// via getCameraRead().fovDeg. setView() never touches the frustum, so
		// this does not fight flight camera control.
		const fovDeg = this.#model.config.camera.parallax.fovDeg;
		if (Number.isFinite(fovDeg) && fovDeg > 0 && Math.abs(fovDeg - this.#lastFovDeg) > 0.01) {
			this.#lastFovDeg = fovDeg;
			(this.#viewer.camera.frustum as { fov: number }).fov = this.#C.Math.toRadians(fovDeg);
		}
	}

	// ── Post-Process ─────────────────────────────────────────────────────────

	#setupPostProcess(glsl: string): void {
		const v = this.#viewer;
		// HBAO — Pi-5 tuned: fewer directions/steps than desktop defaults.
		// Enabled per-tick in atmosphere.ts when altitude < 15 000 ft
		// AND qualityMode !== "performance".
		const ao = v.scene.postProcessStages.ambientOcclusion;
		if (ao) {
			ao.uniforms.intensity = 2.0;
			ao.uniforms.bias = 0.1;
			ao.uniforms.lengthCap = 0.26;
			ao.uniforms.directionCount = 4;
			ao.uniforms.stepCount = 16;
			ao.enabled = false;
		}
		const bloom = v.scene.postProcessStages?.bloom;
		if (bloom) {
			// Enabled-state and the tunable uniforms are owned by #syncQuality
			// (called at the end of this function, and again every tick). Only
			// the non-tunable constant is set here.
			(bloom as unknown as { glowOnly?: boolean }).glowOnly = false;
		}
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const existing = (v.scene.postProcessStages as any).find?.((s: { name: string }) => s.name === COLOR_GRADE_STAGE);
			this.#colorGradeStage = existing ? existing as CesiumType.PostProcessStage : null;
			if (!this.#colorGradeStage) {
				const stage = new this.#C.PostProcessStage({
					name: COLOR_GRADE_STAGE, fragmentShader: glsl,
					uniforms: {
						u_nightFactor: () => this.#model.nightFactor * this.#getBootFade(),
						u_additiveStrength: () => this.#model.config.world.additiveStrength,
					},
				});
				v.scene.postProcessStages.add(stage);
				this.#colorGradeStage = stage as CesiumType.PostProcessStage;
			}
		} catch (e) { console.warn('[Cesium] Post-process failed:', e); }
		this.#syncQuality();
	}

	#syncQuality(): void {
		const mode = this.#model.config.world.qualityMode;
		const useHash = this.#model.config.world.useHashPalette;
		// Latch read once per tick in #syncImagery; part of the memo key so a
		// dusk/dawn crossing re-runs this even when the config is unchanged.
		const nightFx = this.#nightFxOn;
		if (
			mode === this.#lastQualityMode
			&& useHash === this.#lastUseHashPalette
			&& nightFx === this.#lastNightFxOn
		) return;
		this.#lastQualityMode = mode;
		this.#lastUseHashPalette = useHash;
		this.#lastNightFxOn = nightFx;

		// Gates SSOT: qualityPaintGates() in shaders.ts (unit-tested).
		//
		//   quality — shadows / FXAA / AO. All-day cost; tier-tied.
		//   bloomOn — spatial glow on night lights; sun-tied (nightFx) so
		//             performance still gets night bloom (was a Pi blackout bug).
		//   gradeByDay — day half of hash/color grade. **Off under performance**
		//             even when dayContrast/dayVibrance knobs are set — those
		//             knobs are balanced/ultra. Under performance they used to
		//             keep a full-screen grade blit running all day.
		//   postFx  — any grade/bloom work worth installing stages for.
		//
		// Pi lean (docs/SIMPLIFICATION-DECISIONS.md): day-only paint off under
		// performance; night bloom + hash stay via nightFx; wing/Three stays
		// mounted; cloud sprite count scaled separately (clouds/cluster-budget).
		const w0 = this.#model.config.world;
		const { quality, bloomOn, postFx } = qualityPaintGates({
			mode,
			nightFx,
			dayContrast: w0.dayContrast,
			dayVibrance: w0.dayVibrance,
		});

		// Hash palette follows the flag at runtime: install on true, uninstall
		// (remove stage + restore aero-color-grade) on false. Boot-only install
		// left the stage permanently enabled after a runtime toggle-off while
		// #syncImagery re-enabled color-grade — the double-grade.
		const wantHash = useHash && postFx;
		if (wantHash && !this.#hashPaletteCleanup) {
			this.#hashPaletteCleanup = installHashPalette(
				this.#C, this.#viewer,
				() => this.#model.nightFactor, () => this.#model.nightLightScale,
				() => this.#model.config.world.darkVoidStrength, () => this.#model.config.world.envLight,
				() => this.#model.config.world.additiveStrength,
				() => this.#model.config.world.dayContrast,
				() => this.#model.config.world.dayVibrance,
				() => this.#model.config.world.nightMaskGamma,
				() => this.#model.config.world.nightMaskNoise,
				() => this.#model.config.world.nightGlimmer,
			);
			// installHashPalette flips aero-color-grade.enabled directly, behind
			// #syncImagery's gate — invalidate so the next tick re-writes it.
			this.#lastColorGradeEnabled = null;
		} else if (!wantHash && this.#hashPaletteCleanup) {
			this.#hashPaletteCleanup();
			this.#hashPaletteCleanup = null;
			// Cleanup restores a stale prev-enabled on aero-color-grade;
			// invalidate the gate so #syncImagery re-derives it next tick.
			this.#lastColorGradeEnabled = null;
		}
		const bloom = this.#viewer?.scene.postProcessStages?.bloom;
		if (bloom) bloom.enabled = bloomOn;
		// Warm palette is load-bearing, but hash palette wins when enabled —
		// the two grading stages must never stack (double-grade). Rides `postFx`
		// with bloom. When postFx is on, #syncImagery re-takes enabled-management
		// per tick (it also honours the useHashPalette half of this condition).
		if (this.#colorGradeStage) this.#colorGradeStage.enabled = postFx && !wantHash;
		const v = this.#viewer;
		if (v.shadowMap) v.shadowMap.enabled = quality;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(v.scene.postProcessStages as any).fxaa.enabled = quality;
		// atmosphere.ts re-decides this per tick behind its own <15 000 ft gate;
		// this only sets the floor when the tier changes.
		const ao = v.scene.postProcessStages.ambientOcclusion;
		if (ao) ao.enabled = quality;
		// Uniforms must be written whenever bloom is enabled, not just in
		// quality mode — the night path would otherwise bloom with Cesium's
		// defaults and none of the tuned sigma/contrast.
		if (bloom && bloomOn) {
			const w = this.#model.config.world;
			bloom.uniforms.contrast = w.bloomContrast;
			bloom.uniforms.brightness = w.bloomBrightness;
			bloom.uniforms.sigma = w.bloomSigma;
			bloom.uniforms.delta = 1.0;
			bloom.uniforms.stepSize = 1.0;
		}
	}

	// ── Public API ───────────────────────────────────────────────────────────

	applyQualityMode(mode: QualityMode): void {
		const p = CESIUM_QUALITY_PRESETS[mode];
		const globe = this.#viewer.scene.globe;

		// The presets are sized for STREAMING, where every extra tile is a
		// request over a client's WiFi. Served from local disk that cost is a
		// page-cache read, so retention and prefetch get cheaper by orders of
		// magnitude and the budget should not stay tuned for the network.
		//
		// Deliberately retention + prefetch ONLY. maximumScreenSpaceError is
		// untouched because it is GPU load, not I/O — lowering it here would
		// quietly raise triangle count on a Pi 5 that is already running the
		// Three overlay un-gated, which is the P8 question and not this one.
		// What this buys is fewer pop-ins after a location change, not fps.
		const local = localTilesAvailable();

		globe.maximumScreenSpaceError = p.maximumScreenSpaceError;
		globe.tileCacheSize = local ? p.tileCacheSize * 2 : p.tileCacheSize;
		globe.preloadSiblings = local ? true : p.preloadSiblings;
		globe.preloadAncestors = p.preloadAncestors;
		globe.loadingDescendantLimit = p.loadingDescendantLimit;
		updateBuildingsQuality(p.maximumScreenSpaceError);
	}

	setBuildingsWireframe(enabled: boolean): void { setBuildingsWireframe(enabled); }

	destroy(): void {
		this.#hashPaletteCleanup?.();
		this.#hashPaletteCleanup = null;
		// Every subsystem that holds viewer-scoped state, in one call. Was two
		// named destroys, which is precisely how a third subsystem's state ended
		// up cleared by nothing — see world/viewer-lifecycle.
		teardownViewerState();
		if (!this.#viewer.isDestroyed()) {
			if (this.#boundTick) this.#viewer.scene.postRender.removeEventListener(this.#boundTick);
			this.#viewer.destroy();
		}
	}
}
