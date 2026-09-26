/**
 * clouds (Cesium billboard bank) — module-level functions.
 *
 * 2-band PNG-sprite cloud bank at the WGS84 cloud deck. Same recipe
 * as Clouds.svelte but using Cesium's BillboardCollection for
 * GPU-instanced single-draw-call rendering. 3-Pi panorama
 * determinism via daySeed().
 *
 * Re-rendered when location / weather / density / enabled changes
 * (cache-keyed on a coarse hash so per-frame calls are cheap).
 */

import type { WeatherType } from '$lib/types';
import type * as CesiumType from 'cesium';
import { createSeededRng, daySeed } from '../prng';
import { metresToGeoDelta, spriteOffset, spriteScale } from './sprite-placement';
import { registerViewerTeardown } from '../viewer-lifecycle';

/**
 * Deck height in metres (~23k ft). Exported because it is not only this
 * module's business: the "Over the Deck" show exists on the premise that the
 * `clouds` location cruises ABOVE it, and its test has to check that against
 * the real number rather than a copy that can drift out from under it.
 */
export const CLOUD_ALT_M = 7_000;

// ---- DISTANT BAND ----
const DISTANT_RADIUS_MIN = 42_000;
const DISTANT_RADIUS_SPAN = 265_000 - 42_000;
const DISTANT_BASE_SCALE_MIN = 18_000;
const DISTANT_BASE_SCALE_SPAN = 32_000 - 18_000;
const DISTANT_SPRITE_MIN = 9;
const DISTANT_SPRITE_SPAN = 8;
const DISTANT_LONELY = 0.03;

// ---- CLOSE BAND ----
const CLOSE_RADIUS_MIN = 1_500;
const CLOSE_RADIUS_SPAN = 30_000 - 1_500;
const CLOSE_BASE_SCALE_MIN = 3_000;
const CLOSE_BASE_SCALE_SPAN = 6_000 - 3_000;
const CLOSE_SPRITE_MIN = 4;
const CLOSE_SPRITE_SPAN = 7;
const CLOSE_LONELY = 0.10;

const TEXTURES: Record<WeatherType, readonly string[]> = {
	clear:    ['/cloud.webp'],
	cloudy:   ['/cloud.webp'],
	rain:     ['/cloud.webp', '/cloud-dark.webp'],
	overcast: ['/cloud-dark.webp', '/cloud-smoke.webp'],
	storm:    ['/cloud-dark.webp', '/cloud-smoke.webp'],
};

// Module-private state.
let _C: typeof CesiumType | null = null;
let _viewer: CesiumType.Viewer | null = null;
let _collection: CesiumType.BillboardCollection | null = null;
let _lastKey = '';
let _mounted = false;

/**
 * One-time mount: create the BillboardCollection and add it to the
 * scene. Idempotent. Accepts the live Cesium + Viewer from CesiumManager
 * so the module mounts BEFORE `activeCesium.manager` is published.
 *
 * Liveness-guarded: `_mounted` is only valid while its viewer lives. If
 * `onDestroy` fired while `CesiumManager.start()` was suspended in an await,
 * `destroy()` ran first and `start()` then resumes calling this on a
 * destroyed viewer — latching there would bar every later (live) mount for
 * the rest of the session.
 */
export function mountCesiumClouds(
	C: typeof CesiumType,
	viewer: CesiumType.Viewer,
): void {
	if (_mounted) {
		if (_viewer && !_viewer.isDestroyed?.()) return;
		// Stale latch from a destroyed viewer — drop it and remount below.
		_collection = null;
		_mounted = false;
	}
	// Never mount onto a viewer that is already destroyed (start() resuming
	// after destroy()).
	if (viewer.isDestroyed()) return;
	_C = C;
	_viewer = viewer;
	_collection = viewer.scene.primitives.add(new C.BillboardCollection());
	_mounted = true;
}

/**
 * Re-roll the cloud bank when location / weather / density / enabled
 * changes. Caches against a coarse key so per-frame calls are cheap.
 */
export function updateCesiumClouds(
	lat: number,
	lon: number,
	weather: WeatherType,
	density: number,
	altitudeFt: number,
	enabled: boolean,
): void {
	if (!_collection || !_mounted) return;

	if (!enabled || density < 0.05) {
		if (_collection.length > 0) _collection.removeAll();
		_lastKey = '';
		return;
	}

	const key = `${Math.round(lat * 4)}|${Math.round(lon * 4)}|${weather}|${density.toFixed(2)}|${Math.round(altitudeFt / 1000)}`;
	if (key === _lastKey) return;
	_lastKey = key;

	_collection.removeAll();

	const C = _C;
	if (!C) return;
	const textures = TEXTURES[weather] ?? TEXTURES.clear;

	// 3-Pi panorama determinism
	const rng = createSeededRng(daySeed());

	// Altitude gain — bigger at low altitude, smaller at cruise
	const altGain = Math.max(0.4, Math.min(1.8, 35000 / Math.max(altitudeFt, 2000)));

	// ---- DISTANT BAND (horizon weather systems) ----
	const distantCount = Math.round(60 + Math.min(1, density) * 50);

	for (let c = 0; c < distantCount; c++) {
		const theta = rng() * Math.PI * 2;
		const r = DISTANT_RADIUS_MIN + Math.sqrt(rng()) * DISTANT_RADIUS_SPAN;
		const cx = Math.cos(theta) * r;
		const cz = -Math.sin(theta) * r;
		const ch = (rng() - 0.18) * 4600;

		const baseScale = DISTANT_BASE_SCALE_MIN + rng() * DISTANT_BASE_SCALE_SPAN;
		const isLonely = rng() < DISTANT_LONELY;
		const spriteCount = isLonely ? 1 : DISTANT_SPRITE_MIN + Math.floor(rng() * DISTANT_SPRITE_SPAN);

		for (let i = 0; i < spriteCount; i++) {
			const isAnchor = i === 0;
			const { ox, oy, oz } = spriteOffset(i, cx, ch, cz, baseScale, rng);

			const brightness = isAnchor ? 0.74 : 0.62 + (rng() - 0.5) * 0.12;
			const opacity = isAnchor ? 0.48 : 0.32 + rng() * 0.28;
			const sprScale = spriteScale(i, baseScale, rng);
			const img = textures[Math.floor(rng() * textures.length)];

			const worldX = ox;
			const worldY = oy + CLOUD_ALT_M;
			// Raw oz — the Three overlay places at the same oz verbatim
			// (Clouds.svelte `sprite.position.set(ox, oy, oz)`); mirroring Z
			// around the cluster centre here broke the identical-placement
			// contract in clouds/sprite-placement.ts.
			const worldZ = oz;

			const d = metresToGeoDelta(worldX, worldZ, lat);
			const position = C.Cartesian3.fromDegrees(lon + d.lon, lat + d.lat, worldY);

			_collection.add({
				position,
				image: img,
				color: new C.Color(brightness, brightness, brightness, opacity),
				scale: sprScale / 3000 * altGain,
				sizeInMeters: true,
				width: sprScale * 1.30,
				height: sprScale,
				translucencyByDistance: new C.NearFarScalar(
					DISTANT_RADIUS_MIN, 1.0,
					DISTANT_RADIUS_MIN + DISTANT_RADIUS_SPAN, 0.45,
				),
			});
		}
	}

	// ---- CLOSE BAND (passenger-window sprites) ----
	const closeCount = Math.round(24 + Math.min(1, density) * 16);

	for (let c = 0; c < closeCount; c++) {
		const theta = rng() * Math.PI * 2;
		const r = CLOSE_RADIUS_MIN + Math.sqrt(rng()) * CLOSE_RADIUS_SPAN;
		const cx = Math.cos(theta) * r;
		const cz = -Math.sin(theta) * r;
		const ch = (rng() - 0.18) * 1400;

		const baseScale = CLOSE_BASE_SCALE_MIN + rng() * CLOSE_BASE_SCALE_SPAN;
		const isLonely = rng() < CLOSE_LONELY;
		const spriteCount = isLonely ? 1 : CLOSE_SPRITE_MIN + Math.floor(rng() * CLOSE_SPRITE_SPAN);

		for (let i = 0; i < spriteCount; i++) {
			const isAnchor = i === 0;
			const { ox, oy, oz } = spriteOffset(i, cx, ch, cz, baseScale, rng);

			const brightness = isAnchor ? 0.78 : 0.65 + (rng() - 0.5) * 0.10;
			const opacity = isAnchor ? 0.55 : 0.36 + rng() * 0.24;
			const sprScale = spriteScale(i, baseScale, rng);
			const img = textures[Math.floor(rng() * textures.length)];

			const worldX = ox;
			const worldY = oy + CLOUD_ALT_M * 0.85;
			// Raw oz — the Three overlay places at the same oz verbatim
			// (Clouds.svelte `sprite.position.set(ox, oy, oz)`); mirroring Z
			// around the cluster centre here broke the identical-placement
			// contract in clouds/sprite-placement.ts.
			const worldZ = oz;

			const d = metresToGeoDelta(worldX, worldZ, lat);
			const position = C.Cartesian3.fromDegrees(lon + d.lon, lat + d.lat, worldY);

			_collection.add({
				position,
				image: img,
				color: new C.Color(brightness, brightness, brightness, opacity),
				scale: sprScale / 1500 * altGain,
				sizeInMeters: true,
				width: sprScale * 1.30,
				height: sprScale,
				translucencyByDistance: new C.NearFarScalar(
					CLOSE_RADIUS_MIN, 1.0,
					CLOSE_RADIUS_MIN + CLOSE_RADIUS_SPAN, 0.35,
				),
			});
		}
	}
}

/** Tear down the collection. Idempotent. */
export function destroyCesiumClouds(): void {
	if (!_collection) return;
	if (_viewer && !_viewer.isDestroyed?.()) {
		_viewer.scene.primitives.remove(_collection);
	}
	_collection = null;
	_C = null;
	_viewer = null;
	_mounted = false;
	_lastKey = '';
}

// See lightning-stage: already explicit, now in the shared list.
registerViewerTeardown('clouds', destroyCesiumClouds);
