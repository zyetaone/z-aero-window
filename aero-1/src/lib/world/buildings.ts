/**
 * Buildings — OSM 3D Tiles + procedural lit-window CustomShader.
 *
 * Two tiers, mirroring what terrain and imagery already do:
 *   1. Cesium Ion 3D Tiles + the lit-window CustomShader (needs a token).
 *   2. Packaged GeoJSON extrusions — see ./buildings-geojson. No token, no
 *      network. Coarser: extruded footprints lit by Cesium's own sun, with no
 *      per-window lighting.
 *
 * Tier 1 stays primary and untouched; it is what the fleet runs today and
 * what the night look was tuned against. Tier 2 only ever renders where the
 * product previously showed an EMPTY SKY, so it is measured against nothing
 * rather than against tier 1.
 *
 * Call lifecycle:
 *   initBuildings(C, v)               — once, stores refs
 *   setupBuildings(enabled)            — once, async, creates tileset + shader
 *   syncBuildings(wallSec, nf, scale, ...)  — per-tick, wallSec ABSOLUTE
 *     wall second, not a delta: the buildings shader derives its state from
 *     the clock so panes agree without talking to each other (ADR-007).
 *   setWireframe(enabled)              — operator toggle
 *   updateQuality(sse)                 — quality preset change
 */

import type * as CesiumType from 'cesium';
import type { LocationId } from '$lib/types';
import { LOCATION_MAP } from '$content/locations';
import { getIonToken } from './cesium-setup';
import { loadOfflineCity, showOfflineCity, hasOfflineBuildings, resetOfflineBuildings } from './buildings-geojson';
import { getViirsField } from './viirs-field';
import { smoothstep } from '$lib/utils';
import { altitudeDetailMix, NIGHT_EMISSIVE_WHITE_POINT } from '$lib/world/altitude';
import { enableNightIbl } from './night-ibl';
import { CESIUM_QUALITY_PRESETS } from './cesium-setup';
import { EpsilonGate } from './util';
import { registerViewerTeardown } from './viewer-lifecycle';

type C = typeof CesiumType;

interface BuildingsShader {
	setUniform(name: string, value: number): void;
}

let _cs: C;
let _viewer: CesiumType.Viewer;

let tileset: CesiumType.Cesium3DTileset | null = null;
/** True when tier 1 (Ion) is unavailable, so tier 2 is allowed to draw. */
let _offlineTier = false;
let _shader: BuildingsShader | null = null;
let _time = 0;
let _cityBrightness = 1;
let _cityBrightnessTimer = 0;
const _show = new EpsilonGate<boolean>(0, true);
const _nightFactor = new EpsilonGate<number>(0.02, -1);

export function initBuildings(Cesium: C, viewer: CesiumType.Viewer): void {
	_cs = Cesium; _viewer = viewer;
	// Same reason as imagery: the tileset + custom shader belong to the
	// previous viewer's scene. Holding them past a remount makes syncBuildings
	// push uniforms into a primitive no longer attached to anything.
	resetBuildingsViewerState();
}

/**
 * Tier 1 handles belong to the scene that just went away; tier 2's cached city
 * primitives would otherwise report as still loaded, leaving the new viewer
 * with no skyline at all. `_offlineTier` is re-decided by setupBuildings.
 *
 * The gates are module-level singletons but the VIEWER is not: on remount the
 * fresh viewer has Cesium defaults while the gates still hold the previous
 * viewer's last-written values, so the first sync sees "unchanged" and skips
 * applying them.
 */
export function resetBuildingsViewerState(): void {
	tileset = null;
	_shader = null;
	resetOfflineBuildings();
	_offlineTier = false;
	_show.reset();
	_nightFactor.reset();
	// Module-singleton and CAMERA-derived, so exactly the state AGENTS.md's
	// init-reset rule is about: retained across a remount they carry the previous
	// viewer's city brightness into the new one. The viewer-lifecycle test cannot
	// see this — it asserts the module is REGISTERED, not that its reset is
	// complete.
	_cityBrightness = 1;
	_cityBrightnessTimer = 0;
}
registerViewerTeardown('buildings', resetBuildingsViewerState);

/**
 * Rooftop aviation beacon contract — kept as JS numbers so the shader
 * template and the unit contract test share one SSOT (whole-skyline pulse
 * regressions are invisible at typecheck).
 */
export const BUILDING_BEACON = {
	/** smoothstep low — mid-rise blocks must NOT light (was 30 m). */
	heightMinM: 120,
	/** smoothstep high — fully on by this height. */
	heightMaxM: 160,
	/** XY block size for per-tower phase hash (metres of model space). */
	phaseBlockM: 25,
	/** Blink duty: on when fract(t*rate + phase) > this (≈0.45 duty). */
	blinkThreshold: 0.55,
	/** Cycles per second of the blink oscillator. */
	blinkHz: 0.5,
} as const;

const BUILDING_VERTEX_GLSL = `
	void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
		v_normalMC = vsInput.attributes.normalMC;
	}
`;

const BUILDING_SHADER_GLSL = `
	void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
		vec3 normal = normalize(v_normalMC);

		// Surface orientation detection
		float upDot = abs(dot(normal, vec3(0.0, 0.0, 1.0)));
		float isWall = smoothstep(0.3, 0.7, 1.0 - upDot);
		float isRoof = smoothstep(0.7, 0.9, upDot);

		vec3 wp = fsInput.attributes.positionMC;
		float buildingHeight = wp.z;
		float floorHeight = 3.0;
		float floorIndex = floor(wp.z / floorHeight);
		float isGroundFloor = step(floorIndex, 0.5);

		// Height-based window density: taller buildings = more lit (office towers).
		float heightFactor = smoothstep(10.0, 80.0, buildingHeight);

		// District gate from VIIRS. Scales HOW MANY windows are lit rather than
		// how bright each one is — the physical difference between a sparse
		// outer district and a dense core is occupancy, not bulb wattage.
		// Floored at 0.35: a building with every window dark reads as derelict
		// rather than quiet, and OSM footprints exist in places VIIRS calls
		// near-black. Ceiling stays 1.0 so a metro core is unchanged from
		// before this gate existed.
		float cityMix = mix(0.35, 1.0, u_cityBrightness);
		float adjustedDensity = mix(u_windowDensity * 0.4, u_windowDensity * 1.3, heightFactor) * cityMix;

		// In-plane horizontal coordinate for the window grid. Walls whose
		// normal points along ±X vary in Y across the face (and vice versa);
		// the Feb-15 recipe used wp.x unconditionally, which collapsed
		// X-facing walls into featureless floor-bands (gridUV.x constant
		// across the face). Pure position+normal selection — still fully
		// deterministic across the 3-Pi fleet (invariant #4).
		float facingX = step(abs(normal.y), abs(normal.x));
		float horiz = mix(wp.x, wp.y, facingX);

		// Window grid pattern
		float windowWidth = mix(0.55, 0.8, isGroundFloor);
		float windowHeight = mix(0.65, 0.85, isGroundFloor);
		vec2 gridUV = fract(vec2(horiz * 0.12, wp.z / floorHeight));
		float windowX = smoothstep(0.5 - windowWidth * 0.5, 0.5 - windowWidth * 0.5 + 0.05, gridUV.x)
		             * smoothstep(0.5 + windowWidth * 0.5, 0.5 + windowWidth * 0.5 - 0.05, gridUV.x);
		float windowY = smoothstep(0.5 - windowHeight * 0.5, 0.5 - windowHeight * 0.5 + 0.05, gridUV.y)
		             * smoothstep(0.5 + windowHeight * 0.5, 0.5 + windowHeight * 0.5 - 0.05, gridUV.y);
		float windowMask = windowX * windowY;

		// Per-window random (hash from cell position)
		vec2 cellId = vec2(floor(horiz * 0.12), floorIndex);
		float rand = fract(sin(dot(cellId, vec2(127.1, 311.7))) * 43758.5453);

		// Floor-level randomization (some whole floors dark = empty offices)
		float floorRand = fract(sin(floorIndex * 131.7) * 43758.5453);
		float floorLit = step(0.2, floorRand);
		float fullyLitFloor = step(0.93, floorRand); // ~7% of floors fully lit

		float lit = step(1.0 - adjustedDensity, rand) * floorLit;
		lit = max(lit, fullyLitFloor); // fully lit floors override

		// Window color variation (5 types)
		float colorMix = fract(sin(dot(cellId, vec2(269.5, 183.3))) * 7461.7);
		// Palette: white/warm-white dominant (60%), gold accents (25%), cool blue (15%).
		vec3 warmColor   = vec3(1.0, 0.75, 0.35);   // warm amber residential
		vec3 coolColor   = vec3(1.0, 0.88, 0.55);   // warm gold office
		vec3 retailColor = vec3(1.0, 0.82, 0.45);   // amber retail
		vec3 screenColor = vec3(0.9, 0.85, 0.6);    // warm screen glow
		vec3 officeWhite = vec3(1.0, 0.94, 0.78);   // warm white (never pure)
		vec3 upperColor = mix(
			mix(warmColor, coolColor, smoothstep(0.0, 0.4, colorMix)),
			mix(screenColor, officeWhite, smoothstep(0.6, 1.0, colorMix)),
			step(0.5, colorMix)
		);
		vec3 windowColor = mix(upperColor, retailColor, isGroundFloor);

		// Per-window brightness variation
		float brightVar = fract(sin(dot(cellId, vec2(419.2, 371.9))) * 29475.1);
		float windowBright = mix(0.6, 1.4, brightVar);

		// Subtle flicker (AC hum simulation)
		float flicker = 0.93 + 0.07 * sin(u_time * 0.3 + rand * 6.28);

		// Street-level ambient glow (sodium lamps illuminate building bases)
		// Aug-2026: widened 6 m → 14 m and raised 0.4 → 0.55 — the bases now
		// carry the wash up the first few floors instead of a ground-level
		// smear, which is what makes street lighting read as GLOW.
		float streetGlow = smoothstep(14.0, 0.0, wp.z) * 0.55;
		vec3 streetLampColor = vec3(1.0, 0.72, 0.28); // classic HPS lamp — deeper amber

		// Subtle facade glow — district light spill onto wall surfaces, scaled
		// by the VIIRS city-brightness gate so bright cores bloom faintly and
		// sparse districts stay dark. Walls only (roofs keep the beacons).
		// Kept far under the tone-map knee: a wash, not a light source.
		vec3 districtGlow = vec3(1.0, 0.78, 0.45) * cityMix * 0.025 * isWall;

		// Rooftop aviation warning lights — genuinely tall towers ONLY, each on
		// its own phase. Two failures made the whole skyline pulse red in
		// lockstep: the 30–50 m threshold caught every mid-rise block, and a
		// bare fract(u_time) shared one phase across all buildings. Real
		// obstruction beacons are sparse (120 m+ structures) and never
		// synchronised. Numbers from BUILDING_BEACON (JS SSOT).
		float isTall = smoothstep(${BUILDING_BEACON.heightMinM.toFixed(1)}, ${BUILDING_BEACON.heightMaxM.toFixed(1)}, buildingHeight);
		// Per-block phase hash — deterministic, so all 3 Pis agree.
		float beaconPhase = fract(sin(dot(floor(wp.xy / ${BUILDING_BEACON.phaseBlockM.toFixed(1)}), vec2(12.9898, 78.233))) * 43758.5453);
		float blink = step(${BUILDING_BEACON.blinkThreshold.toFixed(2)}, fract(u_time * ${BUILDING_BEACON.blinkHz.toFixed(2)} + beaconPhase));
		float rooftopLight = isRoof * isTall * blink;
		vec3 aviationRed = vec3(1.0, 0.08, 0.03);

		// Build the window emission: lit windows + street-level ambient + aviation lights.
		//
		// ─── ⚠ TONE-MAP, DO NOT LINEARLY SCALE ──────────────────────────────────
		// u_lightIntensity carries config.world.nightLightIntensity, a 0..5 operator
		// GAIN. Cesium's material.emissive is LDR: over 1.0 per channel clips to
		// pure white. Applied raw at the 5.0 default the peak channel hit 7.0 and
		// even the DIMMEST window reached 2.79, so every window clipped and the
		// palette above (warm amber / gold / warm-white-never-pure) collapsed into
		// identical white boxes.
		//
		// Dividing the gain down fixes the clipping but costs 5x the brightness —
		// the city then reads as dim. Reinhard tone-mapping is the right tool: it
		// compresses the HDR range into 0..1 so bright windows stay BRIGHT (a raw
		// 7.0 lands at ~0.88) while dim ones stay separable (~0.74) and every
		// value keeps its hue. The gain stays a real exposure control across its
		// whole travel instead of saturating instantly.
		vec3 hdrEmission = (windowColor * windowBright * flicker * lit) * u_lightIntensity
			+ streetLampColor * streetGlow * u_nightFactor * u_lightIntensity
			+ districtGlow * u_nightFactor * u_lightIntensity
			+ aviationRed * rooftopLight * u_nightFactor * u_lightIntensity;

		// Reinhard with a white point: x * (1 + x/W^2) / (1 + x). W is the raw
		// channel value that should map to pure white, so anything at or above it
		// reads fully lit without flattening everything below it.
		const float W = ${NIGHT_EMISSIVE_WHITE_POINT.toFixed(1)};
		vec3 emission = hdrEmission * (1.0 + hdrEmission / (W * W)) / (1.0 + hdrEmission);

		// Darken building surfaces at night so emissive reads cleanly — but
		// the facade still has to read as SOLID. At 0.06 the mass all but
		// vanished and the lit windows floated as holes, so the tower looked
		// see-through against whatever was behind it. 0.18 keeps the emissive
		// dominant while leaving enough facade to occlude.
		material.diffuse *= mix(1.0, 0.18, u_nightFactor);
		material.emissive = emission * u_nightFactor;
	}
`;

export async function setupBuildings(
	buildingsEnabled: boolean,
	useDynamicEnvironmentMap = false,
): Promise<void> {
	if (!getIonToken()) {
		// No token: fall through to the packaged-GeoJSON tier instead of
		// returning to an empty sky. Nothing is loaded here — the city isn't
		// known until the first syncBuildings — this only records that tier 1
		// is unavailable so tier 2 is allowed to draw.
		_offlineTier = true;
		console.info('[Buildings] No Ion token — using packaged GeoJSON footprints');
		return;
	}
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const C = _cs as any;
	try {
		tileset = await _cs.createOsmBuildingsAsync();
		if (!tileset) return;
		tileset.show = buildingsEnabled;
		tileset.maximumScreenSpaceError = CESIUM_QUALITY_PRESETS.balanced.maximumScreenSpaceError;

		// ─── ONCE LOADED, KEEP IT ───────────────────────────────────────────
		// Buildings were visibly vanishing and re-appearing during flight. That
		// is not a loading delay, it is EVICTION: the tileset's cache defaults
		// are sized for a free-roaming globe app where the camera can go
		// anywhere, so tiles behind the camera get dropped and then have to be
		// re-fetched and re-decoded when the orbit brings them back around.
		//
		// This kiosk is the opposite case. It orbits a handful of fixed cities
		// forever on a machine with 8 GB of RAM and, once packaged, no network
		// worth speaking of. Re-fetching a tile we already had is pure loss:
		// the reload is visible as a hole in the skyline, and it costs more
		// than simply holding the geometry.
		//
		// A generous cache is also strictly cheaper at STEADY STATE than the
		// churn it replaces — no re-request, no re-parse, no re-upload to the
		// GPU every orbit. The peak cost is bounded by the fact that the fleet
		// only ever visits eight locations.
		const t = tileset as unknown as {
			cacheBytes?: number;
			maximumCacheOverflowBytes?: number;
			maximumMemoryUsage?: number;
			preloadWhenHidden?: boolean;
			preloadFlightDestinations?: boolean;
		};
		// Cesium renamed this: cacheBytes on current versions, maximumMemoryUsage
		// (in MB) on older ones. Set whichever exists rather than pinning a
		// version — an unknown property assignment is silently inert either way.
		t.cacheBytes = 1_536 * 1024 * 1024;
		t.maximumCacheOverflowBytes = 768 * 1024 * 1024;
		t.maximumMemoryUsage = 1_536;
		// Keep tiles warm across the blind-closed cruise transition, and prefetch
		// the destination during a hop so arrival is not a skyline building
		// itself in front of the viewer.
		t.preloadWhenHidden = true;
		t.preloadFlightDestinations = true;
		tileset.shadows = _cs.ShadowMode.ENABLED;
		tileset.colorBlendMode = _cs.Cesium3DTileColorBlendMode.HIGHLIGHT;

		try {
			_shader = new C.CustomShader({
				mode: C.CustomShaderMode.MODIFY_MATERIAL,
				lightingModel: C.LightingModel.PBR,
				uniforms: {
					u_nightFactor:    { type: C.UniformType.FLOAT, value: 0.0 },
					u_lightIntensity: { type: C.UniformType.FLOAT, value: 1.0 },
					u_windowDensity:  { type: C.UniformType.FLOAT, value: 0.0 },
					u_cityBrightness: { type: C.UniformType.FLOAT, value: 1.0 },
					u_time:           { type: C.UniformType.FLOAT, value: 0.0 },
				},
				varyings: { v_normalMC: C.VaryingType.VEC3 },
				vertexShaderText: BUILDING_VERTEX_GLSL,
				fragmentShaderText: BUILDING_SHADER_GLSL,
			});
			tileset.customShader = _shader as unknown as CesiumType.CustomShader;
		} catch (e) {
			console.warn('[Buildings] Custom shader failed:', (e as { message?: string })?.message ?? String(e));
			_shader = null;
		}

		// Opt-in night IBL TUNING (see world/night-ibl.ts). Cesium already runs
		// the environment map by default; this retunes it for night. Default-off
		// and a no-op on a Cesium without the API, so today's look is unchanged
		// until the flag is turned on deliberately.
		if (useDynamicEnvironmentMap) {
			const ok = enableNightIbl(_cs, tileset);
			console.info(`[Buildings] dynamic environment map: ${ok ? 'enabled' : 'unavailable'}`);
		}

		_viewer.scene.primitives.add(tileset);
	} catch (e) { console.warn('[Buildings] OSM unavailable:', (e as Error).message); }
}

export function syncBuildings(
	wallSec: number, nf: number, scale: number, altFt: number,
	buildingsEnabled: boolean, windowLightIntensity: number, bootFade: number,
	/** When set, window density tracks cityLightAmount (same twilight gate as wing nav + VIIRS intent). */
	cityLightAmount?: number,
): void {
	if (!tileset) return;
	_show.update(buildingsEnabled, (v) => { tileset!.show = v; });

	if (_shader) {
		// Window flicker phase from the wall second, not an accumulator: three
		// panes show the same window lit at the same instant, and a rebooted
		// pane rejoins the pattern instead of restarting it.
		_time = wallSec % (Math.PI * 4000);
		_shader.setUniform('u_nightFactor', nf * bootFade);
		_shader.setUniform('u_lightIntensity', scale);
		// Prefer SSOT cityLightAmount; fall back to legacy smoothstep if caller omits it.
		const lightGate = cityLightAmount ?? smoothstep((nf - 0.15) / 0.7);
		_shader.setUniform('u_windowDensity', (1 - altitudeDetailMix(altFt)) * lightGate * windowLightIntensity);
		_shader.setUniform('u_time', _time);
		_shader.setUniform('u_cityBrightness', sampleCityBrightness());
		return;
	}

	// Fallback: uniform amber style when shader unavailable.
	_nightFactor.update(nf, (v) => {
		tileset!.style = new _cs.Cesium3DTileStyle({
			color: `color("rgb(255, 200, 50)", ${Math.max(0.3, v * 0.9).toFixed(2)})`,
		});
	});
}

function sampleCityBrightness(): number {
	const now = performance.now();
	if (now - _cityBrightnessTimer < 500) return _cityBrightness;
	_cityBrightnessTimer = now;

	const carto = _viewer?.camera?.positionCartographic;
	if (!carto) return _cityBrightness;
	const C = _cs;
	const lat = C.Math.toDegrees(carto.latitude);
	const lon = C.Math.toDegrees(carto.longitude);
	const field = getViirsField(lat, lon);
	if (!field) return _cityBrightness;

	const STEP_DEG = 0.018;
	let sum = 0, count = 0;
	for (let dy = -1; dy <= 1; dy++)
		for (let dx = -1; dx <= 1; dx++) {
			const s = field.sampleBilinear(lat + dy * STEP_DEG, lon + dx * STEP_DEG);
			if (s > 0) { sum += s; count++; }
		}
	const target = count > 0 ? sum / count : field.sampleBilinear(lat, lon);
	_cityBrightness += (target - _cityBrightness) * 0.3;
	return _cityBrightness;
}

export function setBuildingsWireframe(enabled: boolean): void {
	if (!tileset) return;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(tileset as any).debugWireframe = enabled;
}

export function updateBuildingsQuality(maximumScreenSpaceError: number): void {
	if (tileset) tileset.maximumScreenSpaceError = maximumScreenSpaceError;
}

/**
 * Tier-2 per-tick: make sure the current city's footprints exist and are the
 * only ones showing.
 *
 * Separate from syncBuildings rather than another pair of positional
 * parameters on a function that already takes eight. It is also a genuinely
 * different job: syncBuildings drives shader uniforms every frame, this one
 * does nothing at all unless the location changed.
 *
 * No-op unless tier 1 failed — with a token present the Ion tileset is the
 * skyline and this must not add a second, coarser one on top of it.
 */
export function syncOfflineBuildings(
	locationId: LocationId,
	buildingsEnabled: boolean,
	exaggeration = 1,
): void {
	if (!_offlineTier || !_viewer) return;
	// Nature locations have no skyline by design (himalayas, ocean, desert).
	// Read from the catalogue rather than taking it as a parameter: it is
	// static content, and threading it through compose would widen the
	// CesiumModelView interface for a fact the catalogue already owns.
	if (!LOCATION_MAP.get(locationId)?.hasBuildings) {
		showOfflineCity(null, false);
		return;
	}
	if (!hasOfflineBuildings(locationId)) {
		void loadOfflineCity(_cs, _viewer, locationId, exaggeration);
	}
	showOfflineCity(locationId, buildingsEnabled);
}

