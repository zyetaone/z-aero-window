/**
 * The window: the place's ground to the horizon, its buildings, a cloud deck,
 * Babylon's physically based sky and the real stars, seen from a camera
 * circling the place's pin.
 *
 * Units are metres, y up, x east, z north (see world.ts). Everything that moves
 * moves on the wall clock, so three panes agree without talking.
 *
 * Params (all optional, so `frame-cost.mjs` can pin a scene):
 *   ?place=hyderabad  ?clock=6 (local solar hour)  ?yaw=0 (pane offset, deg)
 *   ?scale=1 (hardware scaling)  ?gpu=webgpu  ?hud=0  ?clouds=1 (cover, 0 = clear)
 *   ?lamps=1 (lamp gain)  ?lift=8 (twilight exposure)  ?glow=0 (no bloom)  ?carpet=1 (VIIRS texture)
 */
import { Color4, DirectionalLight, Engine, FreeCamera, GlowLayer, Scene, Vector3, WebGPUEngine, type AbstractEngine } from '@babylonjs/core';
import { Atmosphere } from '@babylonjs/addons/atmosphere';
import { buildings } from './buildings.ts';
import { clouds } from './clouds.ts';
import { streetlights } from './lights.ts';
import { stars } from './stars.ts';
import { atSolarHour, solarHour, sunAt } from './sun.ts';
import { createWorld, smoothstep } from './world.ts';

// id → [lat, lon, ground m]. Same coordinates as aero-2's catalog.
const PLACES: Record<string, [number, number, number]> = {
	hyderabad: [17.4435, 78.3772, 500],
	mumbai: [19.076, 72.8777, 10],
	dubai: [25.2048, 55.2708, 5],
	dallas: [32.7767, -96.797, 150],
	phoenix: [33.4352, -112.0101, 340],
	las_vegas: [36.1699, -115.1398, 620],
	denver: [39.8561, -104.6737, 1600],
	chicago_midway: [41.7868, -87.7522, 190],
	himalayas: [27.9881, 86.925, 5000]
};

const RAD = Math.PI / 180;
const CRUISE_M = 3500; // above ground
const DECK_M = 1800; // cloud base above ground: the window looks down onto it
const SPEED_M_S = 230; // ~450 kt
const ORBIT_M = 9000;
const LAMP_ALPHA = 0.22;
const GLOW = 0.35;

const q = new URLSearchParams(location.search);
const placeId = q.get('place') && q.get('place')! in PLACES ? q.get('place')! : 'hyderabad';
const [lat, lon, groundM] = PLACES[placeId]!;
const paneYaw = Number(q.get('yaw') ?? 0) * RAD;
const lampGain = Number(q.get('lamps') ?? 1);
const twilightLift = Number(q.get('lift') ?? 8);
// The baked VIIRS texture under the lamp points: a faint glow only, or it reads as blocky amber blobs.
const carpet = Number(q.get('carpet') ?? 1);
let pinnedHour = q.has('clock') ? Number(q.get('clock')) : null;

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const engine = await createEngine(canvas, q.get('gpu') === 'webgpu');
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
const [pinX, pinZ] = world.project(lon, lat);
const [city, roads, deck, sky] = await Promise.all([
	loadCity(),
	fetchPack('roads'),
	clouds(scene, camera, sunLight, [pinX, pinZ], groundM + DECK_M, world.drop, Number(q.get('clouds') ?? 1)),
	stars(scene, camera, lat, lon)
]);
// Street lamps along the road pack, one light per building, beacons on the towers (lights.ts).
const lamps = roads && streetlights(roads, world.project, world.groundAt, scene, city?.tops);
const glowing = [...world.materials, ...(city ? [city.material] : [])];

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
if (q.has('debug')) Object.assign(globalThis, { scene, camera, world }); // for the console and frame-cost ablations
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
	for (const m of glowing) m.emissiveIntensity = (lampGain * dark * (m !== city?.material ? carpet : 1)) / exposure;
	// Faint per lamp: 120k additive points sum to a white sheet at anything brighter.
	lamps?.update(camera.position, now, Math.min(0.999, LAMP_ALPHA * lampGain * dark));
	if (glow) {
		glow.isEnabled = dark > 0.02;
		glow.intensity = GLOW * dark;
	}

	// Counter-clockwise orbit around the pin: the left window faces the city.
	const theta = ((now / 1000) * SPEED_M_S) / ORBIT_M;
	const [x, z] = [pinX + ORBIT_M * Math.cos(theta), pinZ + ORBIT_M * Math.sin(theta)];
	camera.position.set(x, groundM + CRUISE_M - world.drop(x, z), z);
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
