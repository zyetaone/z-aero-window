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
 *   ?role=left|center|right (pane in the wall)  ?wall=http://<center>:3300 (whose wall to follow)
 *   ?audio=0 (no cabin drone; only centre/solo panes play it)
 *   ?blind=0 (no blind, no reload: hold one visit)  ?frame=0 (no window rim)
 *   ?lamps=1 (lamp gain)  ?lift=8 (twilight exposure)  ?glow=0 (no bloom)  ?carpet=1 (VIIRS texture)
 */
import { Color4, DirectionalLight, Engine, FreeCamera, GlowLayer, PBRMaterial, Quaternion, Scene, Vector3, WebGPUEngine, type AbstractEngine } from '@babylonjs/core';
import { Atmosphere } from '@babylonjs/addons/atmosphere';
import { buildings } from './buildings.ts';
import { clouds } from './clouds.ts';
import { dayFor } from './day.ts';
import { flight, SEAT_PITCH } from './flight.ts';
import { streetlights } from './lights.ts';
import { trees } from './trees.ts';
import { destinationAt, DWELL_SEC, PLACES, slotAt } from './places.ts';
import { haze } from './haze.ts';
import { adminQr, cabinDrone, cabinOverlay } from './cabin.ts';
import { moon } from './moon.ts';
import { wing } from './wing.ts';
import { stars } from './stars.ts';
import { atSolarHour, solarHour, sunAt } from './sun.ts';
import { createWorld } from './world.ts';
import { fetchWall, NO_WALL } from './wall.ts';
import { hash, RAD, smoothstep } from './math.ts';

// id → [lat, lon, ground m]. Same coordinates as aero-2's catalog.

const CRUISE_M = 3500; // above ground
const CLEAR_M = 2_000; // over the highest terrain within 8 km of the orbit
const ORBIT_M = 9000;
const LAMP_ALPHA = 0.22;
const GLOW = 0.35;

const q = new URLSearchParams(location.search);
/** A numeric param, or its default when absent or not a finite number (?scale=abc must not NaN the engine). */
const num = (name: string, fallback: number) => (q.has(name) && Number.isFinite(Number(q.get(name))) ? Number(q.get(name)) : fallback);
// The operator's wall (wall.ts), from ?wall=<center Pi's origin> or this pane's own server. Read
// before anything is chosen; unreachable within 2 s means no wall. URL params still win.
const wallOrigin = q.get('wall') ?? '';
const wall = await fetchWall(wallOrigin);
// ?place= (or the wall) pins a city; otherwise the wall-clock rotation picks it, the same on every pane.
const asked = q.get('place') ?? wall.place;
const pinnedPlace = asked && Object.hasOwn(PLACES, asked) ? asked : null;
// Every visit slot (10 min) is a fresh flight: a new city when following the rotation, a new
// direction and today's weather either way. The blind closes over the boundary and the page reloads
// behind it, which also frees every buffer of the last visit. ?blind=0 holds one visit (screenshots).
const bootSlot = slotAt(Date.now() / 1000);
const placeId = pinnedPlace ?? destinationAt(Date.now() / 1000);
const blinds = q.get('blind') !== '0';
if (blinds) setInterval(() => slotAt(Date.now() / 1000) !== bootSlot && location.reload(), 1000);
const [lat, lon, groundM, orbitM = ORBIT_M] = PLACES[placeId]!;
const track = flight(Math.floor(hash(bootSlot * 0x2545f491 + groundM) * 2 ** 31), orbitM);
// The pane's place in the wall: the outer two look 24° off the centre (aero-2's parallax), ?yaw= exact.
const ROLE_YAW: Record<string, number> = { left: -24, right: 24 };
const paneYaw = num('yaw', ROLE_YAW[q.get('role') ?? ''] ?? 0) * RAD;
const lampGain = num('lamps', 1);
const twilightLift = num('lift', 8);
// The baked VIIRS texture under the lamp points: a faint glow only, or it reads as blocky amber blobs.
const carpet = num('carpet', 1);
let pinnedHour: number | null = num('clock', NaN);
if (Number.isNaN(pinnedHour)) pinnedHour = wall.clock;
// The Lights panel's live gains (lightsPanel): street lamps, building lights, far towns, bloom.
const mix = { street: 1, building: 1, far: 1, glow: GLOW, haze: 0.12 };

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const engine = await createEngine(canvas, q.get('gpu') === 'webgpu');
// A kiosk has no one to press reload. A failed boot (tiles not served yet, a truncated pack)
// retries, and a lost GL context reloads: clearCachedVertexData below leaves nothing to rebuild from.
addEventListener('unhandledrejection', recover, { once: true });
engine.onContextLostObservable.add(recover);
const baseScale = Math.max(0.25, num('scale', 1));
engine.setHardwareScalingLevel(baseScale);
// A hot Pi sheds (health-check.sh, served at /api/thermal): fewer pixels, no bloom, no haze, until it cools.
let shedding = false;
setInterval(async () => {
	const state = await fetch('/api/thermal').then((r) => r.json()).catch(() => null);
	shedding = state?.action === 'shed';
	engine.setHardwareScalingLevel(shedding ? baseScale * 1.5 : baseScale);
}, 30_000);

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
// Today for this place, from the visit's slot start: the same on every pane, different tomorrow.
const day = dayFor(placeId, bootSlot * DWELL_SEC * 1000, q.get('weather') ?? wall.weather);
sunLight.intensity = day.sun;
if (atmosphere) atmosphere.aerialPerspectiveIntensity *= day.haze;
const [pinX, pinZ] = world.project(lon, lat);
// Cruise over the place's ground, but never into it: in the mountains the track clears the highest
// terrain within 4 km of it (one circuit, sampled once) by CLEAR_M. Flat cities keep plain CRUISE_M.
let peakM = -Infinity;
for (let i = 0; i < 720; i++) {
	const [tx, tz] = track.at((i / 720) * track.periodSec);
	for (const [dx, dz] of [[0, 0], [4e3, 0], [-4e3, 0], [0, 4e3], [0, -4e3]]) {
		const [x, z] = [pinX + tx + dx!, pinZ + tz + dz!];
		peakM = Math.max(peakM, world.groundAt(x, z) + world.drop(x, z));
	}
}
const cruiseM = Math.max(groundM + CRUISE_M, peakM + CLEAR_M);
const [city, roads, deck, sky] = await Promise.all([
	loadCity(),
	fetchPack('roads'),
	clouds(scene, camera, sunLight, [pinX, pinZ], groundM + day.deckM, world.groundAt, world.drop, day, num('clouds', 1)),
	stars(scene, camera, lat, lon)
]);
const luna = moon(scene, camera, lat, lon);
const plane = q.get('wing') === '0' ? null : await wing(scene);
// One pane makes the sound: the centre (or a lone pane). ?audio=0 for silence.
const drone = q.get('audio') !== '0' && !ROLE_YAW[q.get('role') ?? ''] ? cabinDrone() : null;
// Street lamps along the road pack, roof lights and lit windows on the buildings, and NASA-derived
// towns on the far ring past the roads (lights.ts).
const lamps = streetlights(roads ?? [], world.project, world.groundAt, scene, city?.roofLights, world.sites, city?.windows);
const treeCount = q.get('trees') === '0' ? 0 : trees(scene, [pinX, pinZ], world.imagery, world.groundAt);
const cityHaze = await haze(scene, world.hazeMap, world.nearSizeM, groundM, world.drop);
// Everything is built: drop the CPU copies of vertex data (the GPU has them; nothing here picks or edits).
scene.clearCachedVertexData();
const glowing = [...world.materials, ...(city?.materials ?? [])];
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
// The wing too: its unlit meshes draw black into the bloom, so the city's glow stops at its edge.
for (const mesh of [...(city?.meshes ?? []), ...(plane?.meshes ?? [])]) glow?.addIncludedOnlyMesh(mesh);

const hud = q.get('hud') === '0' ? null : clockControls();
if (hud) lightsPanel(), placePicker();
/** ?debug: set `aim.at` to a world point (or `aim.moon = true`) to hold the camera on it for a screenshot. */
const aim: { at: Vector3 | null; moon: boolean } = { at: null, moon: false };
if (q.has('debug')) Object.assign(globalThis, { scene, camera, world, treeCount, day, aim, plane }); // for the console and frame-cost ablations
let hudAt = 0;
const toSun = new Vector3();
const [aircraft, seat] = [new Quaternion(), new Quaternion()];
camera.rotationQuaternion = new Quaternion();
const cabin = cabinOverlay(blinds, day.rain, placeId, lon);
document.querySelector<HTMLElement>('#frame')!.hidden = q.get('frame') === '0';
adminQr(wallOrigin);
// A new push: every pane lowers the blind and reloads into it on the wall's applyAt second.
let changeover = false;
setInterval(async () => {
	const next = await fetchWall(wallOrigin);
	if (changeover || next.version === wall.version || next === NO_WALL) return;
	changeover = true;
	const wait = next.applyAt * 1000 - Date.now();
	setTimeout(() => cabin.hold(), Math.max(0, wait - 3_000)); // the blind takes 2.4 s to come down
	setTimeout(() => location.reload(), Math.max(0, wait));
}, 5_000);

let frames = 0;
engine.runRenderLoop(() => {
	// tools/pi-bench.ts waits for this: the scene is built and drawing, so it measures running, not booting.
	if (++frames === 60) document.documentElement.dataset.ready = '1';
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
	cityHaze(shedding ? 0 : (mix.haze * day.haze * dark) / exposure); // emissive, so it rides the exposure lift too
	for (const m of glowing) m.emissiveIntensity = (lampGain * dark * (world.materials.includes(m) ? carpet : 1)) / exposure;
	// Faint per lamp: ~200k additive points sum to a white sheet at anything brighter.
	lamps?.update(camera.position, now, Math.min(0.999, LAMP_ALPHA * lampGain * day.lights * dark), mix);
	if (glow) {
		glow.isEnabled = dark > 0.02 && !shedding;
		glow.intensity = mix.glow * dark;
	}

	// The aircraft (heading, bank), then the seat in it: turned to the window, looking a little down.
	const p = track.pose(now / 1000);
	const [x, z] = [pinX + p.x, pinZ + p.z];
	camera.position.set(x, cruiseM + p.climbM - world.drop(x, z), z);
	Quaternion.RotationYawPitchRollToRef(p.heading, 0, -p.bank, aircraft);
	Quaternion.RotationYawPitchRollToRef(p.look + paneYaw, SEAT_PITCH, 0, seat);
	aircraft.multiplyToRef(seat, camera.rotationQuaternion!);
	plane?.update(camera.position, aircraft, Math.sign(Math.sin(p.look)) || 1, now, dark);
	if (aim.moon) aim.at = scene.getMeshByName('moon')!.position;
	if (aim.at) camera.setTarget(aim.at);
	cabin.update(now / 1000, dark);

	deck.update(now, toSun.set(s.x, s.y, s.z), dark);
	sky.update(skyMs, 1 - smoothstep(-14, -4, s.elevationDeg));
	luna.update(skyMs, s, dark);
	drone?.setAltitude(camera.position.y);
	scene.render();

	if (hud && now - hudAt > 250) {
		hudAt = now;
		hud(skyMs, s.elevationDeg);
	}
});
addEventListener('resize', () => engine.resize());

/**
 * Reload after a failure, but not in a loop: at most three error reloads an hour, then one every
 * five minutes. The count lives in sessionStorage, which survives a reload of the same tab.
 */
function recover() {
	if (recover.once) return;
	recover.once = true;
	const now = Date.now();
	let recent: number[] = [];
	try {
		recent = (JSON.parse(sessionStorage.getItem('aero-recoveries') ?? '[]') as number[]).filter((t) => now - t < 3_600_000);
		sessionStorage.setItem('aero-recoveries', JSON.stringify([...recent, now]));
	} catch {}
	setTimeout(() => location.reload(), recent.length >= 3 ? 300_000 : 10_000);
}
recover.once = false;

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
	return features && buildings(features, world.project, world.groundAt, scene, world.imagery);
}

/** A place's GeoJSON pack's features, or null when the place has none. */
async function fetchPack(kind: 'buildings' | 'roads') {
	const res = await fetch(`/${kind}/${placeId}.geojson`);
	return res.ok ? (await res.json()).features : null;
}

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

/** The time-of-day slider: drag to pin the sky to an hour, "Now" to follow the real sun again. */
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
