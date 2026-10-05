/** Web Mercator, as the tile packs use it: one home for the grid both world.ts and ground-maps.ts read. */
import { RAD } from './math.ts';

export const TILE = 256; // px per tile
/** `span` × `span` tiles at zoom `z`, top-left tile (x0, y0). */
export type Grid = { z: number; x0: number; y0: number; span: number };
/** Longitude and latitude to global Mercator, 0..1 across the world. */
export const mercX = (lon: number) => (lon + 180) / 360;
export const mercY = (lat: number) => (1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2;
