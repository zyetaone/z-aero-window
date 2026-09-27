<script lang="ts">
	/**
	 * NightVariantPanel — visual A/B comparison harness for night-light rendering
	 * variants. 7 base variants (A-G) + stackable H. Mounted from /?lab=1 →
	 * Night Lab (DEV only, dynamic import — never on the Pi).
	 *
	 * ─── STATUS (docs/SIMPLIFICATION-DECISIONS.md) ───────────────────────────
	 * Night look is NOT frozen: enhance A–G and hand-port winners into
	 * hash-palette.ts / config-tree. Do NOT add variant I/J/K. Promote or
	 * delete; do not grow the set.
	 *
	 * Variants represent genuinely different aesthetic choices, not parameter
	 * tweaks on the same idea. Variant G is the Apr-15 hash-palette resurrection.
	 *
	 * ─── ON THE DUPLICATED GLSL ─────────────────────────────────────────────
	 * The fragment shader below overlaps heavily with `world/hash-palette.ts`
	 * (same luminance/brightGuard preamble, same sodium→amber→warm-white stops,
	 * same dark-void and pollution tail). That is DELIBERATE and must not be
	 * "de-duplicated" into a shared string.
	 *
	 * This copy is a variant EXPLORER: it exposes extra uniforms production does
	 * not have (u_paletteSpread, u_redSparkRate, u_viirsMaskStrength) and keeps
	 * knobs production has already settled — e.g. the red-bias VIIRS gate, which
	 * hash-palette.ts deleted with a long note explaining why it could never
	 * work there. Sharing the source would force the lab to inherit production's
	 * decisions, which is exactly the thing it exists to question; the copies are
	 * SUPPOSED to diverge as experiments run.
	 *
	 * The direction of travel is one-way: when a variant wins, its constants are
	 * hand-carried into `world/hash-palette.ts`, which stays the single source
	 * for what actually ships. Nothing imports this file's GLSL.
	 */
	import { untrack } from 'svelte';
	import { clamp } from '$lib/utils';
	import { COLOR_GRADE_STAGE } from '$lib/world/shaders';
	import { activeCesium } from '$lib/world/active.svelte';
	import type { AeroWindow } from '$lib/model/aero-window.svelte';
	import RangeSlider from '$lib/shell/operator/panel/RangeSlider.svelte';

	let { model }: { model: AeroWindow } = $props();

	type VariantId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

	interface VariantMeta { id: VariantId; label: string; hint: string; }

	const VARIANTS: VariantMeta[] = [
		{ id: 'A', label: 'Baseline', hint: 'current production — warm, atmospheric bloom' },
		{ id: 'B', label: 'Cinematic', hint: 'heavy bloom, crushed blacks — movie poster' },
		{ id: 'C', label: 'Crisp Map', hint: 'no bloom, neutral greyscale — read the city grid' },
		{ id: 'D', label: 'Cool Moonlight', hint: 'blue-tinted, wide soft bloom — 2 AM feel' },
		{ id: 'E', label: 'Altitude Drama', hint: 'buildings glow up close, VIIRS takes over at distance' },
		{ id: 'F', label: 'Vector roads (OSM)', hint: 'Hyderabad road network as glowing polylines' },
		{ id: 'G', label: 'Apr-15 hash palette', hint: '3-stop warm palette (sodium/amber/warm-white) + 3% red sparks' },
	];

	let stackH = $state(true);
	let variant = $state<VariantId>('A');


	// Global tunables — read/write model directly, no proxy $state needed.
	const GLOBAL_DEFAULTS = { timeOfDay: 22.0, altitude: 28000 };

	// ─── Variant defaults ─────────────────────────────────────────────────────

	const A_DEFAULTS = { bloomSigma: 2.2, bloomContrast: 128, bloomBrightness: -0.3, nightLightIntensity: 0.6, baseNightSaturation: 0.05 };
	const tunablesA = $state({ ...A_DEFAULTS });
	const B_DEFAULTS = { sigma: 6.0, contrast: 64, brightness: -0.5, nightLightIntensity: 1.2 };
	const tunablesB = $state({ ...B_DEFAULTS });
	const C_DEFAULTS = { viirsBrightness: 1.8 };
	const tunablesC = $state({ ...C_DEFAULTS });
	const D_DEFAULTS = { viirsHue: -0.5, viirsSaturation: 0.3, sigma: 5.0, contrast: 80 };
	const tunablesD = $state({ ...D_DEFAULTS });
	const E_DEFAULTS = { lowAltitudeFt: 15000, highAltitudeFt: 25000, viirsDimMin: 0.3, buildingEmissiveMax: 0.6 };
	const tunablesE = $state({ ...E_DEFAULTS });
	const F_DEFAULTS = { intensity: 5.0, glowWidth: 7.0 };
	const tunablesF = $state({ ...F_DEFAULTS });
	const G_DEFAULTS = { paletteSpread: 0.25, additiveStrength: 7.0, redSparkRate: 0.03, darkVoidStrength: 0.3, envLight: 0.5, viirsMaskStrength: 0.85 };
	const tunablesG = $state({ ...G_DEFAULTS });

	const H_DEFAULTS = { moonlightIntensity: 0.08, nightExposure: 0.85, atmosphereLight: 3.0, skyDarken: 1.6, viirsBrightness: 1.5, viirsAlphaBoost: 1.4 };
	const tunablesH = $state({ ...H_DEFAULTS });

	let moonPhaseLive = $state(0);
	let effectiveMoonlightLive = $state(0);
	let roadsFeatureCount = $state(0);
	let roadsError = $state('');

	// ─── Variant G shader ─────────────────────────────────────────────────────

	const G_SHADER = `
		uniform sampler2D colorTexture;
		uniform float u_nightFactor;
		uniform float u_lightIntensity;
		uniform float u_paletteSpread;
		uniform float u_additiveStrength;
		uniform float u_redSparkRate;
		uniform float u_darkVoidStrength;
		uniform float u_envLight;
		uniform float u_viirsMaskStrength;
		in vec2 v_textureCoordinates;

		void main() {
			vec4 color = texture(colorTexture, v_textureCoordinates);
			vec3 rgb = color.rgb;
			float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
			float brightGuard = smoothstep(0.75, 0.95, lum);
			float lightMask = smoothstep(0.08, 0.65, lum);
			float redBias = clamp(rgb.r - rgb.b, 0.0, 1.0);
			float viirsLikely = smoothstep(0.05, 0.3, redBias);
			lightMask *= mix(1.0, viirsLikely, u_viirsMaskStrength);
			vec3 grayBase = vec3(lum);
			rgb = mix(rgb, grayBase, lightMask * 0.8 * u_nightFactor);
			float hash = fract(sin(dot(v_textureCoordinates * 1000.0, vec2(12.9898, 78.233))) * 43758.5453);
			float paletteLum = clamp(lum + (hash - 0.5) * u_paletteSpread, 0.0, 1.0);
			vec3 sodium   = vec3(1.0, 0.6, 0.2);
			vec3 amber    = vec3(1.0, 0.8, 0.4);
			vec3 warmWht  = vec3(1.0, 0.95, 0.85);
			vec3 trafficRed = vec3(1.0, 0.15, 0.05);
			vec3 lightColor = mix(sodium, amber, smoothstep(0.15, 0.5, paletteLum));
			lightColor = mix(lightColor, warmWht, smoothstep(0.5, 0.9, paletteLum));
			float redSpark = step(1.0 - u_redSparkRate, fract(hash * 7.3));
			lightColor = mix(lightColor, trafficRed, redSpark * lightMask * 0.8);
			rgb += lightColor * lum * u_additiveStrength * u_nightFactor;
			rgb = min(rgb, vec3(4.0));
			float darkenAmount = smoothstep(0.45, 0.9, u_nightFactor) * 0.85;
			rgb = mix(rgb, vec3(0.02, 0.04, 0.08), darkenAmount * (1.0 - lightMask) * (1.0 - brightGuard));
			float darkVoid = 1.0 - smoothstep(0.05, 0.2, lum);
			rgb = mix(rgb, vec3(0.0), darkVoid * u_nightFactor * u_darkVoidStrength * (1.0 - brightGuard));
			float pollution = smoothstep(0.10, 0.5, lum) * u_nightFactor;
			rgb = min(rgb + vec3(0.18, 0.09, 0.02) * pollution * u_lightIntensity, vec3(1.0));
			vec3 ambient = vec3(0.025, 0.022, 0.018) * u_envLight * u_nightFactor;
			rgb = max(rgb, ambient);
			out_FragColor = vec4(clamp(rgb, 0.0, 1.0), color.a);
		}
	`;

	// ─── Helpers ─────────────────────────────────────────────────────────────

	function findViirsLayer(viewer: any): unknown | null {
		const layers = viewer.imageryLayers;
		for (let i = 0; i < layers.length; i++) {
			const l = layers.get(i) as Record<string, unknown> | null;
			if (l && l.colorToAlpha !== undefined) return l;
		}
		return null;
	}

	function findBuildingTileset(viewer: any): Record<string, unknown> | null {
		const prims = viewer.scene.primitives;
		for (let i = 0; i < prims.length; i++) {
			const p = prims.get(i) as Record<string, unknown> | null;
			if (p && p.isCesium3DTileset) return p;
		}
		return null;
	}

	function resetCamera(): void {
		model.flight.setLocationWithSky('hyderabad', 'night');
		model.setAltitude(GLOBAL_DEFAULTS.altitude);
	}

	function resetVariantDefaults(): void {
		const map: Record<string, object> = { A: A_DEFAULTS, B: B_DEFAULTS, C: C_DEFAULTS, D: D_DEFAULTS, E: E_DEFAULTS, F: F_DEFAULTS, G: G_DEFAULTS };
		const target = variant === 'A' ? tunablesA : variant === 'B' ? tunablesB : variant === 'C' ? tunablesC : variant === 'D' ? tunablesD : variant === 'E' ? tunablesE : variant === 'F' ? tunablesF : tunablesG;
		if (map[variant]) Object.assign(target, map[variant]);
	}

	function resetStackH(): void { Object.assign(tunablesH, H_DEFAULTS); }
	function resetAll(): void {
		// Setters clamp + track overrides — do not raw-assign time/altitude.
		model.setTime(GLOBAL_DEFAULTS.timeOfDay);
		model.setAltitude(GLOBAL_DEFAULTS.altitude);
		Object.assign(tunablesA, A_DEFAULTS); Object.assign(tunablesB, B_DEFAULTS);
		Object.assign(tunablesC, C_DEFAULTS); Object.assign(tunablesD, D_DEFAULTS);
		Object.assign(tunablesE, E_DEFAULTS); Object.assign(tunablesF, F_DEFAULTS);
		Object.assign(tunablesG, G_DEFAULTS); Object.assign(tunablesH, H_DEFAULTS);
	}

	function makeSetter(obj: object) {
		return (k: string) => (e: Event & { currentTarget: HTMLInputElement }) => {
			(obj as Record<string, number>)[k] = parseFloat(e.currentTarget.value);
		};
	}
	const setA = makeSetter(tunablesA); const setB = makeSetter(tunablesB);
	const setC = makeSetter(tunablesC); const setD = makeSetter(tunablesD);
	const setE = makeSetter(tunablesE); const setF = makeSetter(tunablesF);
	const setG = makeSetter(tunablesG); const setH = makeSetter(tunablesH);

	// ─── Slider handlers ─────────────────────────────────────────────────────

	function onGlobalTime(e: Event & { currentTarget: HTMLInputElement }) {
		model.setTime(parseFloat(e.currentTarget.value));
	}
	function onGlobalAlt(e: Event & { currentTarget: HTMLInputElement }) {
		model.setAltitude(parseFloat(e.currentTarget.value));
	}

	// ─── Variant A: push to prod config ───────────────────────────────────────

	$effect(() => {
		if (variant !== 'A') return;
		const { bloomSigma, bloomContrast, bloomBrightness, nightLightIntensity, baseNightSaturation } = tunablesA;
		untrack(() => {
			model.applyConfigPatch('world.bloomSigma', bloomSigma);
			model.applyConfigPatch('world.bloomContrast', bloomContrast);
			model.applyConfigPatch('world.bloomBrightness', bloomBrightness);
			model.applyConfigPatch('world.nightLightIntensity', nightLightIntensity);
			model.applyConfigPatch('world.baseNightSaturation', baseNightSaturation);
		});
	});

	// ─── Variant B: Cinematic ────────────────────────────────────────────────

	$effect(() => {
		if (variant !== 'B') return;
		const bloom = activeCesium.manager?.getViewer().scene.postProcessStages?.bloom;
		if (!bloom?.uniforms) return;
		const prevNI = untrack(() => model.config.world.nightLightIntensity);
		const prevEnabled = bloom.enabled;
		const prevSigma = bloom.uniforms.sigma;
		const prevContrast = bloom.uniforms.contrast;
		const prevBrightness = bloom.uniforms.brightness;
		bloom.enabled = true;
		bloom.uniforms.sigma = tunablesB.sigma;
		bloom.uniforms.contrast = tunablesB.contrast;
		bloom.uniforms.brightness = tunablesB.brightness;
		model.applyConfigPatch('world.nightLightIntensity', tunablesB.nightLightIntensity);
		return () => {
			bloom.enabled = prevEnabled;
			bloom.uniforms.sigma = prevSigma;
			bloom.uniforms.contrast = prevContrast;
			bloom.uniforms.brightness = prevBrightness;
			model.applyConfigPatch('world.nightLightIntensity', prevNI);
		};
	});

	// ─── Variant C: Crisp Map ────────────────────────────────────────────────

	$effect(() => {
		if (variant !== 'C') return;
		const viewer = activeCesium.manager?.getViewer();
		const bloom = viewer?.scene.postProcessStages?.bloom;
		const viirs = findViirsLayer(viewer!) as Record<string, number> | null;
		if (!bloom || !viirs) return;
		const prevBloomEnabled = bloom.enabled;
		const prevHue = viirs.hue, prevSat = viirs.saturation, prevBright = viirs.brightness;
		bloom.enabled = false;
		viirs.hue = 0; viirs.saturation = 1.0; viirs.brightness = tunablesC.viirsBrightness;
		return () => { bloom.enabled = prevBloomEnabled; viirs.hue = prevHue; viirs.saturation = prevSat; viirs.brightness = prevBright; };
	});

	// ─── Variant D: Cool Moonlight ───────────────────────────────────────────

	$effect(() => {
		if (variant !== 'D') return;
		const viewer = activeCesium.manager?.getViewer();
		const bloom = viewer?.scene.postProcessStages?.bloom;
		const viirs = findViirsLayer(viewer!) as Record<string, number> | null;
		if (!bloom?.uniforms || !viirs) return;
		const prevEnabled = bloom.enabled, prevSigma = bloom.uniforms.sigma, prevContrast = bloom.uniforms.contrast;
		const prevHue = viirs.hue, prevSat = viirs.saturation;
		bloom.enabled = true;
		bloom.uniforms.sigma = tunablesD.sigma;
		bloom.uniforms.contrast = tunablesD.contrast;
		viirs.hue = tunablesD.viirsHue; viirs.saturation = tunablesD.viirsSaturation;
		return () => { bloom.enabled = prevEnabled; bloom.uniforms.sigma = prevSigma; bloom.uniforms.contrast = prevContrast; viirs.hue = prevHue; viirs.saturation = prevSat; };
	});

	// ─── Variant E: Altitude Drama ───────────────────────────────────────────

	$effect(() => {
		if (variant !== 'E') return;
		const mgr = activeCesium.manager; if (!mgr) return;
		const Cesium = mgr.getCesium();
		const viewer = mgr.getViewer();
		const tileset = findBuildingTileset(viewer);
		const prevNI = untrack(() => model.config.world.nightLightIntensity);
		const prevBlendMode = tileset?.colorBlendMode ?? null;
		const prevStyle = tileset?.style ?? null;
		if (tileset) (tileset as Record<string, unknown>).colorBlendMode = Cesium.Cesium3DTileColorBlendMode.HIGHLIGHT;
		const tick = () => {
			const lo = tunablesE.lowAltitudeFt, hi = tunablesE.highAltitudeFt;
			const altBlend = clamp((model.flight.altitude - lo) / Math.max(hi - lo, 1), 0, 1);
			if (tileset) {
				const alpha = tunablesE.buildingEmissiveMax * model.nightFactor * (1 - altBlend);
				(tileset as Record<string, unknown>).style = new Cesium.Cesium3DTileStyle({ color: `color("rgb(255, 180, 90)", ${alpha.toFixed(3)})` });
			}
			const target = tunablesE.viirsDimMin + (1.0 - tunablesE.viirsDimMin) * altBlend;
			if (Math.abs(model.config.world.nightLightIntensity - target) > 0.01) model.applyConfigPatch('world.nightLightIntensity', target);
		};
		tick();
		viewer.scene.postRender.addEventListener(tick);
		return () => { viewer.scene.postRender.removeEventListener(tick); model.applyConfigPatch('world.nightLightIntensity', prevNI); if (tileset) { if (prevBlendMode !== null) (tileset as Record<string, unknown>).colorBlendMode = prevBlendMode; (tileset as Record<string, unknown>).style = prevStyle ?? undefined; } };
	});

	// ─── Variant F: OSM Vector Roads ─────────────────────────────────────────

	type RoadClass = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential';
	interface RoadFeature { type: 'Feature'; geometry: { type: 'LineString'; coordinates: [number, number][] }; properties: { highway: RoadClass }; }
	interface RoadGeoJson { type: 'FeatureCollection'; features: RoadFeature[] }

	const ROAD_COLORS: Record<RoadClass, [number, number, number]> = { motorway: [255, 220, 100], trunk: [255, 200, 80], primary: [255, 180, 70], secondary: [220, 160, 60], tertiary: [180, 140, 50], residential: [140, 120, 40] };
	const ROAD_WIDTHS: Record<RoadClass, number> = { motorway: 3.0, trunk: 2.5, primary: 2.0, secondary: 1.5, tertiary: 1.0, residential: 0.6 };
	let roadsCache: RoadGeoJson | null = null;
	let roadsFetchPromise: Promise<RoadGeoJson> | null = null;

	async function getRoads(): Promise<RoadGeoJson> {
		if (roadsCache) return roadsCache;
		if (roadsFetchPromise) return roadsFetchPromise;
		roadsFetchPromise = (async () => {
			const bbox = '78.2,17.3,78.6,17.6';
			const query = `[out:json][bbox:${bbox}];(way[highway~"^(motorway|trunk|primary|secondary|tertiary|residential)$"];);out geom;`;
			const resp = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: query });
			const text = await resp.text();
			const data = JSON.parse(text);
			const fc: RoadGeoJson = { type: 'FeatureCollection', features: [] };
			for (const el of data.elements as Array<{ type: string; geometry?: { lat: number; lon: number }[]; tags?: { highway?: string } }>) {
				if (el.type === 'way' && el.geometry && el.tags) {
					const hw = el.tags.highway;
					if (hw && hw in ROAD_COLORS) fc.features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: el.geometry.map((pt) => [pt.lon, pt.lat]) }, properties: { highway: hw as RoadClass } });
				}
			}
			roadsCache = fc; roadsFeatureCount = fc.features.length; return fc;
		})();
		try { return await roadsFetchPromise; } finally { roadsFetchPromise = null; }
	}

	$effect(() => {
		if (variant !== 'F') return;
		const mgr = activeCesium.manager; if (!mgr) return;
		const Cesium = mgr.getCesium(); const viewer = mgr.getViewer();
		let billboards: unknown = null; let active = true;
		void (async () => {
			try { roadsError = ''; const fc = await getRoads(); if (!active) return; roadsFeatureCount = fc.features.length;
				const collection = new Cesium.BillboardCollection(); viewer.scene.primitives.add(collection); billboards = collection;
				const circleUrl = Cesium.buildModuleUrl('Assets/Textures/maki/circle.png');
				for (const feat of fc.features) {
					const hw = feat.properties.highway;
					const [r, g, b] = ROAD_COLORS[hw]; const w = ROAD_WIDTHS[hw];
					const color = new Cesium.Color(r / 255, g / 255, b / 255, 1.0);
					for (const [lon, lat] of feat.geometry.coordinates) {
						collection.add({ position: Cesium.Cartesian3.fromDegrees(lon, lat), image: circleUrl, color, scale: w * tunablesF.intensity * 0.1, width: w * tunablesF.glowWidth });
					}
				}
			} catch (err) { roadsError = err instanceof Error ? err.message : String(err); }
		})();
		return () => { active = false; if (billboards) viewer.scene.primitives.remove(billboards as any); };
	});

	// ─── Variant G: Hash palette shader ──────────────────────────────────────

	$effect(() => {
		if (variant !== 'G') return;
		const mgr = activeCesium.manager; if (!mgr) return;
		const Cesium = mgr.getCesium(); const viewer = mgr.getViewer();
		const stages = viewer.scene.postProcessStages;
		let aeroStage: { enabled: boolean } | null = null;
		const prevAeroEnabled = (() => { for (let i = 0; i < stages.length; i++) { const s = stages.get(i) as { name?: string; enabled?: boolean } | null; if (s && s.name === COLOR_GRADE_STAGE) { aeroStage = s as { enabled: boolean }; const was = aeroStage.enabled; aeroStage.enabled = false; return was; } } return true; })();
		const stage = new Cesium.PostProcessStage({ name: 'night-lab-feb-hybrid', fragmentShader: G_SHADER, uniforms: { u_nightFactor: () => model.nightFactor, u_lightIntensity: () => model.nightLightScale, u_paletteSpread: () => tunablesG.paletteSpread, u_additiveStrength: () => tunablesG.additiveStrength, u_redSparkRate: () => tunablesG.redSparkRate, u_darkVoidStrength: () => tunablesG.darkVoidStrength, u_envLight: () => tunablesG.envLight, u_viirsMaskStrength: () => tunablesG.viirsMaskStrength } });
		stages.add(stage);
		return () => { if (!viewer.isDestroyed()) { stages.remove(stage); if (aeroStage) aeroStage.enabled = prevAeroEnabled; } };
	});

	// ─── Variant H: Stackable Cesium API knobs ───────────────────────────────

	$effect(() => {
		if (!stackH) return;
		const mgr = activeCesium.manager; if (!mgr) return;
		const Cesium = mgr.getCesium(); const viewer = mgr.getViewer();
		const scene = viewer.scene; const stages = scene.postProcessStages; const globe = scene.globe;
		const stagesAny = stages as any; const globeAny = globe as any; const CesiumAny = Cesium as any;
		const prevLight = scene.light; const prevTonemapper = stagesAny.tonemapper; const prevExposure = stagesAny.exposure; const prevAtmosphereLight = globeAny.atmosphereLightIntensity;
		const viirsLayer = findViirsLayer(viewer) as any; const prevViirsBrightness = viirsLayer?.brightness;
		stagesAny.tonemapper = CesiumAny.Tonemapper.ACES; stagesAny.exposure = 1.0; globeAny.atmosphereLightIntensity = 10.0;
		const moonlight = new Cesium.DirectionalLight({ direction: new Cesium.Cartesian3(0, 0, -1), color: new Cesium.Color(0.95, 0.88, 0.78, 1.0), intensity: tunablesH.moonlightIntensity });
		scene.light = moonlight;
		if (viirsLayer && typeof prevViirsBrightness === 'number') viirsLayer.brightness = prevViirsBrightness * tunablesH.viirsBrightness;
		const skyAtmosphere = scene.skyAtmosphere as unknown as { brightnessShift: number } | undefined;
		const Simon = CesiumAny.Simon1994PlanetaryPositions; const Cartesian3 = CesiumAny.Cartesian3;
		const _sunPos = new Cartesian3(); const _moonPos = new Cartesian3(); const _earthToMoon = new Cartesian3(); const _moonToSun = new Cartesian3();
		const tick = () => {
			const nf = model.nightFactor;
			let moonPhase = 1.0;
			try { const julianDate = viewer.clock.currentTime; Simon.computeSunPositionInEarthInertialFrame(julianDate, _sunPos); Simon.computeMoonPositionInEarthInertialFrame(julianDate, _moonPos); Cartesian3.normalize(_moonPos, _earthToMoon); Cartesian3.subtract(_sunPos, _moonPos, _moonToSun); Cartesian3.normalize(_moonToSun, _moonToSun); const cosPhase = Cartesian3.dot(_earthToMoon, _moonToSun); moonPhase = (1.0 - cosPhase) * 0.5; moonPhaseLive = moonPhase; } catch { /* fall through */ }
			const phaseFactor = 0.7 + 0.3 * moonPhase;
			const baseTarget = tunablesH.moonlightIntensity * nf * phaseFactor;
			const moonlightTarget = nf > 0.01 ? Math.max(baseTarget, 0.035) : 0;
			(moonlight as unknown as { intensity: number }).intensity = moonlightTarget; effectiveMoonlightLive = moonlightTarget;
			stagesAny.exposure = 1.0 + (tunablesH.nightExposure - 1.0) * nf;
			globeAny.atmosphereLightIntensity = 10.0 + (tunablesH.atmosphereLight - 10.0) * nf;
			if (skyAtmosphere) skyAtmosphere.brightnessShift = -0.3 * nf * tunablesH.skyDarken;
			if (viirsLayer && viirsLayer.alpha > 0) { const boost = 1.0 + (tunablesH.viirsAlphaBoost - 1.0) * nf; viirsLayer.alpha = Math.min(viirsLayer.alpha * boost, 1.0); }
		};
		viewer.scene.postRender.addEventListener(tick);
		return () => { if (!viewer.isDestroyed()) { scene.light = prevLight; stagesAny.tonemapper = prevTonemapper; stagesAny.exposure = prevExposure; globeAny.atmosphereLightIntensity = prevAtmosphereLight; viewer.scene.postRender.removeEventListener(tick); if (viirsLayer && typeof prevViirsBrightness === 'number') viirsLayer.brightness = prevViirsBrightness; } };
	});

	// ─── Readouts ────────────────────────────────────────────────────────────

	const fps = $derived(Math.round(model.measuredFps));
	const altitudeFt = $derived(Math.round(model.flight.altitude));
	const nfPct = $derived(Math.round(model.nightFactor * 100));
	const altitudeBlend = $derived.by(() => variant !== 'E' ? 0 : clamp((model.flight.altitude - tunablesE.lowAltitudeFt) / Math.max(tunablesE.highAltitudeFt - tunablesE.lowAltitudeFt, 1), 0, 1));
</script>

<aside class="panel" aria-label="Variant comparison">
	<header>
		<h2>Night Lab</h2>
		<p class="hint">DEV · ?lab=1 · enhance A–G · promote winners to production</p>
		<p class="policy" role="note">
			Night look still open. Tune existing variants; hand-port into
			<code>hash-palette.ts</code> / config. No new letter variants.
		</p>
	</header>

	<fieldset class="globals">
		<legend>Global</legend>
		<RangeSlider label="Time of day" value={model.timeOfDay} min={15.0} max={24.0} step={0.25} formatValue={(v: number) => `${v.toFixed(2)}h`} oninput={onGlobalTime} />
		<RangeSlider label="Altitude" value={model.flight.altitude} min={10000} max={65000} step={500} formatValue={(v: number) => `${Math.round(v).toLocaleString()} ft`} oninput={onGlobalAlt} />
	</fieldset>

	<fieldset class="variants" role="radiogroup" aria-label="Rendering variant">
		<legend>Variant</legend>
		{#each VARIANTS as vtab (vtab.id)}
			<label class="row">
				<input type="radio" name="variant" value={vtab.id} checked={variant === vtab.id} onchange={() => (variant = vtab.id)} />
				<span class="row-label"><strong>{vtab.id}.</strong>{vtab.label}</span>
				<span class="row-hint">{vtab.hint}</span>
			</label>
		{/each}
	</fieldset>

	<fieldset class="tunables">
		<legend>Variant {variant} tunables</legend>
		{#if variant === 'A'}
			<RangeSlider label="Bloom sigma" value={tunablesA.bloomSigma} min={0.5} max={8.0} step={0.1} formatValue={(v: number) => v.toFixed(1)} oninput={setA('bloomSigma')} />
			<RangeSlider label="Bloom contrast" value={tunablesA.bloomContrast} min={32} max={256} step={1} formatValue={(v: number) => v.toFixed(0)} oninput={setA('bloomContrast')} />
			<RangeSlider label="Bloom brightness" value={tunablesA.bloomBrightness} min={-1.0} max={1.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setA('bloomBrightness')} />
			<RangeSlider label="Night light intensity" value={tunablesA.nightLightIntensity} min={0.0} max={2.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setA('nightLightIntensity')} />
			<RangeSlider label="Base night saturation" value={tunablesA.baseNightSaturation} min={0.0} max={0.5} step={0.01} formatValue={(v: number) => v.toFixed(2)} oninput={setA('baseNightSaturation')} />
		{:else if variant === 'B'}
			<RangeSlider label="Sigma" value={tunablesB.sigma} min={2.0} max={10.0} step={0.5} formatValue={(v: number) => v.toFixed(1)} oninput={setB('sigma')} />
			<RangeSlider label="Contrast" value={tunablesB.contrast} min={16} max={256} step={1} formatValue={(v: number) => v.toFixed(0)} oninput={setB('contrast')} />
			<RangeSlider label="Brightness" value={tunablesB.brightness} min={-1.0} max={1.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setB('brightness')} />
			<RangeSlider label="Night light intensity" value={tunablesB.nightLightIntensity} min={0.0} max={3.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setB('nightLightIntensity')} />
		{:else if variant === 'C'}
			<RangeSlider label="VIIRS brightness" value={tunablesC.viirsBrightness} min={0.5} max={4.0} step={0.1} formatValue={(v: number) => v.toFixed(1)} oninput={setC('viirsBrightness')} />
		{:else if variant === 'D'}
			<RangeSlider label="VIIRS hue" value={tunablesD.viirsHue} min={-1.0} max={1.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setD('viirsHue')} />
			<RangeSlider label="VIIRS saturation" value={tunablesD.viirsSaturation} min={0.0} max={1.5} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setD('viirsSaturation')} />
			<RangeSlider label="Sigma" value={tunablesD.sigma} min={2.0} max={10.0} step={0.5} formatValue={(v: number) => v.toFixed(1)} oninput={setD('sigma')} />
			<RangeSlider label="Contrast" value={tunablesD.contrast} min={16} max={256} step={1} formatValue={(v: number) => v.toFixed(0)} oninput={setD('contrast')} />
		{:else if variant === 'E'}
			<RangeSlider label="Low altitude (ft)" value={tunablesE.lowAltitudeFt} min={5000} max={20000} step={500} formatValue={(v: number) => `${Math.round(v).toLocaleString()}`} oninput={setE('lowAltitudeFt')} />
			<RangeSlider label="High altitude (ft)" value={tunablesE.highAltitudeFt} min={20000} max={40000} step={500} formatValue={(v: number) => `${Math.round(v).toLocaleString()}`} oninput={setE('highAltitudeFt')} />
			<RangeSlider label="VIIRS dim min" value={tunablesE.viirsDimMin} min={0.0} max={1.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setE('viirsDimMin')} />
			<RangeSlider label="Building emissive max" value={tunablesE.buildingEmissiveMax} min={0.0} max={1.5} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setE('buildingEmissiveMax')} />
		{:else if variant === 'F'}
			<RangeSlider label="Intensity" value={tunablesF.intensity} min={0.1} max={10.0} step={0.1} formatValue={(v: number) => v.toFixed(2)} oninput={setF('intensity')} />
			<RangeSlider label="Glow width" value={tunablesF.glowWidth} min={0.5} max={12.0} step={0.1} formatValue={(v: number) => v.toFixed(1)} oninput={setF('glowWidth')} />
			{#if roadsError}<p class="roads-error" role="alert">Roads fetch failed: {roadsError}</p>{/if}
		{:else if variant === 'G'}
			<RangeSlider label="Palette spread" value={tunablesG.paletteSpread} min={0.0} max={0.6} step={0.02} formatValue={(v: number) => v.toFixed(2)} oninput={setG('paletteSpread')} />
			<RangeSlider label="Additive strength" value={tunablesG.additiveStrength} min={0.0} max={15.0} step={0.25} formatValue={(v: number) => v.toFixed(1)} oninput={setG('additiveStrength')} />
			<RangeSlider label="Red spark rate" value={tunablesG.redSparkRate} min={0.0} max={0.15} step={0.005} formatValue={(v: number) => v.toFixed(3)} oninput={setG('redSparkRate')} />
			<RangeSlider label="Dark void strength" value={tunablesG.darkVoidStrength} min={0.0} max={1.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setG('darkVoidStrength')} />
			<RangeSlider label="Env light" value={tunablesG.envLight} min={0.0} max={2.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setG('envLight')} />
			<RangeSlider label="VIIRS mask strength" value={tunablesG.viirsMaskStrength} min={0.0} max={1.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setG('viirsMaskStrength')} />
		{/if}

		<div class="reset-row">
			<button class="reset small" type="button" onclick={resetVariantDefaults}>Reset variant</button>
			<button class="reset small" type="button" onclick={resetAll}>Reset all</button>
		</div>
	</fieldset>

	<fieldset class="stack-h">
		<legend>Stack: Cesium API knobs (H)</legend>
		<label class="row stack-toggle">
			<input type="checkbox" bind:checked={stackH} />
			<span class="row-label">Apply on top of variant {variant}</span>
			<span class="row-hint">ACES tonemap + DirectionalLight moonlight + atmosphereLightIntensity + VIIRS punch</span>
		</label>
		{#if stackH}
			<RangeSlider label="Moonlight intensity (peak)" value={tunablesH.moonlightIntensity} min={0.035} max={0.3} step={0.005} formatValue={(v: number) => v.toFixed(3)} oninput={setH('moonlightIntensity')} />
			<RangeSlider label="Night exposure" value={tunablesH.nightExposure} min={0.4} max={1.5} step={0.025} formatValue={(v: number) => v.toFixed(2)} oninput={setH('nightExposure')} />
			<RangeSlider label="Atmosphere light" value={tunablesH.atmosphereLight} min={0.0} max={10.0} step={0.25} formatValue={(v: number) => v.toFixed(1)} oninput={setH('atmosphereLight')} />
			<RangeSlider label="Sky darken ×" value={tunablesH.skyDarken} min={0.5} max={4.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setH('skyDarken')} />
			<RangeSlider label="VIIRS brightness ×" value={tunablesH.viirsBrightness} min={0.5} max={3.0} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setH('viirsBrightness')} />
			<RangeSlider label="VIIRS alpha ×" value={tunablesH.viirsAlphaBoost} min={0.5} max={2.5} step={0.05} formatValue={(v: number) => v.toFixed(2)} oninput={setH('viirsAlphaBoost')} />
			<div class="readout" style="margin-top: 10px;">
				<div><span class="k">Moon phase</span><span class="v">{(moonPhaseLive * 100).toFixed(0)}%</span></div>
				<div><span class="k">Effective moonlight</span><span class="v">{effectiveMoonlightLive.toFixed(3)}</span></div>
			</div>
			<div class="reset-row"><button class="reset small" type="button" onclick={resetStackH}>Reset H defaults</button></div>
		{/if}
	</fieldset>

	<div class="readout">
		<div><span class="k">FPS</span><span class="v">{fps || '–'}</span></div>
		<div><span class="k">Altitude</span><span class="v">{altitudeFt.toLocaleString()} ft</span></div>
		<div><span class="k">Time</span><span class="v">{model.timeOfDay.toFixed(2)}h</span></div>
		<div><span class="k">Night factor</span><span class="v">{nfPct}%</span></div>
		<div><span class="k">Active</span><span class="v">{variant}</span></div>
		{#if variant === 'E'}<div><span class="k">Alt blend</span><span class="v">{(altitudeBlend * 100).toFixed(0)}%</span></div>{/if}
		{#if variant === 'F'}<div><span class="k">Roads</span><span class="v">{roadsFeatureCount || '—'}</span></div>{/if}
	</div>

	<button class="reset" type="button" onclick={resetCamera}>Reset camera</button>

	<footer>
		<p class="note">A-G: base variants (radio, pick one). H: stackable add-on (checkbox, applies on top). H+G = hash palette + ACES tonemap + moonlight + VIIRS punch combined.</p>
	</footer>
</aside>

<style>
	.panel { position: absolute; top: 16px; left: 16px; width: 320px; max-height: calc(100vh - 32px); overflow-y: auto; background: rgba(10, 10, 30, 0.88); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 12px; padding: 16px; z-index: 30; backdrop-filter: blur(8px); color: #eee; }
	.panel header h2 { font-size: 14px; margin: 0 0 4px; color: #fff; letter-spacing: 0.5px; }
	.panel header .hint { margin: 0 0 6px; font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
	.panel header .policy {
		margin: 0 0 12px;
		font-size: 11px;
		line-height: 1.35;
		color: #c9b27c;
		background: rgba(255, 191, 39, 0.08);
		border: 1px solid rgba(255, 191, 39, 0.2);
		border-radius: 6px;
		padding: 8px 10px;
	}
	.panel header .policy code { font-size: 10px; color: #e8d5a3; }
	fieldset { border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; margin: 0 0 12px; padding: 8px 10px; }
	fieldset legend { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #666; padding: 0 6px; }
	.variants .row { display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: baseline; padding: 6px 4px; border-radius: 6px; cursor: pointer; transition: background 0.15s ease; }
	.variants .row:hover { background: rgba(255, 255, 255, 0.04); }
	.variants .row input[type='radio'] { grid-row: 1 / span 2; margin: 4px 0 0; accent-color: #7faeff; }
	.variants .row-label { font-size: 12px; color: #ddd; }
	.variants .row-label strong { color: #7faeff; font-family: ui-monospace, monospace; margin-right: 4px; }
	.variants .row-hint { grid-column: 2; font-size: 10px; color: #777; line-height: 1.4; }
	.reset-row { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; }
	.readout { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; padding: 8px 10px; background: rgba(0, 0, 0, 0.25); border-radius: 8px; font-family: ui-monospace, monospace; font-size: 11px; margin-bottom: 12px; }
	.readout > div { display: flex; justify-content: space-between; }
	.readout .k { color: #666; }
	.readout .v { color: #7faeff; }
	.reset { display: block; width: 100%; padding: 8px; background: rgba(127, 174, 255, 0.12); border: 1px solid rgba(127, 174, 255, 0.3); border-radius: 6px; color: #cdddff; font-size: 12px; cursor: pointer; transition: background 0.2s ease; }
	.reset:hover { background: rgba(127, 174, 255, 0.22); }
	.reset.small { padding: 6px; font-size: 11px; }
	footer { margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255, 255, 255, 0.06); }
	footer .note { margin: 0; font-size: 10px; color: #666; line-height: 1.4; }
	.roads-error { margin: 6px 0 0; font-size: 11px; color: #ff8a7a; line-height: 1.4; }
</style>
