/**
 * OSM footprints extruded into one mesh: one draw call for the whole city.
 *
 * Built at boot from the GeoJSON `aero-2/tools/fetch-buildings.py` writes, so
 * there is no bake step and no tile format. 3D Tiles would add a traversal
 * library and per-frame tile selection on a CPU-bound Pi to stream geometry
 * that fits in one buffer; it earns its place for photogrammetry, not boxes.
 *
 * Flat-shaded: every wall quad and roof has its own vertices so the sun reads
 * on each face. Walls carry a procedural facade (windows on a 3 m grid) whose
 * lit cells are the night-time emissive, so a tower reads as floors of
 * windows by day and a scatter of lit rooms at night. A baked lightmap (second
 * UV set, Babylon's native lightmap slot) darkens each wall toward the street
 * as ambient occlusion, so blocks sit on the ground instead of floating on it.
 * Each building stands on the terrain under its first corner.
 *
 * Two meshes, two draw calls: plaster for most of the city, and glass curtain
 * walls for towers TOWER_M and up (blue, teal, silver and Gulf gold, a tint
 * per tower), whose night texture is office floors lit in bands. Roofs take
 * their colour from the satellite image under them, so a roof reads as the
 * same roof the ground texture shows.
 */
import earcut from 'earcut';
import { Color3, DynamicTexture, Mesh, PBRMaterial, Texture, VertexData, type Scene } from '@babylonjs/core';
import { mulberry32 } from './math.ts';

type Footprint = { geometry: { coordinates: number[][][] }; properties: { height: number } };

const CELLS = 16; // windows per texture side
const CELL_PX = 16;
const FACADE_M = CELLS * 3; // one texture repeat is 16 windows of 3 m
const AO_M = 40; // occlusion fades out this far up a wall
/**
 * Paint, dealt one per building: whitewash and cream most, then the ochres,
 * yellows and light browns of plaster and stone, a little bare concrete and
 * pink. Linear multipliers on the near-white facade texture.
 */
const PAINTS: [weight: number, rgb: [number, number, number]][] = [
	[0.22, [1, 0.98, 0.92]], // whitewash
	[0.2, [1, 0.9, 0.7]], // cream
	[0.16, [1, 0.82, 0.5]], // pale yellow
	[0.14, [0.93, 0.66, 0.38]], // ochre
	[0.12, [0.74, 0.56, 0.4]], // light brown
	[0.1, [0.74, 0.72, 0.69]], // bare concrete
	[0.06, [0.96, 0.74, 0.68]] // dusty pink
];
const ROOF: [number, number, number] = [0.86, 0.84, 0.8]; // flat concrete, sun-bleached
const TOWER_M = 45; // and up: glass, not plaster
const GLASS: [weight: number, rgb: [number, number, number]][] = [
	[0.35, [0.62, 0.78, 0.92]], // blue
	[0.25, [0.58, 0.82, 0.8]], // teal
	[0.25, [0.86, 0.88, 0.9]], // silver
	[0.15, [0.95, 0.8, 0.52]] // Gulf gold
];
const TOWER_ROOF: [number, number, number] = [0.42, 0.43, 0.45];
const WINDOW_M2 = 320; // one lit window point per this much wall, on buildings WINDOW_MIN_M up
const ROOF_M2 = 3_000; // one roof light (stair heads, terrace bulbs, signs) per this much flat roof
const ROOF_LIT = 0.45; // and only on this share of buildings: most roofs are dark
const WINDOW_MIN_M = 12;

export function buildings(
	features: Footprint[],
	project: (lon: number, lat: number) => [x: number, z: number],
	groundAt: (x: number, z: number) => number,
	scene: Scene,
	/** The satellite image's RGB under (x, z), or null off its crop (world.ts). */
	imagery?: (x: number, z: number) => [number, number, number] | null
) {
	// uvs2 is the lightmap: v is height up the wall, 0 at the street.
	const part = () => ({ positions: [] as number[], normals: [] as number[], uvs: [] as number[], uvs2: [] as number[], colors: [] as number[], indices: [] as number[] });
	const [plaster, glass] = [part(), part()];
	const roofLights: number[] = []; // flat [x, y, z]: lights on the flat roofs (lights.ts)
	const windows: number[] = []; // flat [x, y, z]: lit windows as points (lights.ts), crisp at range
	const random = mulberry32(0xae3);

	for (const { geometry, properties } of features) {
		// GeoJSON closes the ring by repeating the first point; drop it.
		const ring = geometry.coordinates[0]!.slice(0, -1).map(([lon, lat]) => project(lon!, lat!));
		if (ring.length < 3) continue;
		const base = groundAt(...ring[0]!);
		const top = base + properties.height;
		const vTop = properties.height / FACADE_M;
		const tower = properties.height >= TOWER_M;
		const { positions, normals, uvs, uvs2, colors, indices } = tower ? glass : plaster;
		// One paint (or glass tint) per building, a little lighter or darker so a street of cream isn't one block.
		const [pr, pg, pb] = pick(tower ? GLASS : PAINTS, random());
		const shade = 0.88 + random() * 0.2;
		const wall = [pr * shade, pg * shade, pb * shade, 1];
		// The roof is the roof the satellite saw: its pixel at the footprint's centre, in linear light,
		// lifted off black (a shadowed pixel would make a hole) and a third concrete. Off the image, plain concrete.
		const [cx, cz] = ring.reduce(([a, b], [x, z]) => [a + x / ring.length, b + z / ring.length], [0, 0]);
		const seen = tower ? null : imagery?.(cx, cz);
		const roofRgb = seen ? seen.map((c, i) => 0.67 * Math.max(0.18, (c / 255) ** 2.2 * 1.6) + 0.33 * ROOF[i]!) : tower ? TOWER_ROOF : ROOF.map((c, i) => (c + [pr, pg, pb][i]!) / 2);
		const roof = [...roofRgb.map((c) => Math.min(1, c * shade)), 1];
		// A whole-window shift per building, so neighbours don't light the same rooms.
		const [u0, v0] = [Math.floor(random() * CELLS) / CELLS, Math.floor(random() * CELLS) / CELLS];

		// Shoelace sign: walls face outward whichever way OSM wound the ring.
		const area = ring.reduce((sum, [x, z], i) => {
			const [nx, nz] = ring[(i + 1) % ring.length]!;
			return sum + x * nz - nx * z;
		}, 0);
		const out = area > 0 ? 1 : -1;

		let along = u0;
		for (const [i, [x0, z0]] of ring.entries()) {
			const [x1, z1] = ring[(i + 1) % ring.length]!;
			const len = Math.hypot(x1 - x0, z1 - z0) || 1e-6;
			const [nx, nz] = [(out * (z1 - z0)) / len, (-out * (x1 - x0)) / len];
			const u1 = along + len / FACADE_M;
			const v = positions.length / 3;
			positions.push(x0, base, z0, x1, base, z1, x1, top, z1, x0, top, z0);
			uvs.push(along, v0, u1, v0, u1, v0 + vTop, along, v0 + vTop);
			const aoTop = Math.min(1, properties.height / AO_M);
			uvs2.push(0.5, 0, 0.5, 0, 0.5, aoTop, 0.5, aoTop);
			for (let k = 0; k < 4; k++) normals.push(nx, 0, nz), colors.push(...wall);
			indices.push(v, v + 1, v + 2, v, v + 2, v + 3);
			// A few lit rooms on this wall: a point a metre proud of it, on a whole floor.
			if (properties.height >= WINDOW_MIN_M) {
				for (let w = Math.floor((len * properties.height) / WINDOW_M2 + random()); w > 0; w--) {
					const [t, floor] = [random(), Math.floor(random() * (properties.height / 3 - 1)) + 1];
					windows.push(x0 + (x1 - x0) * t + nx, base + floor * 3 + 1.5, z0 + (z1 - z0) * t + nz);
				}
			}
			along = u1;
		}

		const v = positions.length / 3;
		for (const [x, z] of ring) {
			positions.push(x, top, z);
			normals.push(0, 1, 0);
			colors.push(...roof);
			uvs.push(u0 + 0.5 / (CELLS * CELL_PX), v0 + 0.5 / (CELLS * CELL_PX)); // a wall texel: roofs read as slab
			uvs2.push(0.5, 1); // roofs are open sky: unoccluded
		}
		const tris = earcut(ring.flat());
		for (const i of tris) indices.push(v + i);
		// Roof lights scattered over the roof's triangles by area: at least one per building,
		// more on the big flat ones. Barycentric draws stay inside the footprint.
		let lit = random() < ROOF_LIT ? 0 : -1; // -1: this roof stays dark
		for (let k = 0; k < tris.length && lit >= 0; k += 3) {
			const [a, b, c] = [ring[tris[k]!]!, ring[tris[k + 1]!]!, ring[tris[k + 2]!]!];
			const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
			for (let n = Math.floor(area / ROOF_M2 + random()) || (k === 0 && !lit ? 1 : 0); n > 0; n--, lit++) {
				let [s, t] = [random(), random()];
				if (s + t > 1) [s, t] = [1 - s, 1 - t];
				roofLights.push(a[0] + (b[0] - a[0]) * s + (c[0] - a[0]) * t, top + 1, a[1] + (b[1] - a[1]) * s + (c[1] - a[1]) * t);
			}
		}
	}

	const ao = occlusion(scene);
	const meshes: Mesh[] = [];
	const materials: PBRMaterial[] = [];
	for (const [name, data, [albedo, lit], roughness] of [
		['buildings', plaster, facade(scene), 0.85],
		['towers', glass, curtainWall(scene), 0.22] // glossy enough to catch the sun as a sheen
	] as const) {
		if (!data.indices.length) continue;
		const mesh = new Mesh(name, scene);
		Object.assign(new VertexData(), data).applyToMesh(mesh);
		mesh.freezeWorldMatrix();
		const material = new PBRMaterial(name, scene);
		material.albedoTexture = albedo;
		material.emissiveTexture = lit;
		material.emissiveColor = Color3.White();
		material.lightmapTexture = ao;
		material.useLightmapAsShadowmap = true; // multiplies the lighting rather than adding to it
		// Shaded walls take the sky's light: the atmosphere writes it to scene.ambientColor, and a
		// PBR material's ambientColor (default black) multiplies it away.
		material.ambientColor = Color3.White();
		material.metallic = 0;
		material.roughness = roughness;
		// ponytail: earcut's roof winding isn't checked against Babylon's; both sides drawn. Cull once verified.
		material.backFaceCulling = false;
		mesh.material = material;
		meshes.push(mesh);
		materials.push(material);
	}
	return { materials, meshes, roofLights, windows };
}

/** Pick from a weighted table by a uniform draw. */
function pick(table: [number, [number, number, number]][], u: number) {
	let acc = 0;
	for (const [weight, rgb] of table) if (u < (acc += weight)) return rgb;
	return table[0]![1];
}

/**
 * A glass curtain wall, 3 m panels: by day pale glass (the tower's tint comes
 * from vertex colour) with a sky-bright upper pane and darker spandrels at each
 * slab, thin mullions, and a few panels a shade off so it isn't a perfect grid.
 * By night, offices lit in runs along a floor, cool white mostly.
 */
function curtainWall(scene: Scene): [DynamicTexture, DynamicTexture] {
	const random = mulberry32(0x91a55);
	const [day, night] = ['glass', 'glass-lit'].map((name) => {
		const tex = new DynamicTexture(name, CELLS * CELL_PX, scene, true);
		tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
		return tex;
	}) as [DynamicTexture, DynamicTexture];
	const [dc, nc] = [day.getContext(), night.getContext()];
	const side = CELLS * CELL_PX;
	dc.fillStyle = '#2c3540'; // mullions and slab edges
	dc.fillRect(0, 0, side, side);
	nc.fillStyle = '#000';
	nc.fillRect(0, 0, side, side);
	for (let row = 0; row < CELLS; row++) {
		let run = 0; // offices light in runs along a floor
		for (let col = 0; col < CELLS; col++) {
			const [x, y] = [col * CELL_PX + 1, row * CELL_PX + 1];
			const pane = dc.createLinearGradient(0, y, 0, y + 11);
			const k = 0.85 + random() * 0.3;
			pane.addColorStop(0, `rgb(${210 * k},${222 * k},${232 * k})`); // the sky, caught in the upper pane
			pane.addColorStop(1, `rgb(${140 * k},${156 * k},${170 * k})`);
			dc.fillStyle = pane;
			dc.fillRect(x, y, CELL_PX - 2, 11);
			dc.fillStyle = `rgb(${92 * k},${100 * k},${110 * k})`; // spandrel
			dc.fillRect(x, y + 11, CELL_PX - 2, CELL_PX - 13);
			if (run <= 0 && random() < 0.18) run = 2 + Math.floor(random() * 7);
			if (run-- > 0) {
				nc.fillStyle = random() < 0.8 ? '#dfe9ff' : '#ffe2b8';
				nc.fillRect(x, y, CELL_PX - 2, 11);
			}
		}
	}
	day.update();
	night.update();
	return [day, night];
}

/**
 * Two 256² tiles of the same window grid. Day: near-white plaster (the paint
 * comes from vertex colour) washed with fine grain and rain streaks under the
 * sills, so a wall reads as weathered paint rather than plastic; glass that
 * catches a little sky. Night: the lit rooms — about a third, in sodium, warm
 * and cool white.
 */
function facade(scene: Scene): [DynamicTexture, DynamicTexture] {
	const random = mulberry32(0xf4c4de);
	const [day, night] = ['facade', 'facade-lit'].map((name) => {
		const tex = new DynamicTexture(name, CELLS * CELL_PX, scene, true);
		tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
		return tex;
	}) as [DynamicTexture, DynamicTexture];
	const [dc, nc] = [day.getContext(), night.getContext()];
	const side = CELLS * CELL_PX;
	dc.fillStyle = '#e4ddd0';
	dc.fillRect(0, 0, side, side);
	// Paint wash: per-texel grain, then soft blotches of uneven coats.
	const wash = dc.getImageData(0, 0, side, side);
	for (let i = 0; i < wash.data.length; i += 4) {
		const g = (random() - 0.5) * 18;
		wash.data[i] += g;
		wash.data[i + 1] += g;
		wash.data[i + 2] += g * 0.9;
	}
	dc.putImageData(wash, 0, 0);
	for (let k = 0; k < 40; k++) {
		const [x, y, r] = [random() * side, random() * side, 10 + random() * 30];
		dc.fillStyle = random() < 0.5 ? 'rgba(120,100,80,0.06)' : 'rgba(255,250,240,0.08)';
		dc.beginPath();
		dc.arc(x, y, r, 0, Math.PI * 2);
		dc.fill();
	}
	nc.fillStyle = '#000';
	nc.fillRect(0, 0, CELLS * CELL_PX, CELLS * CELL_PX);
	const lamps = ['#ffb35c', '#ffd9a0', '#fff1d6', '#cfe0ff'];
	for (let row = 0; row < CELLS; row++) {
		for (let col = 0; col < CELLS; col++) {
			const [x, y] = [col * CELL_PX + 3, row * CELL_PX + 4];
			dc.fillStyle = random() < 0.2 ? '#6a7682' : '#3c4854';
			dc.fillRect(x, y, 10, 8);
			// A rain streak under some sills, fading down the wall.
			if (random() < 0.4) {
				const streak = dc.createLinearGradient(0, y + 8, 0, y + 8 + CELL_PX * 0.8);
				streak.addColorStop(0, 'rgba(70,60,50,0.22)');
				streak.addColorStop(1, 'rgba(70,60,50,0)');
				dc.fillStyle = streak;
				dc.fillRect(x + 1 + random() * 6, y + 8, 2 + random() * 3, CELL_PX * 0.8);
			}
			if (random() < 0.33) {
				nc.fillStyle = lamps[Math.floor(random() * lamps.length)]!;
				nc.fillRect(x, y, 10, 8);
			}
		}
	}
	day.update();
	night.update();
	return [day, night];
}

/** A 1×64 ramp, dark at the street and clear by AO_M up: the lightmap every wall shares. */
function occlusion(scene: Scene) {
	const tex = new DynamicTexture('building-ao', { width: 1, height: 64 }, scene, false);
	const ctx = tex.getContext();
	for (let y = 0; y < 64; y++) {
		const t = 1 - y / 63; // canvas row 0 is the top of the ramp (v = 1)
		const k = Math.round(255 * (0.45 + 0.55 * t * t * (3 - 2 * t)));
		ctx.fillStyle = `rgb(${k},${k},${k})`;
		ctx.fillRect(0, y, 1, 1);
	}
	tex.update();
	tex.coordinatesIndex = 1;
	tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
	return tex;
}
