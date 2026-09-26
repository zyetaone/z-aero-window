#!/usr/bin/env bun

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, relative, dirname } from 'path';
import { execSync } from 'child_process';

const PUBLIC_TILES = join(process.cwd(), 'public', 'tiles');
const OUTPUT_DIR = join(process.cwd(), 'public', 'pmtiles');

interface ManifestEntry {
  source: string;
  locationId: string;
  pmtilesPath: string;
  zoomLevels: number[];
  tileCount: number;
  bytes: number;
}

interface Manifest {
  generated: string;
  pmtiles: ManifestEntry[];
}

function countTiles(tileDir: string): number {
  if (!existsSync(tileDir)) return 0;
  let total = 0;
  try {
    const xDirs = readdirSync(tileDir);
    for (const x of xDirs) {
      const xPath = join(tileDir, x);
      if (statSync(xPath).isDirectory()) {
        total += readdirSync(xPath).filter(f => f.endsWith('.jpg')).length;
      }
    }
  } catch {}
  return total;
}

function runCmd(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e: unknown) {
    const err = e as { message?: string; stderr?: string };
    throw new Error(err.stderr || err.message || String(e));
  }
}

async function main() {
  console.log('=== PMTiles Builder ===\n');

  if (!existsSync(PUBLIC_TILES)) {
    console.error('No tiles found. Run `bun scripts/prefetch-tiles.ts` first.');
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  const sources = ['sentinel2'];
  const entries: ManifestEntry[] = [];
  const force = process.argv.includes('--force');

  try {
    runCmd('pmtiles-convert --version');
  } catch {
    console.error('pmtiles-convert not found on PATH.\nInstall: cargo install pmtiles-convert (or npm i -g pmtiles)');
    process.exit(1);
  }

  for (const source of sources) {
    const sourceDir = join(PUBLIC_TILES, source);
    if (!existsSync(sourceDir)) continue;

    const locations = readdirSync(sourceDir).filter(s => {
      try {
        return statSync(join(sourceDir, s)).isDirectory();
      } catch {
        return false;
      }
    });

    for (const locationId of locations) {
      const locationDir = join(sourceDir, locationId);
      if (!existsSync(locationDir)) continue;

      const zoomLevels: number[] = [];
      let totalTileCount = 0;

      for (const z of readdirSync(locationDir)) {
        const zPath = join(locationDir, z);
        if (!statSync(zPath).isDirectory()) continue;
        const count = countTiles(zPath);
        if (count > 0) {
          zoomLevels.push(parseInt(z));
          totalTileCount += count;
        }
      }

      if (zoomLevels.length === 0) continue;

      const pmtLabel = `${source}_${locationId}`;
      const pmtPath = join(OUTPUT_DIR, `${pmtLabel}.pmtiles`);

      console.log(`\n[${source}] ${locationId}`);
      console.log(`  Zoom levels: ${zoomLevels.join(', ')}`);
      console.log(`  Total tiles: ${totalTileCount}`);

      if (existsSync(pmtPath) && !force) {
        console.log(`  Skipping — PMTiles already exists (use --force to rebuild)`);
      } else {
        const maxZoom = Math.max(...zoomLevels);
        const minZoom = Math.min(...zoomLevels);
        console.log(`  Converting to PMTiles (z${minZoom}-z${maxZoom})...`);

        try {
          const cmd = [
            'pmtiles-convert',
            `"${locationDir}"`,
            `"${pmtPath}"`,
            `--scheme zxy`,
            `--format jpeg`,
            `--maxzoom ${maxZoom}`,
            `--verbose`,
          ].join(' ');

          const output = runCmd(cmd);
          if (output.trim()) console.log(output);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`  pmtiles-convert failed: ${msg}`);
          continue;
        }
      }

      if (!existsSync(pmtPath)) {
        console.error(`  PMTiles file not created!`);
        continue;
      }

      const bytes = statSync(pmtPath).size;
      const sizeMB = (bytes / 1024 / 1024).toFixed(2);
      console.log(`  Done: ${sizeMB} MB → ${pmtLabel}.pmtiles`);

      entries.push({
        source,
        locationId,
        pmtilesPath: relative(process.cwd(), pmtPath),
        zoomLevels,
        tileCount: totalTileCount,
        bytes,
      });
    }
  }

  const manifest: Manifest = {
    generated: new Date().toISOString(),
    pmtiles: entries,
  };

  const manifestPath = join(OUTPUT_DIR, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log('\n=== Manifest ===');
  console.log(JSON.stringify(manifest, null, 2));
  console.log(`\nManifest: ${relative(process.cwd(), manifestPath)}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
