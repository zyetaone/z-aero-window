/**
 * Content bundle — a pushable unit of scene content.
 *
 * Bundles carry their own metadata, data URLs, and activation rules.
 * The shape is intentionally JSON-friendly: no functions, no closures —
 * so it can travel over HTTP, be stored on disk, or come from an admin UI.
 *
 * Wire types only: there is no runtime loader in aero-1 (the bundle is
 * stored by server/bundle/disk.ts and listed by /admin/content). `when` is
 * carried on the wire for a future loader but not evaluated anywhere.
 */

import type { LocationId, SkyState, WeatherType } from '$lib/types';
type LayerKind = 'earth' | 'sky' | 'pane';
type BundleType = 'video-bg' | 'sprite';

/**
 * Declarative when-predicate. Evaluated against AeroWindow at render time.
 * All fields are AND-ed; within a field, values are OR-ed (e.g. any of these locations).
 * Omitted fields impose no constraint.
 */
export interface WhenPredicate {
	/** Active only when current location matches one of these. */
	location?: LocationId[];
	/** Active only when nightFactor is within [min, max]. */
	nightFactor?: { min?: number; max?: number };
	/** Active only when skyState matches one of these. */
	skyState?: SkyState[];
	/** Active only when weather matches one of these. */
	weather?: WeatherType[];
}

/** Shared fields across all bundle types. */
interface BundleBase {
	id: string;
	type: BundleType;
	kind: LayerKind;
	/** CSS z-index within scene-content. */
	z: number;
	/** Activation predicate. Omit for always-on. */
	when?: WhenPredicate;
}

/** video-bg bundle — full-scene HTML5 <video> loop. */
export interface VideoBgBundle extends BundleBase {
	type: 'video-bg';
	/** URL of the video asset (relative or absolute). */
	asset: string;
	/** CSS object-fit value — default 'cover'. */
	fit?: 'cover' | 'contain' | 'fill';
	/** Opacity 0..1, default 1. */
	opacity?: number;
	/** CSS mix-blend-mode, default 'normal'. */
	blend?: 'normal' | 'screen' | 'multiply' | 'overlay';
}

/**
 * sprite bundle — single Cesium Billboard at a geo-position.
 * Use cases: Santa sleigh in December, passing-plane silhouette,
 * landmark markers, brand overlays.
 */
export interface SpriteBundle extends BundleBase {
	type: 'sprite';
	/** URL of the image asset (PNG/JPG/WebP). */
	image: string;
	/** Geo-position. */
	lat: number;
	lon: number;
	/** Meters above ellipsoid. Omit for clamp-to-ground. */
	altitude?: number;
	/** Pixel size — default 48×48. */
	width?: number;
	height?: number;
}

/** Union of all bundle shapes — extend when adding new BundleType. */
export type ContentBundle = VideoBgBundle | SpriteBundle;

/** Minimal shape guard — confirms the value looks like a ContentBundle before dispatch. */
export function isContentBundle(value: unknown): value is ContentBundle {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== 'string' || v.id.length === 0) return false;
	if (typeof v.type !== 'string') return false;
	if (typeof v.kind !== 'string') return false;
	if (typeof v.z !== 'number') return false;
	return true;
}

/**
 * Allowed bundle-id alphabet. Shared by POST /api/content and
 * DELETE /api/content/[id] so the two routes can never drift apart on
 * what "valid id" means. ASCII alnum + dash + underscore, 1..64 chars —
 * safe as a filename segment without escaping.
 */
export const BUNDLE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
