#!/usr/bin/env bun
/**
 * Aero Window — Offline Tile Packager
 *
 * Pre-downloads tiles for every location in src/lib/locations.ts so the Pi
 * can serve them via /api/tiles/[...path] without internet access.
 *
 * Usage:
 *   bun run start                          # download all sources, all locations
 *   bun run start -- --estimate            # dry-run: show storage estimate only
 *   bun run start -- --output ./data/tiles # custom output dir
 *   bun run start -- --locations dubai,himalayas  # subset
 *   bun run start -- --sources viirs-night-lights  # subset
 */

import { mkdir, writeFile, copyFile, stat } from 'node:fs/promises';
import sharp from 'sharp';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { LOCATIONS } from '../../../content/locations';
import type { LocationId } from '../../../content/locations';
import { enumerateTiles, estimateBytes, formatBytes, type TileSource } from './rules';
import { SOURCES, tileFilePath, BUILDINGS_CONFIG, overpassToGeoJson } from './sources';
import { ROADS_CONFIG, radiusGroups, fetchRoadGroupFeatures, OVERPASS_HEADERS } from './roads';
import { STATIC_ASSETS, type AssetCategory } from './assets';

// ─── CLI ────────────────────────────────────────────────────────────────────

interface Args {
	output: string;
	estimate: boolean;
	locations: LocationId[] | 'all';
	sources: TileSource[] | 'all';
	concurrency: number;
	skipBuildings: boolean;
	skipRoads: boolean;
	skipAssets: boolean;
	roadsOnly: boolean;
	forceRoads: boolean;
}

function parseArgs(): Args {
	const a = process.argv.slice(2);
	const out: Args = {
		output: './data/tiles',
		estimate: false,
		locations: 'all',
		sources: 'all',
		concurrency: 6,
		skipBuildings: false,
		skipRoads: false,
		skipAssets: false,
		roadsOnly: false,
		forceRoads: false,
	};
	for (let i = 0; i < a.length; i++) {
		switch (a[i]) {
			case '--output':        out.output = a[++i]; break;
			case '--estimate':      out.estimate = true; break;
			case '--locations':     out.locations = a[++i].split(',') as LocationId[]; break;
			case '--sources':       out.sources = a[++i].split(',') as TileSource[]; break;
			case '--concurrency':   out.concurrency = Number(a[++i]) || 6; break;
			case '--skip-buildings': out.skipBuildings = true; break;
			case '--skip-roads':    out.skipRoads = true; break;
			case '--skip-assets':   out.skipAssets = true; break;
			case '--roads-only':    out.roadsOnly = true; break;
			case '--force-roads':   out.forceRoads = true; break;
			case '-h':
			case '--help':
				console.log(`Usage:
  bun run start                                  Download all tile sources + OSM buildings + static assets
  bun run start -- --estimate                    Dry-run: storage estimate only
  bun run start -- --output ./data/tiles         Custom output directory
  bun run start -- --locations dubai,himalayas   Subset of locations
  bun run start -- --sources viirs-night-lights  Subset of tile sources (default: all)
  bun run start -- --concurrency 6               Parallel downloads (default 6)
  bun run start -- --skip-buildings              Don't run Overpass buildings pass
  bun run start -- --skip-roads                  Don't run Overpass roads pass
  bun run start -- --skip-assets                 Don't copy static assets
  bun run start -- --roads-only                  Overpass roads pass only (no tiles)
  bun run start -- --force-roads                 Re-fetch roads even if on disk

Tile sources:
  viirs-night-lights  NASA VIIRS night lights (public domain)

Not here on purpose (open data, built offline, no token):
  sentinel2/        day imagery — aero-2/tools builds it from Copernicus COGs
  cesium-terrain/   quantized mesh — tools/build-terrain.py from AWS elevation

Static assets (copied from repo static/, no network):
  water-normals.jpg, cloud sprites, sky backdrops, weather map, optional
  SWA brand LUT. See src/assets.ts for the full manifest.
`);
				process.exit(0);
		}
	}
	return out;
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
	const args = parseArgs();
	if (args.roadsOnly) {
		args.skipBuildings = true;
		args.skipAssets = true;
	}
	const locations = args.locations === 'all'
		? LOCATIONS
		: LOCATIONS.filter((l) => (args.locations as LocationId[]).includes(l.id));
	const roadLocations = locations.filter((l) => l.hasBuildings);

	const sources = args.sources === 'all'
		? Object.values(SOURCES)
		: Object.values(SOURCES).filter((s) => (args.sources as TileSource[]).includes(s.source));

	console.log(`📍 Locations:  ${locations.length} (${locations.map((l) => l.id).join(', ')})`);
	if (!args.roadsOnly) {
		console.log(`🗺  Sources:    ${sources.length} (${sources.map((s) => s.source).join(', ')})`);
		console.log(`📂 Output:     ${args.output}`);
		console.log();
	}

	if (!args.roadsOnly) {
	// Plan: enumerate all (source, location, tile) triples upfront for accurate total.
	// Each job carries its source config so the worker knows whether to attach
	// auth headers (e.g. Cesium Ion Bearer token) at fetch time.
	type Job = { url: string; path: string; bytes: number; sourceKey: TileSource; postProcess?: boolean; boostBrightness?: number; boostContrast?: number };
	const allJobs: Job[] = [];
	for (const loc of locations) {
		for (const cfg of sources) {
			const tiles = enumerateTiles(loc.lat, loc.lon, 0.5, cfg.zoomRange[0], cfg.zoomRange[1]);
			for (const t of tiles) {
				allJobs.push({
					url: cfg.urlForTile(t),
					path: join(args.output, tileFilePath(cfg, t)),
					bytes: estimateBytes(1, cfg.source),
					sourceKey: cfg.source,
					postProcess: cfg.postProcess,
					boostBrightness: cfg.boostBrightness,
					boostContrast: cfg.boostContrast,
				});
			}
		}
	}

	const totalEstimate = allJobs.reduce((sum, j) => sum + j.bytes, 0);
	console.log(`📊 ${allJobs.length} tiles ≈ ${formatBytes(totalEstimate)} estimated`);

	if (args.estimate) {
		console.log('(--estimate set, exiting before download)');
		return;
	}

	// Pre-resolve auth headers for any source that needs them (e.g. Ion).
	// Done once upfront so workers don't all race to fetch the same token.
	const headersBySource: Partial<Record<TileSource, Record<string, string>>> = {};
	for (const cfg of sources) {
		if (cfg.prepareHeaders) {
			try {
				headersBySource[cfg.source] = await cfg.prepareHeaders();
				console.log(`🔐 Auth ready: ${cfg.source}`);
			} catch (e) {
				console.warn(`⚠️  Skipping ${cfg.source}: ${(e as Error).message}`);
				// Mark as unusable — worker will skip jobs for this source.
				headersBySource[cfg.source] = null as unknown as Record<string, string>;
			}
		}
	}

	console.log(`⬇️  Downloading with concurrency ${args.concurrency}...\n`);

	// Skip already-downloaded tiles + parallel-fetch the rest.
	let done = 0;
	let downloaded = 0;
	let skipped = 0;
	let failed = 0;
	const startMs = Date.now();

	const queue = allJobs.slice();
	const workers = Array.from({ length: args.concurrency }, async () => {
		while (queue.length) {
			const job = queue.shift();
			if (!job) break;
			done++;
			if (existsSync(job.path)) {
				skipped++;
				continue;
			}
			// Skip sources whose auth handshake failed (e.g. missing Ion token).
			const headers = headersBySource[job.sourceKey];
			if (headersBySource.hasOwnProperty(job.sourceKey) && headers === null) {
				failed++;
				continue;
			}
			try {
				await mkdir(dirname(job.path), { recursive: true });
				const res = await fetch(job.url, headers ? { headers } : undefined);
				const buf = new Uint8Array(await res.arrayBuffer());
				if (job.postProcess && buf.length > 100) {
					// Boost dim VIIRS tiles: brightness × boostBrightness, contrast × boostContrast.
					// Skip tiny responses (error pages, empty tiles).
					const boosted = await sharp(buf)
						.modulate({ brightness: job.boostBrightness ?? 5, saturation: 0 })
						.linear(job.boostContrast ?? 1.5, -(job.boostContrast! - 1) * 0.5)
						.jpeg({ quality: 85 })
						.toBuffer();
					await Bun.write(job.path, boosted);
				} else {
					await Bun.write(job.path, buf);
				}
				downloaded++;
			} catch {
				failed++;
			}
			if (done % 50 === 0) {
				const pct = ((done / allJobs.length) * 100).toFixed(1);
				const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
				process.stdout.write(`\r  ${done}/${allJobs.length} (${pct}%) — downloaded ${downloaded} skipped ${skipped} failed ${failed} — ${elapsed}s   `);
			}
		}
	});
	await Promise.all(workers);

	console.log('\n');
	console.log(`✅ Tile phase: ${downloaded} downloaded, ${skipped} skipped (cached), ${failed} failed`);
	console.log(`⏱  ${((Date.now() - startMs) / 1000).toFixed(1)}s for tiles`);
	}

	// ─── OSM Buildings pass ─────────────────────────────────────────────────
	// Per-location Overpass query → slim extrusion GeoJSON. Serial so we don't
	// overwhelm the public Overpass mirrors. Skipped if --skip-buildings.
	if (!args.skipBuildings) {
		console.log();
		console.log(`🏙  Buildings (Overpass → GeoJSON) for ${locations.length} location(s)...`);
		const buildingsStart = Date.now();
		let built = 0;
		let bSkipped = 0;
		let bFailed = 0;
		for (const loc of locations) {
			const outPath = join(args.output, BUILDINGS_CONFIG.storagePath(loc.id));
			if (existsSync(outPath)) {
				bSkipped++;
				continue;
			}
			const query = BUILDINGS_CONFIG.buildOverpassQuery(
				loc.lat,
				loc.lon,
				BUILDINGS_CONFIG.defaultRadiusMeters,
			);
			let success = false;
			for (const endpoint of BUILDINGS_CONFIG.endpoints) {
				try {
					const res = await fetch(endpoint, {
						method: 'POST',
						// Same User-Agent requirement as the roads pass — see
						// OVERPASS_HEADERS. This pass had the same latent 406.
						headers: OVERPASS_HEADERS,
						body: `data=${encodeURIComponent(query)}`,
					});
					if (!res.ok) continue;
					const json = (await res.json()) as Parameters<typeof overpassToGeoJson>[0];
					const geojson = overpassToGeoJson(json);
					await mkdir(dirname(outPath), { recursive: true });
					await writeFile(outPath, JSON.stringify(geojson));
					console.log(`  ✓ ${loc.id}: ${geojson.features.length} buildings`);
					built++;
					success = true;
					break;
				} catch {
					// try next endpoint
				}
			}
			if (!success) {
				console.log(`  ✗ ${loc.id}: all Overpass endpoints failed`);
				bFailed++;
			}
			// Be polite to the public Overpass mirrors.
			await new Promise((r) => setTimeout(r, 500));
		}
		console.log(`✅ Buildings: ${built} built, ${bSkipped} skipped, ${bFailed} failed`);
		console.log(`⏱  ${((Date.now() - buildingsStart) / 1000).toFixed(1)}s for buildings`);
	}

	// ─── OSM Roads pass ─────────────────────────────────────────────────────
	// Per-location Overpass queries → slim LineString GeoJSON for the night
	// street grid (world/roads-geojson). One query PER RADIUS GROUP, not per
	// class: arterials are pulled from a wide ring and side streets from a
	// narrow one, because a uniform radius either postage-stamps the frame or
	// pays quadratically for residential geometry that altitudeDetailMix fades
	// to nothing at cruise. See roads.ts for the full argument.
	//
	// Serial, and politely spaced — these are public Overpass mirrors and the
	// 40 km arterial query is a genuinely large ask.
	if (!args.skipRoads) {
		console.log();
		console.log(`🛣  Roads (Overpass → GeoJSON) for ${roadLocations.length} city location(s)...`);
		const roadsStart = Date.now();
		let rBuilt = 0;
		let rSkipped = 0;
		let rFailed = 0;
		const groups = radiusGroups();
		for (const loc of roadLocations) {
			const outPath = join(args.output, ROADS_CONFIG.storagePath(loc.id));
			if (existsSync(outPath) && !args.forceRoads) {
				rSkipped++;
				continue;
			}
			// Shared across groups so an arterial caught by the wide query is not
			// emitted again by the narrow one — overlapping rings would duplicate
			// exactly the geometry that draws brightest.
			const seen = new Set<number>();
			const features: import('./roads').RoadFeature[] = [];
			let failed = false;
			for (const group of groups) {
				const batch = await fetchRoadGroupFeatures(
					loc.lat, loc.lon, group.radius, group.classes, seen,
				);
				if (!batch) { failed = true; break; }
				features.push(...batch);
				await new Promise((r) => setTimeout(r, 1_000));
			}
			if (failed || features.length === 0) {
				// Partial output would be worse than none: the city would render a
				// half-grid that looks like a bug rather than a missing extract.
				console.log(`  ✗ ${loc.id}: Overpass failed or returned nothing`);
				rFailed++;
				continue;
			}
			await mkdir(dirname(outPath), { recursive: true });
			await writeFile(outPath, JSON.stringify({ type: 'FeatureCollection', features }));
			console.log(`  ✓ ${loc.id}: ${features.length} roads`);
			rBuilt++;
		}
		console.log(`✅ Roads: ${rBuilt} built, ${rSkipped} skipped, ${rFailed} failed`);
		console.log(`⏱  ${((Date.now() - roadsStart) / 1000).toFixed(1)}s for roads`);
	}

	// ─── Static assets pass ─────────────────────────────────────────────────
	// Copy non-tile resources the Pi needs at runtime: cloud sprites, water
	// normal map, sky backdrops, optional LUTs. Resolved relative to the
	// repo root (three levels up from tools/tile-packager/src/). Missing
	// optional files are skipped with a warning; missing required files
	// fail the packager so the Pi bundle isn't silently incomplete.
	if (!args.skipAssets) {
		console.log();
		console.log(`🖼  Static assets (repo static/ → output/static/)...`);
		const assetsStart = Date.now();
		// Walk up from tools/tile-packager/src/index.ts → repo root.
		const repoRoot = resolve(import.meta.dir, '../../..');
		const perCategory = new Map<AssetCategory, { copied: number; skipped: number; bytes: number }>();
		let assetsCopied = 0;
		let assetsSkipped = 0;
		let assetsFailed = 0;
		let assetsBytes = 0;

		for (const asset of STATIC_ASSETS) {
			const src = resolve(repoRoot, asset.source);
			const dst = join(args.output, asset.dest);
			if (!existsSync(src)) {
				if (asset.optional) {
					assetsSkipped++;
					continue;
				}
				console.warn(`  ⚠️  missing required asset: ${asset.source}`);
				assetsFailed++;
				continue;
			}
			try {
				await mkdir(dirname(dst), { recursive: true });
				await copyFile(src, dst);
				const { size } = await stat(dst);
				assetsBytes += size;
				assetsCopied++;
				const bucket = perCategory.get(asset.category) ?? { copied: 0, skipped: 0, bytes: 0 };
				bucket.copied++;
				bucket.bytes += size;
				perCategory.set(asset.category, bucket);
			} catch (e) {
				console.warn(`  ✗ failed ${asset.source}: ${(e as Error).message}`);
				assetsFailed++;
			}
		}
		console.log(`✅ Assets: ${assetsCopied} copied, ${assetsSkipped} skipped (optional/missing), ${assetsFailed} failed`);
		for (const [cat, stats] of perCategory) {
			console.log(`   ${cat.padEnd(7)} ${stats.copied.toString().padStart(3)} file(s)  ${formatBytes(stats.bytes)}`);
		}
		console.log(`   total        ${formatBytes(assetsBytes)}`);
		console.log(`⏱  ${((Date.now() - assetsStart) / 1000).toFixed(1)}s for assets`);
	}

	console.log();
	console.log(`Next: set TILE_DIR=${args.output} on the Pi and add to .env:`);
	console.log(`  VITE_TILE_SERVER_URL=http://localhost:5173/api/tiles`);
	console.log('Then rebuild + restart aero-app. Cesium will fetch from local disk.');
}

main().catch((e) => {
	console.error('FATAL:', e);
	process.exit(1);
});
