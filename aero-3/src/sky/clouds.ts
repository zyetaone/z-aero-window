/**
 * The cloud deck: aero-2's cluster model (Clouds.svelte) on one Babylon
 * SpriteManager — one draw call for the whole sky.
 *
 * Kept from aero-2, because it is what makes PNG sprite stacking read as cloud:
 * an anchor puff with smaller puffs spread radially around it; low per-puff
 * opacity so density builds where puffs overlap; darker undersides; a
 * pseudo-normal per puff (its offset from the anchor) so the sun side of a
 * cluster is brighter; and a pow(cos, 6) forward-scatter glow when looking
 * toward a low sun. Three tiers: cumulus passing below the window, big
 * systems out to the horizon, thin cirrus above the aircraft.
 *
 * Changed for Babylon: light comes from the atmosphere's own numbers (the
 * sun colour it transmitted to the light, the sky's ambient) instead of
 * hand-tuned golden-hour tables, and cards are squashed vertically so a puff
 * stays between the hills and the window. Seeded layout and wall-clock wind
 * keep three panes identical without talking, and the weather changes daily:
 * day.ts deals each place a regime per UTC day, and a layout for the near and
 * mid tiers: scattered, in streets along the wind, massed in a front on one
 * side, or in a few separate groups. Draws in rendering group 1,
 * after the atmosphere composites the sky, so the sky cannot paint over it.
 */
import { Color3, Color4, Sprite, SpriteManager, Vector3, type Camera, type DirectionalLight, type Scene } from '@babylonjs/core';
import { mulberry32, smoothstep } from '../math.ts';
import type { Day } from '../day.ts';
import cloud from '../assets/cloud.webp';
import cloudDark from '../assets/cloud-dark.webp';
import cloudSmoke from '../assets/cloud-smoke.webp';

const CELL = 256;
const UNDERGLOW = new Color3(0.07, 0.05, 0.035);
const NIGHT_FLOOR = new Color3(0.03, 0.035, 0.05);

type Puff = { sprite: Sprite; x: number; z: number; y: number; alpha: number; shade: number; normal: Vector3; wrap: number };

// Which of a regime's three covers (near, horizon, cirrus) drives each tier: banks follow the horizon.
const COVER_OF = [0, 1, 1, 2];

const TIERS = [
	// near cumulus passing below the window
	{ r0: 3_000, rs: 45_000, s0: 1_200, ss: 1_400, n0: 4, ns: 5, lonely: 0.12, lift: 0, squash: 0.6, count: 40, cells: [0, 1] },
	// big systems out to the horizon
	{ r0: 40_000, rs: 180_000, s0: 6_000, ss: 7_000, n0: 6, ns: 7, lonely: 0.05, lift: 300, squash: 0.45, count: 45, cells: [0, 1] },
	// long flat banks sitting on the horizon
	{ r0: 120_000, rs: 110_000, s0: 10_000, ss: 10_000, n0: 4, ns: 4, lonely: 0, lift: 1_200, squash: 0.2, count: 30, cells: [0, 1] },
	// thin cirrus above the aircraft
	{ r0: 20_000, rs: 140_000, s0: 9_000, ss: 12_000, n0: 3, ns: 4, lonely: 0.2, lift: 6_500, squash: 0.25, count: 12, cells: [2] }
];

export async function createClouds(
	scene: Scene,
	camera: Camera,
	sun: DirectionalLight,
	center: [x: number, z: number],
	deckM: number,
	/** The ground under a puff: no card may reach below it, or the terrain clips it flat. */
	groundAt: (x: number, z: number) => number,
	drop: (x: number, z: number) => number,
	weather: Day,
	cover = 1
) {
	const manager = new SpriteManager('clouds', await spriteSheet(), 2500, CELL, scene);
	manager.disableDepthWrite = true;
	manager.isPickable = false;
	manager.renderingGroupId = 1;
	scene.setRenderingAutoClearDepthStencil(1, false); // keep group 0's depth: the terrain still hides what is behind it

	const random = mulberry32(weather.seed);
	const puffs: Puff[] = [];
	const [wx, wz] = [Math.cos(weather.windDir), Math.sin(weather.windDir)];
	const clumps = Array.from({ length: 3 + Math.floor(random() * 3) }, () => random() * Math.PI * 2);
	/** A cluster's offset from the centre, by today's layout (only the near and mid tiers take it). */
	const spot = (tier: number, r0: number, rs: number): [number, number] => {
		const layout = tier < 2 ? weather.layout : 'scatter';
		if (layout === 'streets') {
			// Rows along the wind, ~4 km apart near (three times the deck), wider out.
			const gap = tier === 0 ? 4_000 : 18_000;
			const [along, across] = [(random() * 2 - 1) * (r0 + rs), (Math.round((random() - 0.5) * 2 * ((r0 + rs) / gap)) + (random() - 0.5) * 0.2) * gap];
			return [along * wx - across * wz, along * wz + across * wx];
		}
		const a =
			layout === 'front' ? weather.windDir + Math.PI / 2 + (random() - 0.5) * 1.4 // a wall of cloud across the wind, one side of the sky
			: layout === 'clumps' ? clumps[Math.floor(random() * clumps.length)]! + (random() - 0.5) * 0.5
			: random() * Math.PI * 2;
		const d = r0 + Math.sqrt(random()) * rs;
		return [Math.cos(a) * d, Math.sin(a) * d];
	};
	for (const [tier, t] of TIERS.entries()) {
		const tierCover = weather.cover[COVER_OF[tier]!]!;
		for (let c = 0; c < Math.round(t.count * cover * tierCover); c++) {
			const [ox, oz] = spot(tier, t.r0, t.rs);
			const [cx, cz, cy] = [center[0] + ox, center[1] + oz, deckM + t.lift + (random() - 0.5) * 400];
			// Mostly modest, a few big: squaring the draw skews sizes the way a real deck does.
			const base = (t.s0 + random() ** 2 * t.ss * 1.3) * (tier < TIERS.length - 1 ? weather.size : 1);
			const n = random() < t.lonely ? 1 : t.n0 + Math.floor(random() * t.ns);
			// Near cumulus heap upward on a convective day: puffs climb above the anchor, not around it.
			const heap = tier === 0 ? weather.build : 0;
			// Each cluster a shade of its own, greyer on a leaden day: no two clouds the same white.
			const tone = 1 - weather.grey * (0.15 + 0.3 * random()) - 0.08 * random();
			for (let i = 0; i < n; i++) {
				const [theta, r] = [random() * Math.PI * 2, i === 0 ? 0 : (0.2 + random() * 0.8) * base * 1.6];
				const size = base * (i === 0 ? 1.25 : 0.85 + random() * 0.55);
				// Keep the card's visible body above the ground: a big puff dipping into the terrain is cut
				// off by its depth as a hard horizontal line (0.4 of the height: the PNGs fade at the rim).
				const [x, z] = [cx + Math.cos(theta) * r, cz + Math.sin(theta) * r];
				const lowest = groundAt(x, z) + drop(x, z) + 300 + size * t.squash * 0.4;
				const y = Math.max(lowest, cy + (i === 0 ? 0 : (random() - 0.5 + heap * 0.6) * base * (0.35 + heap * 0.5) * t.squash));
				const sprite = new Sprite('puff', manager);
				sprite.cellIndex = t.cells[Math.floor(random() * t.cells.length)]!;
				// Near-upright with a mirror for variety: a squashed card at a random angle reads as a flame.
				sprite.angle = (random() - 0.5) * 0.3;
				sprite.invertU = random() < 0.5;
				sprite.width = size;
				sprite.height = size * t.squash;
				sprite.color = new Color4();
				// Underside darker than tops, as aero-2 shades it.
				const lift = smoothstep(0, 1, (y - cy + base * 0.1 * t.squash) / (base * 0.2 * t.squash));
				const normal = new Vector3(x - cx, y - cy, z - cz).normalize();
				puffs.push({ sprite, x, z, y, alpha: 0.26 + random() * 0.28, shade: (0.84 + 0.14 * lift) * tone, normal, wrap: t.r0 + t.rs + t.s0 + t.ss });
			}
		}
	}

	const [sunColor, view] = [new Color3(), new Vector3()];
	let frame = 0;
	return {
		/** `toSun` is the unit vector to the sun; `dark` 0 by day, 1 at night. */
		update(nowMs: number, toSun: Vector3, dark: number) {
			const shift = (nowMs / 1000) * weather.wind; // today's speed, toward today's direction
			sun.diffuse.scaleToRef(Math.min(1, sun.intensity), sunColor);
			const ambient = scene.ambientColor;
			const elevation = Math.asin(toSun.y) * (180 / Math.PI);
			const mieGain = (1 - dark) * (elevation > 0 && elevation < 25 ? 1.4 : 0.6);

			for (const p of puffs) {
				// Each tier wraps on its own square (aero-2's wrapR), so wind never blows the
				// near deck away from the place; puffs fade over the square's outer 12%.
				const [dx, dz] = [wrap(p.x - center[0] + shift * wx, p.wrap), wrap(p.z - center[1] + shift * wz, p.wrap)];
				const [x, z] = [center[0] + dx, center[1] + dz];
				const edge = Math.min(1, (p.wrap - Math.max(Math.abs(dx), Math.abs(dz))) / (0.12 * p.wrap));
				const s = p.sprite;
				s.position.set(x, p.y - drop(x, z), z);
				const far = Math.hypot(x - camera.position.x, z - camera.position.z);

				// Forward scatter toward a low sun, and the sun side of each cluster brighter.
				s.position.subtractToRef(camera.position, view).normalize();
				const mie = Math.max(0, Vector3.Dot(view, toSun)) ** 6 * mieGain;
				const sunSide = Math.max(0, Vector3.Dot(p.normal, toSun)) * (1 - dark) * 0.35;
				const lit = p.shade * (0.7 + sunSide + mie * 1.5);
				const alpha = p.alpha * Math.max(0, edge) * (1 - smoothstep(190_000, 300_000, far));
				s.isVisible = alpha > 0.01; // faded out at the wrap edge or past 190 km: skip the draw
				s.color!.set(
					Math.min(1, (ambient.r + sunColor.r * lit) * p.shade + NIGHT_FLOOR.r + UNDERGLOW.r * dark),
					Math.min(1, (ambient.g + sunColor.g * lit) * p.shade + NIGHT_FLOOR.g + UNDERGLOW.g * dark),
					Math.min(1, (ambient.b + sunColor.b * lit) * p.shade + NIGHT_FLOOR.b + UNDERGLOW.b * dark),
					alpha // no aerial perspective on sprites, so the distant ones fade into the haze
				);
			}
			// Alpha blending wants back-to-front; the deck drifts slowly, so re-sort now and then.
			if (frame++ % 30 === 0) {
				const c = camera.position;
				manager.sprites.sort((a, b) => Vector3.DistanceSquared(b.position, c) - Vector3.DistanceSquared(a.position, c));
			}
		}
	};
}

const wrap = (d: number, w: number) => ((((d + w) % (2 * w)) + 2 * w) % (2 * w)) - w;

/** The three puffs side by side: one texture, one draw call. */
async function spriteSheet() {
	const canvas = new OffscreenCanvas(CELL * 3, CELL);
	const ctx = canvas.getContext('2d')!;
	const images = await Promise.all([cloud, cloudDark, cloudSmoke].map(async (url) => createImageBitmap(await (await fetch(url)).blob())));
	images.forEach((image, i) => ctx.drawImage(image, i * CELL, 0, CELL, CELL));
	return URL.createObjectURL(await canvas.convertToBlob());
}
