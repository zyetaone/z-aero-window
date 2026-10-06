/**
 * The window: the place's ground to the horizon, its buildings, a cloud deck,
 * Babylon's physically based sky and the real stars, seen from a camera
 * circling the place's pin.
 *
 * Units are metres, y up, x east, z north (see ground/terrain.ts). Everything that moves
 * moves on the wall clock, so three panes agree without talking.
 *
 * URL knobs: params.ts, the one list. The light of each frame: lighting.ts.
 */
import { Color4, DirectionalLight, Engine, FreeCamera, GlowLayer, PBRMaterial, Quaternion, Scene, Vector3, WebGPUEngine, type AbstractEngine } from '@babylonjs/core';
import { Atmosphere } from '@babylonjs/addons/atmosphere';
import { createBuildings } from './city/buildings.ts';
import { createClouds } from './sky/clouds.ts';
import { dayFor } from './day.ts';
import { flight, SEAT_PITCH } from './flight.ts';
import { createLights } from './city/lights.ts';
import { createTrees } from './ground/trees.ts';
import { destinationAt, DWELL_SEC, PLACES, placeName, slotAt } from './places.ts';
import { createHaze } from './city/haze.ts';
import { adminQr, cabinDrone, cabinOverlay } from './cabin.ts';
import { createMoon } from './sky/moon.ts';
import { createWing, SEATS, seatFor, type Seat } from './wing.ts';
import { createStars } from './sky/stars.ts';
import { atSolarHour, hhmm, moonAt, solarHour, sunAt } from './sky/ephemeris.ts';
import { createTerrain } from './ground/terrain.ts';
import { fetchWall, NO_WALL } from './ops/wall.ts';
import { hash, RAD } from './math.ts';
import { lightingAt, moonlightAt, type Knobs } from './lighting.ts';
import { readParams } from './params.ts';

const CLEAR_M = 2_000; // over the highest terrain within 4 km of the track
const ORBIT_M = 9000;
const GLOW = 0.35;

const P = readParams(location.search);
// The operator's wall (ops/wall.ts), from ?wall=<center Pi's origin> or this pane's own server. Read
// before anything is chosen; unreachable within 2 s means no wall. URL params still win.
const wall = await fetchWall(P.wall);
// A push not yet due: wait for its second (the blind is closed in the markup), so a pane that boots
// in the 10 s lead does not show the new scene before the others change over.
if (wall.applyAt * 1000 > Date.now()) await new Promise((r) => setTimeout(r, wall.applyAt * 1000 - Date.now()));
// ?place= (or the wall) pins a city; otherwise the wall-clock rotation picks it, the same on every pane.
const asked = P.place ?? wall.place;
const pinnedPlace = asked && Object.hasOwn(PLACES, asked) ? asked : null;
// Every visit slot (10 min) is a fresh flight: a new city when following the rotation, a new
// direction and today's weather either way. The blind closes over the boundary and the page reloads
// behind it, which also frees every buffer of the last visit. ?blind=0 holds one visit (screenshots).
const bootSlot = slotAt(Date.now() / 1000);
const placeId = pinnedPlace ?? destinationAt(Date.now() / 1000);
if (P.blind) setInterval(() => slotAt(Date.now() / 1000) !== bootSlot && location.reload(), 1000);
const [lat, lon, groundM, orbitM = ORBIT_M] = PLACES[placeId]!;
const track = flight(Math.floor(hash(bootSlot * 0x2545f491 + groundM) * 2 ** 31), orbitM);
// The pane's place in the wall: the outer two look 24° off the centre (aero-2's parallax), ?yaw= exact.
const ROLE_YAW: Record<string, number> = { left: -24, right: 24 };
const paneYaw = (P.yaw ?? (P.role ? ROLE_YAW[P.role] ?? 0 : 0)) * RAD;
// The atmosphere's day exposure (?sky=, 1.7): at 1 a clear afternoon rendered dark slate. See lighting.ts.
const knobs: Knobs = { sky: P.sky, lift: P.lift, lamps: P.lamps, carpet: P.carpet, moonlight: P.moonlight };
let pinnedHour: number | null = P.clock;
if (Number.isNaN(pinnedHour)) pinnedHour = wall.clock;
// The Lights panel's live gains (lightsPanel): street lamps, building lights, far towns, bloom.
const mix = { street: 1, building: 1, far: 1, glow: GLOW, haze: 0.12 };

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const engine = await createEngine(canvas, P.webgpu, P.aa);
// A kiosk has no one to press reload. A failed boot (tiles not served yet, a truncated pack)
// retries, and a lost GL context reloads: clearCachedVertexData below leaves nothing to rebuild from.
addEventListener('unhandledrejection', recover, { once: true });
engine.onContextLostObservable.add(recover);
const baseScale = P.scale;
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
// Moonlight: its own light, because the atmosphere builds the sky from sunLight. Always on (0 by day),
// so no shader recompiles at dusk; cool, and as bright as the phase and the moon's height allow.
// The night map then reads faintly under it instead of black. ?moon=0 drops it (bench ablation).
const moonLight = !P.moon ? null : new DirectionalLight('moon', new Vector3(0, -1, 0), scene);
moonLight?.diffuse.set(0.62, 0.72, 1);
moonLight?.specular.set(0.2, 0.24, 0.3);

const camera = new FreeCamera('window', Vector3.Zero(), scene);
camera.fov = 45 * RAD;
camera.minZ = 10;
camera.maxZ = 1_000_000;

const roadsLoad = fetchPack('roads'); // the ground paints them in by day, the lamps follow them by night
const terrain = await createTerrain(scene, lat, lon, await roadsLoad);
// Today for this place, from the visit's slot start: the same on every pane, different tomorrow.
const day = dayFor(placeId, bootSlot * DWELL_SEC * 1000, P.weather ?? wall.weather);
sunLight.intensity = day.sun;
if (atmosphere) {
	atmosphere.aerialPerspectiveIntensity *= day.haze;
	// Today's air: few aerosols is a deep blue sky down to the horizon, many a milky one.
	atmosphere.physicalProperties.mieScatteringScale *= day.mie;
}
// Today's punch: a clear day's shadows and colours snap, a hazy one's lie flat. ?contrast= pins it.
scene.imageProcessingConfiguration.contrast = Number.isNaN(P.contrast) ? day.contrast : P.contrast;
const [pinX, pinZ] = terrain.project(lon, lat);
// Each visit's own cruise (flight.ts: a band and a climb), but never into the ground: the track clears
// the highest terrain within 4 km of it (one circuit, sampled once) by CLEAR_M, a floor in the loop.
let peakM = -Infinity;
for (let i = 0; i < 720; i++) {
	const [tx, tz] = track.at((i / 720) * track.periodSec);
	for (const [dx, dz] of [[0, 0], [4e3, 0], [-4e3, 0], [0, 4e3], [0, -4e3]]) {
		const [x, z] = [pinX + tx + dx!, pinZ + tz + dz!];
		peakM = Math.max(peakM, terrain.groundAt(x, z) + terrain.drop(x, z));
	}
}
const floorM = peakM + CLEAR_M;
const [buildings, roads, clouds, stars] = await Promise.all([
	loadBuildings(),
	roadsLoad,
	createClouds(scene, camera, sunLight, [pinX, pinZ], groundM + day.deckM, terrain.groundAt, terrain.drop, day, P.clouds),
	createStars(scene, camera, lat, lon)
]);
// The ground and the city, not the wing: the ground's atmosphere-plugin materials take a light ~30x
// weaker than plain PBR (measured), so a strength that shows the desert would blow the wing out (it
// has its own night fill, wing.ts). The white buildings take it at full strength: moonlit concrete.
moonLight?.includedOnlyMeshes.push(...[scene.getMeshByName('near'), scene.getMeshByName('far'), ...(buildings?.meshes ?? [])].filter((m) => m !== null));
const moon = createMoon(scene, camera, lat, lon);
const wing = !P.wing ? null : await createWing(scene, P.seat && Object.hasOwn(SEATS, P.seat) ? (P.seat as Seat) : seatFor(hash(bootSlot * 0x9e3779b1 + 7)));
// One pane makes the sound: the centre (or a lone pane). ?audio=0 for silence.
const drone = P.audio && (P.role ?? 'center') === 'center' ? cabinDrone() : null;
// Street lamps along the road pack, roof lights and lit windows on the buildings, and NASA-derived
// towns on the far ring past the roads (city/lights.ts).
const lights = createLights(roads ?? [], terrain.project, terrain.groundAt, scene, buildings?.roofLights, terrain.sites, buildings?.windows);
const treeCount = !P.trees ? 0 : createTrees(scene, [pinX, pinZ], terrain.imagery, terrain.groundAt);
const haze = await createHaze(scene, terrain.hazeMap, terrain.nearSizeM, groundM, terrain.drop);
// Everything is built: drop the CPU copies of vertex data (the GPU has them; nothing here picks or edits).
scene.clearCachedVertexData();
const glowing = [...terrain.materials, ...(buildings?.materials ?? [])];
// Everything that takes the sky's ambient light by day (ambientColor white); faded out after dusk,
// where the twilight exposure lift would otherwise turn the night sky's faint light into grey.
const skyLit = [...glowing, scene.getMaterialByName('trees')].filter((m) => m instanceof PBRMaterial);

// Babylon's bloom on everything emissive: lamps halo, windows and the city carpet glow.
// Night only — by day it is switched off and costs nothing.
const glow = !P.glow ? null : new GlowLayer('glow', scene, { mainTextureRatio: 0.25, blurKernelSize: 16 });
// Lamps only: the glow pass re-renders whatever it includes, and re-rendering the ground's
// atmosphere-plugin PBR materials blew the dusk sky to white.
if (glow && lights) {
	glow.addIncludedOnlyMesh(lights.mesh);
	glow.referenceMeshToUseItsOwnMaterial(lights.mesh);
}
// Lit windows halo too: the glow pass draws the city through its own emissive shader.
// The wing too: its unlit meshes draw black into the bloom, so the city's glow stops at its edge.
for (const mesh of [...(buildings?.meshes ?? []), ...(wing?.meshes ?? [])]) glow?.addIncludedOnlyMesh(mesh);

// Off on a wall pane (the kiosk URL carries ?role=): a touch on one pane's slider would split the wall.
const hud = P.hud ? clockControls() : null;
if (hud) lightsPanel(), placePicker();
/** ?debug: set `aim.at` to a world point (or `aim.moon = true`) to hold the camera on it for a screenshot. */
const aim: { at: Vector3 | null; moon: boolean } = { at: null, moon: false };
if (P.debug) Object.assign(globalThis, { scene, camera, terrain, treeCount, day, aim, wing, atmosphere }); // for the console and frame-cost ablations
let hudAt = 0;
const toSun = new Vector3();
const [aircraft, seat] = [new Quaternion(), new Quaternion()];
camera.rotationQuaternion = new Quaternion();
const cabin = cabinOverlay(P.blind, day.rain, placeId, lon, P.role ? ['left', 'center', 'right'].indexOf(P.role) + 1 : 0, wall.applyAt);
document.querySelector<HTMLElement>('#frame')!.hidden = !P.frame;
adminQr(P.wall);
// A new push: every pane lowers the blind and reloads into it on the wall's applyAt second.
let changeover = false;
setInterval(async () => {
	const next = await fetchWall(P.wall);
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

	const light = lightingAt(s.elevationDeg, knobs, mix, day.haze, day.lights, shedding);
	const dark = light.dark;
	if (moonLight && frames % 30 === 1) {
		const m = moonlightAt(moonAt(skyMs, lat, lon), dark, knobs.moonlight); // twice a second: the moon crawls
		moonLight.direction.set(...m.direction);
		moonLight.intensity = m.intensity;
	}
	if (atmosphere) atmosphere.exposure = light.exposure;
	for (const m of skyLit) m.ambientColor.setAll(light.ambient);
	haze(light.haze);
	for (const m of glowing) m.emissiveIntensity = terrain.materials.includes(m) ? light.carpet : light.emissive;
	lights?.update(camera.position, now, light.lampAlpha, mix);
	if (glow) {
		glow.isEnabled = light.glowOn;
		glow.intensity = light.glow;
	}

	// The aircraft (heading, bank), then the seat in it: turned to the window, looking a little down.
	const p = track.pose(now / 1000);
	const [x, z] = [pinX + p.x, pinZ + p.z];
	camera.position.set(x, Math.max(groundM + (Number.isNaN(P.alt) ? track.cruiseM + p.climbM : P.alt), floorM) - terrain.drop(x, z), z);
	Quaternion.RotationYawPitchRollToRef(p.heading, 0, -p.bank, aircraft);
	Quaternion.RotationYawPitchRollToRef(p.look + paneYaw, SEAT_PITCH, 0, seat);
	aircraft.multiplyToRef(seat, camera.rotationQuaternion!);
	wing?.update(camera.position, aircraft, Math.sign(Math.sin(p.look)) || 1, now, dark);
	if (aim.moon) aim.at = scene.getMeshByName('moon')!.position;
	if (aim.at) camera.setTarget(aim.at);
	cabin.update(now / 1000, dark);

	clouds.update(now, toSun.set(s.x, s.y, s.z), dark);
	stars.update(skyMs, light.stars);
	moon.update(skyMs, s, dark);
	drone?.setAltitude(camera.position.y);
	scene.render();

	if (hud && now - hudAt > 250) {
		hudAt = now;
		hud(skyMs, s.elevationDeg);
	}
});
addEventListener('resize', () => engine.resize());

// Every 30 s: this pane's frame rate to its own server (/api/status, so health-check.sh reports
// it), and a stall check. A visible page that drew no frame in 30 s is wedged (a GPU hang, a lost
// context that never fired its event): reload through recover()'s budget. Hidden tabs throttle rAF.
let framesAt = 0;
setInterval(() => {
	if (!document.hidden && frames === framesAt) recover();
	framesAt = frames;
	fetch('/api/fps', { method: 'POST', body: String(engine.getFps()) }).catch(() => {});
}, 30_000);

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

/**
 * MSAA on (?aa=0 off, for the bench): without it every building edge and lit-window texel is
 * sampled once per pixel and flickers as the plane moves, which read as noise on the city. Mali
 * is tile-based and resolves MSAA on chip, so it is the cheap kind of anti-aliasing there.
 */
async function createEngine(target: HTMLCanvasElement, wantWebGPU: boolean, antialias: boolean): Promise<AbstractEngine> {
	if (wantWebGPU && (await WebGPUEngine.IsSupportedAsync)) {
		const gpu = new WebGPUEngine(target, { antialias });
		await gpu.initAsync();
		return gpu;
	}
	return new Engine(target, antialias, { stencil: false, powerPreference: 'high-performance' });
}

/** The place's OSM footprints, if it has a pack (see city/buildings.ts). */
async function loadBuildings() {
	const features = await fetchPack('buildings');
	return features && createBuildings(features, terrain.project, terrain.groundAt, scene);
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
	for (const id of Object.keys(PLACES)) select.add(new Option(placeName(id), id));
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
		readout.textContent = `${hhmm(hour)} solar · sun ${elevationDeg.toFixed(0)}° · ${Number.isFinite(engine.getFps()) ? engine.getFps().toFixed(0) : '–'} fps ${engine.isWebGPU ? 'WebGPU' : 'WebGL2'}`;
		live.disabled = pinnedHour === null;
	};
}
