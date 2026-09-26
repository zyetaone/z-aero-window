#!/usr/bin/env bun

import { LOCATIONS } from '../content/locations';
import type { LocationId } from '../src/lib/types';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { EOX_SENTINEL2 } from '../src/lib/upstream';

// One source, because only one of the three that used to be here actually
// answers. ESRI World Imagery was removed on licence grounds: proprietary
// (Maxar/Airbus via Esri), and the free endpoint does not cover a commercial
// kiosk, still less caching it to disk — which is exactly what this script
// does. Do not add it back. The other two were already dead and had been for
// long enough that nobody noticed: roda.sentinel2.live does not resolve, and
// landsat2.storage.googleapis.com answers 404 for every tile. Both were
// selectable, so choosing either silently produced an empty cache.
//
// Licence note: EOX s2cloudless is CC BY-NC-SA — NON-commercial. It is already
// this app's only imagery source, so this adds no new exposure, but it is an
// open question, not a settled one. See $lib/upstream.
const TILE_SOURCES = {
	sentinel2: EOX_SENTINEL2.url,
} as const;

type SourceId = keyof typeof TILE_SOURCES;

const DEFAULT_ZOOMS = [12, 13, 14, 15, 16];
const DEFAULT_RADIUS = 0.3;
const DELAY_MS = 50;


interface TileCoord {
	z: number;
	x: number;
	y: number;
}

interface Manifest {
	generated: string;
	sources: SourceId[];
	locations: Record<
		LocationId,
		{
			zoomLevels: Record<number, { tileCount: number; source: SourceId }>;
			totalTiles: number;
		}
	>;
	totalTiles: number;
}

function latToTile(lat: number, z: number): number {
	const latRad = (lat * Math.PI) / 180;
	const n = Math.pow(2, z);
	return Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
}

function lonToTile(lon: number, z: number): number {
	const n = Math.pow(2, z);
	return Math.floor(((lon + 180) / 360) * n);
}

function tileToLat(tileY: number, z: number): number {
	const n = Math.pow(2, z);
	const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * tileY) / n)));
	return (latRad * 180) / Math.PI;
}

function tileToLon(tileX: number, z: number): number {
	const n = Math.pow(2, z);
	return ((tileX / n) * 360) - 180;
}

function getTileBounds(lat: number, lon: number, radiusDegrees: number, z: number): TileCoord[] {
	const centerTileX = lonToTile(lon, z);
	const centerTileY = latToTile(lat, z);
	const radiusTiles = Math.ceil((radiusDegrees / 360) * Math.pow(2, z));

	const tiles: TileCoord[] = [];
	for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
		for (let dy = -radiusTiles; dy <= radiusTiles; dy++) {
			const tx = centerTileX + dx;
			const ty = centerTileY + dy;
			const n = Math.pow(2, z);
			if (tx < 0 || ty < 0 || ty >= n || tx >= n) continue;

			const tileLat = tileToLat(ty, z);
			const tileLon = tileToLon(tx, z);
			const distLat = Math.abs(tileLat - lat);
			const distLon = Math.abs(tileLon - lon);
			if (distLat <= radiusDegrees && distLon <= radiusDegrees) {
				tiles.push({ z, x: tx, y: ty });
			}
		}
	}
	return tiles;
}

function getTileUrl(source: SourceId, tile: TileCoord): string {
	switch (source) {
		case 'sentinel2':
			// EOX is WMTS: {z}/{y}/{x}, y BEFORE x. Getting this backwards
			// returns other places' tiles rather than an error.
			return TILE_SOURCES.sentinel2
				.replace('{z}', String(tile.z))
				.replace('{y}', String(tile.y))
				.replace('{x}', String(tile.x));
	}
	throw new Error(`Unknown source: ${source}`);
}

async function downloadTile(url: string): Promise<Buffer | null> {
	try {
		const res = await fetch(url);
		if (!res.ok) return null;
		const blob = await res.arrayBuffer();
		return Buffer.from(blob);
	} catch {
		return null;
	}
}

async function saveTile(dir: string, tile: TileCoord, data: Buffer): Promise<void> {
	const tilePath = join(dir, String(tile.z), String(tile.x), `${tile.y}.jpg`);
	const tileDir = dirname(tilePath);
	if (!existsSync(tileDir)) mkdirSync(tileDir, { recursive: true });
	writeFileSync(tilePath, data);
}

function parseArgs(): { locationIds: LocationId[] | null; dryRun: boolean } {
	const args = Bun.argv.slice(2);
	const dryRun = args.includes('--dry-run');

	const filtered = args.filter((a) => a !== '--dry-run' && !a.startsWith('-'));
	if (filtered.length > 0) {
		const ids = filtered.map((a) => a as LocationId);
		for (const id of ids) {
			if (!LOCATIONS.find((l) => l.id === id)) {
				console.error(`Unknown location: ${id}`);
				process.exit(1);
			}
		}
		return { locationIds: ids, dryRun };
	}
	return { locationIds: null, dryRun };
}

async function prefetchLocation(
	tilesDir: string,
	locationId: LocationId,
	zooms: number[],
	radius: number,
	dryRun: boolean,
	onProgress: (msg: string) => void
): Promise<{ downloaded: number; failed: number; skipped: number }> {
	const location = LOCATIONS.find((l) => l.id === locationId)!;
	let totalDownloaded = 0;
	let totalFailed = 0;
	let totalSkipped = 0;

	for (const z of zooms) {
		const tiles = getTileBounds(location.lat, location.lon, radius, z);
		const source: SourceId = 'sentinel2';
		const sourceDir = join(tilesDir, source, locationId);

		let downloaded = 0;
		let failed = 0;
		let skipped = 0;

		for (const tile of tiles) {
			const tilePath = join(sourceDir, String(tile.z), String(tile.x), `${tile.y}.jpg`);

			if (existsSync(tilePath)) {
				skipped++;
				totalSkipped++;
				continue;
			}

			if (dryRun) {
				skipped++;
				totalSkipped++;
				continue;
			}

			const url = getTileUrl(source, tile);
			const data = await downloadTile(url);

			if (data) {
				await saveTile(sourceDir, tile, data);
				downloaded++;
				totalDownloaded++;
			} else {
				failed++;
				totalFailed++;
			}

			if ((downloaded + failed) % 50 === 0 || downloaded + failed === tiles.length) {
				const pct = Math.round(((downloaded + failed) / tiles.length) * 100);
				onProgress(`Downloading ${locationId} z${z}: ${pct}% (${downloaded + failed}/${tiles.length} tiles)`);
			}

			await Bun.sleep(DELAY_MS);
		}

		onProgress(`Completed ${locationId} z${z}: ${downloaded} downloaded, ${failed} failed, ${skipped} skipped`);
	}

	return { downloaded: totalDownloaded, failed: totalFailed, skipped: totalSkipped };
}

function countExistingTiles(tilesDir: string, locationId: LocationId, z: number): number {
	const sourceDir = join(tilesDir, 'sentinel2', locationId, String(z));
	let count = 0;

	if (existsSync(sourceDir)) {
		try {
			const xDirs = readdirSync(sourceDir);
			for (const x of xDirs) {
				const xPath = join(sourceDir, x);
				if (statSync(xPath).isDirectory()) {
					const tiles = readdirSync(xPath).filter((f: string) => f.endsWith('.jpg'));
					count += tiles.length;
				}
			}
		} catch {}
	}

	return count;
}

function generateManifest(tilesDir: string): Manifest {
	const manifest: Manifest = {
		generated: new Date().toISOString(),
		sources: ['sentinel2'],
		locations: {} as Manifest['locations'],
		totalTiles: 0,
	};

	for (const location of LOCATIONS) {
		const zoomLevels: Record<number, { tileCount: number; source: SourceId }> = {};
		let totalTiles = 0;

		for (const z of DEFAULT_ZOOMS) {
			const count = countExistingTiles(tilesDir, location.id, z);
			if (count > 0) {
				zoomLevels[z] = { tileCount: count, source: 'sentinel2' };
				totalTiles += count;
			}
		}

		(manifest.locations as any)[location.id] = { zoomLevels, totalTiles };
		manifest.totalTiles += totalTiles;
	}

	return manifest;
}

async function main() {
	const { locationIds, dryRun } = parseArgs();
	const targets = locationIds || LOCATIONS.map((l) => l.id);
	const zooms = DEFAULT_ZOOMS;
	const radius = DEFAULT_RADIUS;
	const tilesDir = join(process.cwd(), 'public', 'tiles');
	const manifestPath = join(tilesDir, 'manifest.json');

	if (dryRun) {
		console.log('=== DRY RUN ===\n');
	}

	let totalTiles = 0;

	for (const locationId of targets) {
		const location = LOCATIONS.find((l) => l.id === locationId)!;
		console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Location: ${location.name} (${locationId})`);
		console.log(`  Center: ${location.lat.toFixed(4)}, ${location.lon.toFixed(4)}`);
		console.log(`  Radius: ${radius} degrees`);

		let locTiles = 0;
		for (const z of zooms) {
			const bounds = getTileBounds(location.lat, location.lon, radius, z);
			console.log(`  z${z}: ${bounds.length} tiles`);
			locTiles += bounds.length;
		}
		console.log(`  Total: ${locTiles} tiles across ${zooms.length} zoom levels`);
		totalTiles += locTiles;
	}

	console.log(`\n${dryRun ? '[DRY RUN] ' : ''}TOTAL: ${totalTiles} tiles`);

	if (dryRun) {
		console.log('\nNo tiles were downloaded (dry-run mode).');
		return;
	}

	console.log('\n=== Starting Download ===\n');

	let totalDownloaded = 0;
	let totalFailed = 0;
	let totalSkipped = 0;

	for (const locationId of targets) {
		const result = await prefetchLocation(
			tilesDir,
			locationId,
			zooms,
			radius,
			false,
			(msg) => console.log(msg)
		);
		totalDownloaded += result.downloaded;
		totalFailed += result.failed;
		totalSkipped += result.skipped;
	}

	console.log('\n=== Download Complete ===');
	console.log(`Downloaded: ${totalDownloaded}`);
	console.log(`Failed: ${totalFailed}`);
	console.log(`Skipped (existing): ${totalSkipped}`);

	console.log('\nGenerating manifest...');
	const manifest = generateManifest(tilesDir);
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
	console.log(`Manifest saved to: ${relative(process.cwd(), manifestPath)}`);
	console.log(`Total tiles in manifest: ${manifest.totalTiles}`);
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
