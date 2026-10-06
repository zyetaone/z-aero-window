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
// Side-effect only: module-path imports skip the barrel, and scene picking needs Ray registered.
import '@babylonjs/core/Culling/ray';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { Engine } from '@babylonjs/core/Engines/engine';
import { GlowLayer } from '@babylonjs/core/Layers/glowLayer';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color4 } from '@babylonjs/core/Maths/math.color';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';
import { Atmosphere } from '@babylonjs/addons/atmosphere';
import { createHud } from './cabin/hud.ts';
import { adminQr, cabinDrone, cabinOverlay, loneGestures } from './cabin/cabin.ts';
import { playAudioPlaylist, showVideo } from './cabin/media.ts';
import { RAD } from './math.ts';
import { keepAlive } from './ops/kiosk.ts';
import { fetchWall, NO_WALL } from './ops/wall.ts';
import { readParams } from './flight/params.ts';
import { SEAT_PITCH } from './flight/path.ts';
import { slotAt } from './flight/places.ts';
import { planFlight } from './flight/plan.ts';
import { lightingAt, moonlightAt, type Knobs } from './world/lighting.ts';
import { BUILDING_CAP, createBuildings } from './world/city/buildings.ts';
import { createHaze } from './world/city/haze.ts';
import { createLights } from './world/city/lights.ts';
import { createTerrain } from './world/ground/terrain.ts';
import { createTrees } from './world/ground/trees.ts';
import { createClouds } from './world/sky/clouds/clouds.ts';
import { atSolarHour, moonAt, sunAt } from './world/sky/ephemeris.ts';
import { createMoon } from './world/sky/moon.ts';
import { createStars } from './world/sky/stars.ts';
import { createWing } from './world/wing.ts';

const CLEAR_M = 2_000; // over the highest terrain within 4 km of the track
const GLOW = 0.35;

const P = readParams(location.search);
// The operator's wall (ops/wall.ts), from ?wall=<center Pi's origin> or this pane's own server. Read
// before anything is chosen; unreachable within 2 s means no wall. URL params still win.
const wall = await fetchWall(P.wall);
// A push not yet due: wait for its second (the blind is closed in the markup), so a pane that boots
// in the 10 s lead does not show the new scene before the others change over.
if (wall.applyAt * 1000 > Date.now()) await new Promise((r) => setTimeout(r, wall.applyAt * 1000 - Date.now()));
// Every visit slot (10 min) is a fresh flight: a new city when following the rotation, a new
// direction and today's weather either way (flight/plan.ts). The blind closes over the boundary and
// the page reloads behind it, which also frees every buffer of the last visit. ?blind=0 holds one.
const plan = planFlight(P, wall, Date.now());
const { slot: bootSlot, placeId, pinnedPlace, lat, lon, groundM, track, weather, paneYaw } = plan;
if (P.blind) setInterval(() => slotAt(Date.now() / 1000) !== bootSlot && location.reload(), 1000);
// The atmosphere's day exposure (?sky=, 1.7): at 1 a clear afternoon rendered dark slate. See lighting.ts.
const knobs: Knobs = { sky: P.sky, lift: P.lift, lamps: P.lamps, carpet: P.carpet, moonlight: P.moonlight };
const clock = { pinned: plan.clock }; // the HUD's slider writes it
// The Lights panel's live gains (lightsPanel): street lamps, building lights, far towns, bloom.
// A wall push overrides these defaults (wall.ts gains: replace, never multiply); a lone pane's
// HUD sliders still edit the result locally. `?.` because a wall stored before gains keeps working.
const mix = {
	street: wall.gains?.street ?? 1,
	building: wall.gains?.building ?? 1,
	far: wall.gains?.far ?? 1,
	glow: wall.gains?.glow ?? GLOW,
	haze: wall.gains?.haze ?? 0.12
};

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const engine = await createEngine(canvas, P.webgpu, P.aa);
const baseScale = P.scale;
engine.setHardwareScalingLevel(baseScale);
// A kiosk has no one to press reload (ops/kiosk.ts): failed boots and lost contexts reload, a hot Pi sheds.
let frames = 0;
const kiosk = keepAlive(engine, baseScale, () => frames);

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
sunLight.intensity = weather.sun;
if (atmosphere) {
	atmosphere.aerialPerspectiveIntensity *= weather.haze;
	// Today's air: few aerosols is a deep blue sky down to the horizon, many a milky one.
	atmosphere.physicalProperties.mieScatteringScale *= weather.mie;
}
// Today's punch: a clear day's shadows and colours snap, a hazy one's lie flat. ?contrast= pins it.
scene.imageProcessingConfiguration.contrast = Number.isNaN(P.contrast) ? weather.contrast : P.contrast;
const [pinX, pinZ] = terrain.project(lon, lat);
// Each visit's own cruise (flight/path.ts: a band and a climb), but never into the ground: the track clears
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
	createClouds(scene, camera, sunLight, [pinX, pinZ], groundM + weather.deckM, terrain.groundAt, terrain.drop, weather, P.clouds),
	createStars(scene, camera, lat, lon)
]);
// The ground and the city, not the wing: the ground's atmosphere-plugin materials take a light ~30x
// weaker than plain PBR (measured), so a strength that shows the desert would blow the wing out (it
// has its own night fill, wing.ts). The white buildings take it at full strength: moonlit concrete.
moonLight?.includedOnlyMeshes.push(...[scene.getMeshByName('near'), scene.getMeshByName('far'), ...(buildings?.meshes ?? [])].filter((m) => m !== null));
const moon = createMoon(scene, camera, lat, lon);
const wing = !P.wing ? null : await createWing(scene, plan.seat);
// One pane makes the sound: the centre (or a lone pane). ?audio=0 for silence.
const tracks = wall.media?.audio ?? []; // `?.`: a wall stored before media keeps playing
const clip = wall.media?.video ?? null;
// A pushed playlist replaces the synthesised drone (same gate: centre/solo, ?audio=0 off).
const drone = P.audio && (P.role ?? 'center') === 'center' && !tracks.length ? cabinDrone() : null;
if ((P.role ?? 'center') === 'center' && P.audio && tracks.length) playAudioPlaylist(tracks, P.wall);
if (clip) showVideo(clip, P.wall); // muted everywhere: a video wall is one image, not three soundtracks
// Street lamps along the road pack, roof lights and lit windows on the buildings, and NASA-derived
// towns on the far ring past the roads (city/lights.ts).
const lights = createLights(roads ?? [], terrain.project, terrain.groundAt, scene, buildings?.roofLights, terrain.sites, buildings?.windows, P.caps ? [pinX, pinZ] : null);
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

const hud = P.hud ? createHud(engine, lon, clock, mix, pinnedPlace) : null;
/** ?debug: set `aim.at` to a world point (or `aim.moon = true`) to hold the camera on it for a screenshot. */
const aim: { at: Vector3 | null; moon: boolean } = { at: null, moon: false };
if (P.debug) Object.assign(globalThis, { scene, camera, terrain, treeCount, weather, aim, wing, atmosphere }); // for the console and frame-cost ablations
let hudAt = 0;
const toSun = new Vector3();
// The moon for the clouds (twice a second: it crawls): direction to it, and its dark-gated gain.
const toMoon = new Vector3();
let moonGain = 0;
const [aircraft, seat] = [new Quaternion(), new Quaternion()];
camera.rotationQuaternion = new Quaternion();
const cabin = cabinOverlay(P.blind, weather.rain, placeId, lon, P.role ? ['left', 'center', 'right'].indexOf(P.role) + 1 : 0, wall.applyAt);
document.querySelector<HTMLElement>('#frame')!.hidden = !P.frame;
adminQr(P.wall);
// Lone pane only (no ?role=): blind-drag departures and the tap clock stay local,
// so they can never split a wall. Wall panes get the QR hold and nothing else.
if (!P.role) loneGestures(placeId);
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

engine.runRenderLoop(() => {
	// tools/pi-bench.ts waits for this: the scene is built and drawing, so it measures running, not booting.
	if (++frames === 60) document.documentElement.dataset.ready = '1';
	const now = Date.now();
	const skyMs = clock.pinned === null ? now : atSolarHour(now, lon, clock.pinned);
	const s = sunAt(skyMs, lat, lon);
	sunLight.direction.set(-s.x, -s.y, -s.z);

	const light = lightingAt(s.elevationDeg, knobs, mix, weather.haze, weather.lights, kiosk.shedding);
	const dark = light.dark;
	if (moonLight && frames % 30 === 1) {
		const m = moonlightAt(moonAt(skyMs, lat, lon), dark, knobs.moonlight); // twice a second: the moon crawls
		moonLight.direction.set(...m.direction);
		moonLight.intensity = m.intensity;
		toMoon.set(-m.direction[0], -m.direction[1], -m.direction[2]); // to the moon: the light points down
		moonGain = m.intensity;
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
	cabin.update(now / 1000, dark, skyMs);

	clouds.update(now, toSun.set(s.x, s.y, s.z), dark, toMoon, moonGain, dark * weather.lights);
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

/**
 * MSAA on (?aa=0 off, for the bench): without it every building edge and lit-window texel is
 * sampled once per pixel and flickers as the plane moves, which read as noise on the city. Mali
 * is tile-based and resolves MSAA on chip, so it is the cheap kind of anti-aliasing there.
 */
async function createEngine(target: HTMLCanvasElement, wantWebGPU: boolean, antialias: boolean): Promise<AbstractEngine> {
	// Loaded only when asked for (?gpu=webgpu): the Pi runs WebGL2, and this engine is a large chunk.
	const { WebGPUEngine } = wantWebGPU ? await import('@babylonjs/core/Engines/webgpuEngine') : { WebGPUEngine: null };
	if (WebGPUEngine && (await WebGPUEngine.IsSupportedAsync)) {
		const gpu = new WebGPUEngine(target, { antialias });
		await gpu.initAsync();
		return gpu;
	}
	return new Engine(target, antialias, { stencil: false, powerPreference: 'high-performance' });
}

/** The place's OSM footprints, if it has a pack (see city/buildings.ts). Capped around the pin only with ?caps=1 (flight/params.ts: off by default). */
async function loadBuildings() {
	const features = await fetchPack('buildings');
	return features && createBuildings(features, terrain.project, terrain.groundAt, scene, P.caps ? { ...BUILDING_CAP, center: { lon, lat } } : null);
}

/** A place's GeoJSON pack's features, or null when the place has none. */
async function fetchPack(kind: 'buildings' | 'roads') {
	const res = await fetch(`/${kind}/${placeId}.geojson`);
	return res.ok ? (await res.json()).features : null;
}
