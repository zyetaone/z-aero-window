/**
 * The window: the place's ground to the horizon, its buildings, a cloud deck,
 * Babylon's physically based sky and the real stars, seen from a camera
 * circling the place's pin.
 *
 * Units are metres, y up, x east, z north (see world.ts). Everything that moves
 * moves on the wall clock, so three panes agree without talking.
 *
 * Params (all optional, so `frame-cost.mjs` can pin a scene):
 *   ?place=hyderabad (pin a city; omit it to follow the rotation)  ?clock=6 (local solar hour)  ?yaw=0 (pane offset, deg)
 *   ?scale=1 (hardware scaling)  ?gpu=webgpu  ?hud=0  ?clouds=1 (cover, 0 = clear)
 *   ?weather=clear|fair|scattered|towering|cirrus (pin today's regime)
 *   ?lamps=1 (lamp gain)  ?lift=8 (twilight exposure)  ?glow=0 (no bloom)  ?carpet=1 (VIIRS texture)
 */
import { Color4, DirectionalLight, Engine, FreeCamera, GlowLayer, PBRMaterial, Scene, Vector3, WebGPUEngine, type AbstractEngine } from '@babylonjs/core';
import { Atmosphere } from '@babylonjs/addons/atmosphere';
import { buildings } from './buildings.ts';
import { clouds, weatherFor } from './clouds.ts';
import { streetlights } from './lights.ts';
import { trees } from './trees.ts';
import { destinationAt, PLACES } from './places.ts';
import { haze } from './haze.ts';
import { stars } from './stars.ts';
import { atSolarHour, solarHour, sunAt } from './sun.ts';
import { createWorld } from './world.ts';
import { RAD, smoothstep } from './math.ts';

// id → [lat, lon, ground m]. Same coordinates as aero-2's catalog.

const CRUISE_M = 3500; // above ground
const CLEAR_M = 2_000; // over the highest terrain within 8 km of the orbit
const DECK_M = 1800; // cloud base above ground: the window looks down onto it
const SPEED_M_S = 230; // ~450 kt
const ORBIT_M = 9000;
const LAMP_ALPHA = 0.22;
const GLOW = 0.35;

const q = new URLSearchParams(location.search);
// ?place= pins a city; otherwise the wall-clock rotation picks it, the same on every pane.
const pinnedPlace = q.get('place') && Object.hasOwn(PLACES, q.get('place')!) ? q.get('place')! : null;
const placeId = pinnedPlace ?? destinationAt(Date.now() / 1000);
// When the rotation moves on, start over in the next city: a reload frees every buffer of this one.
if (!pinnedPlace) setInterval(() => destinationAt(Date.now() / 1000) !== placeId && location.reload(), 1000);
const [lat, lon, groundM, orbitM = ORBIT_M] = PLACES[placeId]!;
const paneYaw = Number(q.get('yaw') ?? 0) * RAD;
const lampGain = Number(q.get('lamps') ?? 1);
const twilightLift = Number(q.get('lift') ?? 8);
// The baked VIIRS texture under the lamp points: a faint glow only, or it reads as blocky amber blobs.
const carpet = Number(q.get('carpet') ?? 1);
let pinnedHour = q.has('clock') ? Number(q.get('clock')) : null;
// The Lights panel's live gains (lightsPanel): street lamps, building lights, far towns, bloom.
const mix = { street: 1, building: 1, far: 1, glow: GLOW, haze: 0.12 };

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const engine = await createEngine(canvas, q.get('gpu') === 'webgpu');
// A kiosk has no one to press reload. A failed boot (tiles not served yet, a truncated pack)
// retries, and a lost GL context reloads: clearCachedVertexData below leaves nothing to rebuild from.
addEventListener('unhandledrejection', () => setTimeout(() => location.reload(), 10_000), { once: true });
engine.onContextLostObservable.add(() => location.reload());
engine.setHardwareScalingLevel(Number(q.get('scale') ?? 1));

const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 1);
scene.skipPointerMovePicking = true;

const sunLight = new DirectionalLight('sun', new Vector3(0, -1, 0), scene);
const atmosphere = Atmosphere.IsSupported(engine) ? new Atmosphere('atmosphere', scene, [sunLight]) : null;

const camera = new FreeCamera('window', Vector3.Zero(), scene);
camera.fov = 45 * RAD;
camera.minZ = 10;
camera.maxZ = 1_000_000;

const world = await createWorld(scene, lat, lon);
// Today's sky for this place: the same on every pane, different tomorrow. ?weather= pins a regime.
const weather = weatherFor(placeId, Date.now(), q.get('weather'));
const [pinX, pinZ] = world.project(lon, lat);
// Cruise over the place's ground, but never into it: in the mountains the orbit clears the highest
// terrain in a band 8 km either side of it (sampled once, every ~1 km) by CLEAR_M. Flat cities keep plain CRUISE_M.
const peakM = Array.from({ length: 17 * 180 }, (_, i) => {
	const [a, r] = [((i % 180) / 180) * 2 * Math.PI, orbitM + (Math.floor(i / 180) - 8) * 1_000];
	const [x, z] = [pinX + r * Math.cos(a), pinZ + r * Math.sin(a)];
	return world.groundAt(x, z) + world.drop(x, z);
}).reduce((a, b) => Math.max(a, b));
const cruiseM = Math.max(groundM + CRUISE_M, peakM + CLEAR_M);
const [city, roads, deck, sky] = await Promise.all([
	loadCity(),
	fetchPack('roads'),
	clouds(scene, camera, sunLight, [pinX, pinZ], groundM + DECK_M, world.groundAt, world.drop, weather, Number(q.get('clouds') ?? 1)),
	stars(scene, camera, lat, lon)
]);
// Street lamps along the road pack, roof lights and lit windows on the buildings, and NASA-derived
// towns on the far ring past the roads (lights.ts).
const lamps = streetlights(roads ?? [], world.project, world.groundAt, scene, city?.roofLights, world.sites, city?.windows);
const treeCount = q.get('trees') === '0' ? 0 : trees(scene, [pinX, pinZ], world.imagery, world.groundAt);
const cityHaze = await haze(scene, world.hazeMap, world.nearSizeM, groundM, world.drop);
// Everything is built: drop the CPU copies of vertex data (the GPU has them; nothing here picks or edits).
scene.clearCachedVertexData();
const glowing = [...world.materials, ...(city ? [city.material] : [])];
// Everything that takes the sky's ambient light by day (ambientColor white); faded out after dusk,
// where the twilight exposure lift would otherwise turn the night sky's faint light into grey.
const skyLit = [...glowing, scene.getMaterialByName('trees')].filter((m) => m instanceof PBRMaterial);

// Babylon's bloom on everything emissive: lamps halo, windows and the city carpet glow.
// Night only — by day it is switched off and costs nothing.
const glow = q.get('glow') === '0' ? null : new GlowLayer('glow', scene, { mainTextureRatio: 0.25, blurKernelSize: 16 });
// Lamps only: the glow pass re-renders whatever it includes, and re-rendering the ground's
// atmosphere-plugin PBR materials blew the dusk sky to white.
if (glow && lamps) {
	glow.addIncludedOnlyMesh(lamps.mesh);
	glow.referenceMeshToUseItsOwnMaterial(lamps.mesh);
}
// Lit windows halo too: the glow pass draws the city through its own emissive shader.
if (city) glow?.addIncludedOnlyMesh(city.mesh);

const hud = q.get('hud') === '0' ? null : clockControls();
if (hud) lightsPanel(), placePicker();
if (q.has('debug')) Object.assign(globalThis, { scene, camera, world, treeCount, weather }); // for the console and frame-cost ablations
let hudAt = 0;
const toSun = new Vector3();

engine.runRenderLoop(() => {
	const now = Date.now();
	const skyMs = pinnedHour === null ? now : atSolarHour(now, lon, pinnedHour);
	const s = sunAt(skyMs, lat, lon);
	sunLight.direction.set(-s.x, -s.y, -s.z);

	// Lamps, window glow, stars and the eye's twilight adaptation all follow the sun, not the hour.
	const dark = 1 - smoothstep(-8, 2, s.elevationDeg);
	// The VIIRS texture bakes its own balance (world.ts); ?carpet= scales it from there.
	// The twilight lift multiplies emissive too, so divide it back out: 0.12 means 0.12 at night.
	const exposure = 1 + twilightLift * dark;
	if (atmosphere) atmosphere.exposure = exposure;
	for (const m of skyLit) m.ambientColor.setAll(1 - dark);
	cityHaze((mix.haze * dark) / exposure); // emissive, so it rides the exposure lift too
	for (const m of glowing) m.emissiveIntensity = (lampGain * dark * (m !== city?.material ? carpet : 1)) / exposure;
	// Faint per lamp: ~200k additive points sum to a white sheet at anything brighter.
	lamps?.update(camera.position, now, Math.min(0.999, LAMP_ALPHA * lampGain * dark), mix);
	if (glow) {
		glow.isEnabled = dark > 0.02;
		glow.intensity = mix.glow * dark;
	}

	// Counter-clockwise orbit around the pin: the left window faces the city.
	const theta = ((now / 1000) * SPEED_M_S) / orbitM;
	const [x, z] = [pinX + orbitM * Math.cos(theta), pinZ + orbitM * Math.sin(theta)];
	camera.position.set(x, cruiseM - world.drop(x, z), z);
	camera.rotation.set(12 * RAD, Math.atan2(pinX - x, pinZ - z) + paneYaw, 0);

	deck.update(now, toSun.set(s.x, s.y, s.z), dark);
	sky.update(skyMs, 1 - smoothstep(-14, -4, s.elevationDeg));
	scene.render();

	if (hud && now - hudAt > 250) {
		hudAt = now;
		hud(skyMs, s.elevationDeg);
	}
});
addEventListener('resize', () => engine.resize());

async function createEngine(target: HTMLCanvasElement, wantWebGPU: boolean): Promise<AbstractEngine> {
	if (wantWebGPU && (await WebGPUEngine.IsSupportedAsync)) {
		const gpu = new WebGPUEngine(target, { antialias: false });
		await gpu.initAsync();
		return gpu;
	}
	return new Engine(target, false, { stencil: false, powerPreference: 'high-performance' });
}

/** The place's OSM footprints, if it has a pack (see buildings.ts). */
async function loadCity() {
	const features = await fetchPack('buildings');
	return features && buildings(features, world.project, world.groundAt, scene);
}

/** A place's GeoJSON pack's features, or null when the place has none. */
async function fetchPack(kind: 'buildings' | 'roads') {
	const res = await fetch(`/${kind}/${placeId}.geojson`);
	return res.ok ? (await res.json()).features : null;
}

/** The time-of-day slider: drag to pin the sky to an hour, "Now" to follow the real sun again. */
/** The place picker: Rotation follows the wall clock; a city pins it (?place=). Both reload. */
function placePicker() {
	const select = document.querySelector<HTMLSelectElement>('#place')!;
	select.add(new Option('Rotation', ''));
	for (const id of Object.keys(PLACES)) select.add(new Option(id.replace('_', ' '), id));
	select.value = pinnedPlace ?? '';
	select.addEventListener('change', () => {
		const url = new URL(location.href);
		if (select.value) url.searchParams.set('place', select.value);
		else url.searchParams.delete('place');
		location.assign(url);
	});
}

/** The Lights panel: each slider writes one gain in `mix`, read by the render loop. */
function lightsPanel() {
	for (const input of document.querySelectorAll<HTMLInputElement>('#lights input')) {
		const key = input.name as keyof typeof mix;
		input.value = String(mix[key]);
		input.addEventListener('input', () => (mix[key] = Number(input.value)));
	}
}

function clockControls() {
	const panel = document.querySelector<HTMLElement>('#hud')!;
	const slider = panel.querySelector<HTMLInputElement>('input')!;
	const [readout, live] = [panel.querySelector('output')!, panel.querySelector('button')!];
	panel.hidden = false;
	slider.addEventListener('input', () => (pinnedHour = Number(slider.value)));
	live.addEventListener('click', () => (pinnedHour = null));
	return (skyMs: number, elevationDeg: number) => {
		const hour = solarHour(skyMs, lon);
		slider.value = String(hour);
		const hhmm = `${Math.floor(hour)}`.padStart(2, '0') + ':' + `${Math.floor((hour % 1) * 60)}`.padStart(2, '0');
		readout.textContent = `${hhmm} solar · sun ${elevationDeg.toFixed(0)}° · ${Number.isFinite(engine.getFps()) ? engine.getFps().toFixed(0) : '–'} fps ${engine.isWebGPU ? 'WebGPU' : 'WebGL2'}`;
		live.disabled = pinnedHour === null;
	};
}
