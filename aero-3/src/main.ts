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
const ORBIT_KM = 28;

const q = new URLSearchParams(location.search);
const [lat, lon, groundM] = PLACES[q.get('place') ?? ''] ?? PLACES.hyderabad!;
const clock = q.has('clock') ? Number(q.get('clock')) : undefined;
const paneYaw = Number(q.get('yaw') ?? 0) * RAD;

const canvas = document.querySelector<HTMLCanvasElement>('#world')!;
const engine = await createEngine(canvas, q.get('gpu') === 'webgpu');
engine.setHardwareScalingLevel(Number(q.get('scale') ?? 1));

const scene = new Scene(engine);
scene.clearColor = new Color4(0, 0, 0, 1);
scene.skipPointerMovePicking = true;

const sunLight = new DirectionalLight('sun', new Vector3(0, -1, 0), scene);
if (Atmosphere.IsSupported(engine)) new Atmosphere('atmosphere', scene, [sunLight]);

const camera = new FreeCamera('window', Vector3.Zero(), scene);
camera.fov = 45 * RAD;
camera.minZ = 0.01;
camera.maxZ = 1000;

// Web Mercator tile under the place; the patch is tile-aligned around it.
const n = 2 ** TERRAIN_Z;
const cx = Math.floor(((lon + 180) / 360) * n);
const cy = Math.floor(((1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2) * n);
const patchKm = (SPAN * 40_075.017 * Math.cos(lat * RAD)) / n;

const [heights, imagery] = await Promise.all([loadHeights(), loadImagery()]);
buildGround(heights, imagery);

const altitudeKm = groundM / 1000 + CRUISE_KM;
const hud = q.get('hud') === '0' ? null : document.querySelector('output');
let hudAt = 0;

engine.runRenderLoop(() => {
	const now = Date.now();
	const s = sunAt(now, lat, lon, clock);
	sunLight.direction.set(-s.x, -s.y, -s.z);

	// Position from the wall clock alone, so three panes agree without talking.
	const theta = ((now / 1000) * SPEED_KM_S) / ORBIT_KM;
	camera.position.set(ORBIT_KM * Math.cos(theta), altitudeKm, ORBIT_KM * Math.sin(theta));
	// Counter-clockwise orbit: the left window faces the centre, the city.
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

/** Draw a `{z}/{y}/{x}` grid onto one canvas, north at the top. */
async function mosaic(layer: string, z: number, background: string) {
	const k = 2 ** (z - TERRAIN_Z);
	const side = SPAN * k;
	const canvas = new OffscreenCanvas(side * TILE, side * TILE);
	const ctx = canvas.getContext('2d', { willReadFrequently: layer === 'terrain' })!;
	ctx.fillStyle = background;
	ctx.fillRect(0, 0, canvas.width, canvas.height);

	const x0 = (cx - RADIUS) * k;
	const y0 = (cy - RADIUS) * k;
	await Promise.all(
		Array.from({ length: side * side }, async (_, i) => {
			const col = i % side;
			const row = Math.floor(i / side);
			const bitmap = await tile(`/tiles/${layer}/${z}/${y0 + row}/${x0 + col}.${layer === 'terrain' ? 'png' : 'jpg'}`);
			if (bitmap) ctx.drawImage(bitmap, col * TILE, row * TILE);
			bitmap?.close();
		})
	);
	return canvas;
}

async function loadHeights() {
	// #800000 is terrarium's 0 m, so a missing tile reads as sea level, not -32 km.
	const canvas = await mosaic('terrain', TERRAIN_Z, '#800000');
	const { data, width } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
	/** Height in km at (u, v), u east and v south, both 0..1. */
	return (u: number, v: number) => {
		const i = (Math.round(v * (width - 1)) * width + Math.round(u * (width - 1))) * 4;
		return Math.max(0, (data[i]! * 256 + data[i + 1]! + data[i + 2]! / 256 - 32_768) / 1000);
	};
}

async function loadImagery() {
	const canvas = await mosaic('imagery', IMAGERY_Z, '#3a4048');
	const texture = new DynamicTexture('imagery', { width: canvas.width, height: canvas.height }, scene, true);
	texture.getContext().drawImage(canvas, 0, 0);
	texture.update();
	return texture;
}

function buildGround(heightAt: (u: number, v: number) => number, imagery: DynamicTexture) {
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
}
