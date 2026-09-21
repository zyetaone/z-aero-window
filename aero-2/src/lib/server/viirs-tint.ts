/**
 * VIIRS mask bake — luminance → amber alpha + grain tooth, server side.
 *
 * WHY HERE AND NOT IN PAINT: MapLibre has no raster color-ramp (`raster-color`
 * does not exist in maplibre-gl — checked against 6.6.0), and the raw VIIRS
 * frame is a WHITE map: bright cores render as a white sheet pasted on the
 * night. The mask has to happen before the bytes reach the client, so the
 * tile route tints every `viirs` tile through this module (local pack and
 * dev remote fallback alike — one code path, one look).
 *
 * Per pixel, from input luminance L and alpha A:
 *   mask  — A==0 stays 0; else alpha = L^0.8, so satellite-black shows the
 *           ground beneath (the lower texture survives = the mask) and only
 *           real light glows;
 *   amber — deep (120,60,20) → mid (255,150,60) → top (255,205,140). The top
 *           is warm amber, never white. Ported from aero-1's February
 *           emissive-lights shader (commit e4a95254): a per-pixel hash deals
 *           lit pixels into sodium/amber/warm-white/cool-white buckets so
 *           neighbouring lamps resolve to different colours instead of one
 *           flat amber, and ~3% of bright pixels spark traffic-red for
 *           beacon/taillight texture. Variance is deliberately TAMED
 *           (follow-up 52197ebd narrowed it after the bleed): mostly amber,
 *           occasional white, rare red — never pure white;
 *   grain — 2px cells of the seeded tileable noise (server/grain.ts),
 *           0.8..1.2× on rgb only, breaking the 468 m/px z8 blocks.
 *
 * Pure function of the input bytes (pngjs decode → map → encode), so it is
 * deterministic across panes and boots; immutable-cacheable like any tile.
 * Corrupt input throws — the ROUTE catches that and serves the raw tile
 * (fail open to the old look, never 500 a light).
 */
import { PNG } from 'pngjs';

import { grainValue } from './grain.js';

type RGB = readonly [number, number, number];
const DEEP: RGB = [120, 60, 20];
const MID: RGB = [255, 150, 60];
const TOP: RGB = [255, 205, 140];

function lerp(a: number, b: number, t: number): number {
	return a + (b - a) * t;
}

function ramp(t: number): RGB {
	if (t < 0.5) {
		const k = t / 0.5;
		return [lerp(DEEP[0], MID[0], k), lerp(DEEP[1], MID[1], k), lerp(DEEP[2], MID[2], k)];
	}
	const k = (t - 0.5) / 0.5;
	return [lerp(MID[0], TOP[0], k), lerp(MID[1], TOP[1], k), lerp(MID[2], TOP[2], k)];
}

export function tintViirs(pngBytes: Uint8Array): Uint8Array {
	const src = PNG.sync.read(Buffer.from(pngBytes));
	const { width, height, data } = src;
	const out = new PNG({ width, height });
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const inA = data[i + 3];
			if (inA === 0) {
				out.data[i] = 0;
				out.data[i + 1] = 0;
				out.data[i + 2] = 0;
				out.data[i + 3] = 0;
				continue;
			}
			const lum = (data[i] + data[i + 1] + data[i + 2]) / 3 / 255;
			const t = Math.max(0, Math.min(1, lum));
			let [r, g, b] = ramp(t);
			if (t > 0.15) {
				// Palette deal: position+luminance hash, so the same lamp
				// reads the same bucket on every pane and every boot.
				const s = Math.sin(x * 12.9898 + y * 78.233 + t * 37.719) * 43758.5453;
				const h = s - Math.floor(s);
				if (h < 0.6) {
					// Sodium/amber majority: as ramped.
				} else if (h < 0.78) {
					r = lerp(r, 255, 0.5);
					g = lerp(g, 232, 0.5);
					b = lerp(b, 205, 0.5);
				} else if (h < 0.9) {
					r = lerp(r, 205, 0.45);
					g = lerp(g, 222, 0.45);
					b = lerp(b, 255, 0.45);
				}
				// Traffic-red sparks: rare, bright cores only.
				const s2 = Math.sin(x * 39.346 + y * 11.135 + t * 73.137) * 24634.6345;
				const h2 = s2 - Math.floor(s2);
				if (h2 < 0.03 && t > 0.4) {
					r = lerp(r, 255, 0.6);
					g = lerp(g, 45, 0.6);
					b = lerp(b, 20, 0.6);
				}
			}
			const grain = grainValue(x & ~1, y & ~1) / 255;
			// Colour scales with luminance too (Feb: light = colour * lum): mids dim, cores bright.
			const mult = (0.8 + 0.4 * grain) * (0.35 + 0.65 * t * t);
			out.data[i] = Math.max(0, Math.min(255, Math.round(r * mult)));
			out.data[i + 1] = Math.max(0, Math.min(255, Math.round(g * mult)));
			out.data[i + 2] = Math.max(0, Math.min(255, Math.round(b * mult)));
			/**
			 * Alpha knee at 0.35..0.75, not lum^0.8. z8 VIIRS over a conurbation is
			 * mid-bright almost everywhere (Dubai: ~4 in 5 pixels above 0.12), so a
			 * low floor pasted a cream sheet over the city. Feb's Cesium look kept
			 * only the top of the range (contrast 1.8 + colorToAlpha + lum<0.2
			 * crush); this is that threshold as one smoothstep. Measured
			 * 2026-09-21, same frozen viewpoint: cores and road filaments over a
			 * dark city instead of a blanket.
			 */
			const k = Math.max(0, Math.min(1, (t - 0.35) / 0.4));
			out.data[i + 3] = Math.round((inA / 255) * (k * k * (3 - 2 * k)) * 255);
		}
	}
	return new Uint8Array(PNG.sync.write(out));
}
