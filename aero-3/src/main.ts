/**
 * The window: one city's baked patch of ground, Babylon's physically based
 * atmosphere, and a camera flying a circle around the city.
 *
 * Units are kilometres, y up, x east, z north, origin at sea level over the
 * patch centre — the atmosphere add-on works in km, and a ~190 km patch keeps
 * every coordinate small enough for float32 without a floating origin.
 *
 * Params (all optional, so `frame-cost.mjs` can pin a scene):
 *   ?place=hyderabad  ?clock=6 (local solar hour)  ?yaw=0 (pane offset, deg)
 *   ?scale=1 (hardware scaling)  ?gpu=webgpu  ?hud=0
 */
import {
	Color3,
	Color4,
	DirectionalLight,
	DynamicTexture,
	Engine,
	FreeCamera,
	MeshBuilder,
	PBRMaterial,
	Scene,
	Vector3,
	VertexBuffer,
	VertexData,
	WebGPUEngine,
	type AbstractEngine
} from '@babylonjs/core';
import { Atmosphere } from '@babylonjs/addons/atmosphere';
import { buildings } from './buildings.ts';
import { sunAt } from './sun.ts';

// id → [lat, lon, ground m]. Same coordinates as aero-2's catalog; only cities
// with packed tiles render ground, the rest get sea level and a flat grey.
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
const TILE = 256;
const TERRAIN_Z = 10; // ~37 km tiles: plenty of relief for a 3.5 km cruise
const IMAGERY_Z = 11; // 2×2 imagery tiles per terrain tile → 2560 px texture
const RADIUS = 2; // tiles each side of the centre tile: a 5×5 patch
const SPAN = RADIUS * 2 + 1;
const CRUISE_KM = 3.5; // above ground
const SPEED_KM_S = 0.23; // ~450 kt
const ORBIT_KM = 9;

const smoothstep = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

const q = new URLSearchParams(location.search);
const placeId = q.get('place') && q.get('place')! in PLACES ? q.get('place')! : 'hyderabad';
const [lat, lon, groundM] = PLACES[placeId]!;
const clock = q.has('clock') ? Number(q.get('clock')) : undefined;
const paneYaw = Number(q.get('yaw') ?? 0) * RAD;
const lampGain = Number(q.get('lamps') ?? 1);
const twilightLift = Number(q.get('lift') ?? 8);

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
camera.minZ = 0.01;
camera.maxZ = 1000;

// Web Mercator tile under the place; the patch is tile-aligned around it.
const n = 2 ** TERRAIN_Z;
const cx = Math.floor(((lon + 180) / 360) * n);
const cy = Math.floor(((1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2) * n);
const patchKm = (SPAN * 40_075.017 * Math.cos(lat * RAD)) / n;

const [heights, imagery, lights] = await Promise.all([
	loadHeights(),
	mosaic('imagery', 'jpg', IMAGERY_Z, [IMAGERY_Z], '#3a4048').then((c) => texture('imagery', c)),
	// Raw VIIRS radiance at z8 under the whole patch, aero-2's baked lamp dots at z11 over the core.
	mosaic('lights', 'png', IMAGERY_Z, [8, IMAGERY_Z], '#000').then((c) => texture('lights', kneeLights(c)))
]);
const groundMaterial = buildGround(heights, imagery, lights);
const cityMaterial = await loadCity();

const altitudeKm = groundM / 1000 + CRUISE_KM;
const [pinX, pinZ] = project(lon, lat);
const hud = q.get('hud') === '0' ? null : document.querySelector('output');
let hudAt = 0;

engine.runRenderLoop(() => {
	const now = Date.now();
	const s = sunAt(now, lat, lon, clock);
	sunLight.direction.set(-s.x, -s.y, -s.z);
	// Lamps come on through civil twilight, as aero-2's nightAmount does.
	const dark = 1 - smoothstep(-8, 2, s.elevationDeg);
	groundMaterial.emissiveIntensity = lampGain * dark;
	if (cityMaterial) cityMaterial.emissiveIntensity = lampGain * dark;
	// The eye adapts: lift the sky through twilight so the afterglow reads instead of going black.
	if (atmosphere) atmosphere.exposure = 1 + twilightLift * dark;

	// Position from the wall clock alone, so three panes agree without talking.
	const theta = ((now / 1000) * SPEED_KM_S) / ORBIT_KM;
	camera.position.set(pinX + ORBIT_KM * Math.cos(theta), altitudeKm, pinZ + ORBIT_KM * Math.sin(theta));
	// Counter-clockwise orbit around the place's pin: the left window faces the city.
	camera.rotation.set(12 * RAD, Math.atan2(-Math.cos(theta), -Math.sin(theta)) + paneYaw, 0);

	scene.render();

	if (hud && now - hudAt > 500) {
		hudAt = now;
		hud.textContent = `${engine.getFps().toFixed(1)} fps · ${engine.isWebGPU ? 'WebGPU' : 'WebGL2'} · sun ${s.elevationDeg.toFixed(0)}°`;
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

/** Missing tiles (unpacked ocean, edge of the pack) come back null and stay background. */
async function tile(url: string): Promise<ImageBitmap | null> {
	const res = await fetch(url);
	return res.ok ? createImageBitmap(await res.blob()) : null;
}

/**
 * Stack `{z}/{y}/{x}` tiles onto one canvas at `outZ` resolution, north at the
 * top. Zooms draw coarse to fine, so a fine layer that only covers the city
 * core (the baked lamps) sits on a coarse one that covers the whole patch.
 */
async function mosaic(layer: string, ext: string, outZ: number, zooms: number[], background: string) {
	const side = SPAN * 2 ** (outZ - TERRAIN_Z) * TILE;
	const canvas = new OffscreenCanvas(side, side);
	const ctx = canvas.getContext('2d', { willReadFrequently: layer === 'terrain' })!;
	ctx.fillStyle = background;
	ctx.fillRect(0, 0, side, side);

	for (const z of zooms) {
		const f = 2 ** (z - TERRAIN_Z);
		const size = TILE * 2 ** (outZ - z); // one z-tile in output pixels
		const [lo, hi] = [Math.floor((cx - RADIUS) * f), Math.ceil((cx + RADIUS + 1) * f) - 1];
		const [top, bottom] = [Math.floor((cy - RADIUS) * f), Math.ceil((cy + RADIUS + 1) * f) - 1];
		const bitmaps = await Promise.all(
			Array.from({ length: (bottom - top + 1) * (hi - lo + 1) }, async (_, i) => {
				const [x, y] = [lo + (i % (hi - lo + 1)), top + Math.floor(i / (hi - lo + 1))];
				return { x, y, bitmap: await tile(`/tiles/${layer}/${z}/${y}/${x}.${ext}`) };
			})
		);
		for (const { x, y, bitmap } of bitmaps) {
			if (!bitmap) continue;
			ctx.drawImage(bitmap, x * size - (cx - RADIUS) * f * size, y * size - (cy - RADIUS) * f * size, size, size);
			bitmap.close();
		}
	}
	return canvas;
}

async function loadHeights() {
	// #800000 is terrarium's 0 m, so a missing tile reads as sea level, not -32 km.
	const canvas = await mosaic('terrain', 'png', TERRAIN_Z, [TERRAIN_Z], '#800000');
	const { data, width } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
	/** Height in km at (u, v), u east and v south, both 0..1. */
	return (u: number, v: number) => {
		const i = (Math.round(v * (width - 1)) * width + Math.round(u * (width - 1))) * 4;
		return Math.max(0, (data[i]! * 256 + data[i + 1]! + data[i + 2]! / 256 - 32_768) / 1000);
	};
}

/**
 * aero-2's VIIRS tint (server/viirs-tint.ts), cut to its two load-bearing
 * parts and run once at boot: a luminance knee at 0.35..0.75, because raw
 * VIIRS over a city is mid-bright almost everywhere and anything lower pastes
 * a cream sheet over it; and grey radiance dealt amber. Baked lamp pixels
 * already carry their road's colour and keep it.
 */
function kneeLights(canvas: OffscreenCanvas) {
	const ctx = canvas.getContext('2d')!;
	const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const d = image.data;
	for (let i = 0; i < d.length; i += 4) {
		const [r, g, b] = [d[i]!, d[i + 1]!, d[i + 2]!];
		const t = Math.max(r, g, b) / 255;
		const k = smoothstep(0.35, 0.75, t) * (0.25 + 0.6 * t * t);
		const grey = Math.max(r, g, b) - Math.min(r, g, b) < 24;
		d[i] = (grey ? 255 : r) * k;
		d[i + 1] = (grey ? 150 : g) * k;
		d[i + 2] = (grey ? 60 : b) * k;
	}
	ctx.putImageData(image, 0, 0);
	return canvas;
}

function texture(name: string, canvas: OffscreenCanvas) {
	const tex = new DynamicTexture(name, { width: canvas.width, height: canvas.height }, scene, true);
	tex.getContext().drawImage(canvas, 0, 0);
	tex.update();
	return tex;
}

/** Lon/lat to scene km, on the same Mercator grid the ground patch is cut from. */
function project(lonDeg: number, latDeg: number): [x: number, z: number] {
	const tx = ((lonDeg + 180) / 360) * n - (cx - RADIUS);
	const ty = ((1 - Math.asinh(Math.tan(latDeg * RAD)) / Math.PI) / 2) * n - (cy - RADIUS);
	return [(tx / SPAN - 0.5) * patchKm, (0.5 - ty / SPAN) * patchKm];
}

/** The city's OSM footprints, if this place has a pack. Window glow comes up with the lamps. */
async function loadCity() {
	const res = await fetch(`/buildings/${placeId}.geojson`);
	if (!res.ok) return null;
	const { features } = await res.json();
	const mesh = buildings(features, project, (x, z) => heights(x / patchKm + 0.5, 0.5 - z / patchKm), scene);
	const material = new PBRMaterial('buildings', scene);
	material.albedoColor = new Color3(0.62, 0.58, 0.52);
	// Dark silhouettes with a faint window warmth; brighter reads as a flat tan blob over the lamps.
	material.emissiveColor = new Color3(0.07, 0.045, 0.02);
	material.metallic = 0;
	material.roughness = 0.9;
	// ponytail: earcut's roof winding isn't checked against Babylon's; both sides drawn. Cull once verified.
	material.backFaceCulling = false;
	mesh.material = material;
	mesh.freezeWorldMatrix();
	return material;
}

function buildGround(heightAt: (u: number, v: number) => number, imagery: DynamicTexture, lights: DynamicTexture) {
	// ponytail: one 256² grid over the patch (~730 m spacing), no LOD. Add
	// rings of coarser tiles if the flat skirt past ~90 km reads as fake.
	const ground = MeshBuilder.CreateGround(
		'ground',
		{ width: patchKm, height: patchKm, subdivisions: 256, updatable: true },
		scene
	);
	const positions = ground.getVerticesData(VertexBuffer.PositionKind)!;
	for (let i = 0; i < positions.length; i += 3) {
		positions[i + 1] = heightAt(positions[i]! / patchKm + 0.5, 0.5 - positions[i + 2]! / patchKm);
	}
	const normals: number[] = [];
	VertexData.ComputeNormals(positions, ground.getIndices(), normals);
	ground.updateVerticesData(VertexBuffer.PositionKind, positions);
	ground.updateVerticesData(VertexBuffer.NormalKind, normals);

	const material = new PBRMaterial('ground', scene);
	material.albedoTexture = imagery;
	material.emissiveTexture = lights;
	material.emissiveColor = Color3.White();
	material.metallic = 0;
	material.roughness = 1;
	ground.material = material;
	ground.freezeWorldMatrix();

	// The horizon past the patch: one flat plane just under it, which the
	// atmosphere's aerial perspective hazes into the distance.
	const skirt = MeshBuilder.CreateGround('skirt', { width: 2000, height: 2000 }, scene);
	skirt.position.y = groundM / 1000 - 0.05;
	const flat = new PBRMaterial('skirt', scene);
	flat.albedoColor = new Color3(0.22, 0.2, 0.16);
	flat.metallic = 0;
	flat.roughness = 1;
	skirt.material = flat;
	skirt.freezeWorldMatrix();
	return material;
}
