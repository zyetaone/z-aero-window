#!/usr/bin/env bun
/**
 * process-clouds — pre-process cloud sprite webps.
 *
 * Two-track pipeline:
 *
 *   TRACK 1 (Bun.Image, zero-install, 1.3.14+):
 *     - `.modulate({ brightness })` to pre-dim each cloud webp.
 *     - Limitation: Bun.Image has no alpha-channel math, no blur.
 *
 *   TRACK 2 (Sharp, optional, `bun add -D sharp`):
 *     - True Gaussian blur via `.blur(sigma)` — generates soft variants
 *       (`cloud-soft.webp`, etc.) at multiple sigmas. The runtime can
 *       load whichever variant matches the desired softness without
 *       per-frame shader cost.
 *     - Real alpha-channel multiplication via raw buffer.
 *
 * Why this layered approach:
 *   - Bun.Image is fast + zero-install and covers the brightness case
 *     (~30% faster than Sharp per Bun blog).
 *   - Sharp adds the blur primitive that Bun.Image lacks today.
 *   - Either path is optional; both fail gracefully when not available.
 *
 * Runtime side:
 *   - `Clouds.svelte`'s baseOpacity multiplier handles alpha at runtime.
 *   - If `cloud-soft.webp` exists (Track 2 output), Clouds.svelte can
 *     optionally load it instead — toggle in the TEXTURE_URLS array.
 *
 * Usage:
 *   bun run process-clouds            # dim in place via Bun.Image
 *   bun run process-clouds --blur     # ALSO generate soft variants via Sharp
 *   bun run process-clouds --dry-run  # show what would change
 *
 * Requires (Track 1): Bun >= 1.3.14 for `Bun.Image`.
 * Optional (Track 2): `bun add -D sharp` for `--blur`.
 */

import { resolve, basename } from 'node:path';
import { existsSync } from 'node:fs';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const STATIC_DIR = resolve(PROJECT_ROOT, 'static');

// Inputs + per-texture brightness factors. Different cloud variants
// can be pre-dimmed to different levels — the dark + smoke variants
// stay closer to their original because they're already lower-key.
const CLOUDS = [
	{ file: 'cloud.webp',       brightness: 0.62 }, // soft white default — biggest dim
	{ file: 'cloud-dark.webp',  brightness: 0.78 }, // already dim, modest reduction
	{ file: 'cloud-smoke.webp', brightness: 0.85 }, // smoke stays near original
] as const;

const dryRun = process.argv.includes('--dry-run');
const wantsBlur = process.argv.includes('--blur');

// Blur sigmas per variant. Higher sigma = softer. Output filenames:
//   cloud.webp → cloud-soft.webp at sigma 1.6
// Multiple variants could be generated (sigma 1.0, 2.0, 3.0) for runtime
// LOD selection if we want, but one "soft" variant per source is enough
// for the current demand. Sharp's blur cost is ~5 ms per 256×256 webp.
const BLUR_SIGMA = 1.6;

// Check Bun.Image availability before doing anything.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BunImage = (Bun as any).Image as ((input: unknown) => {
	modulate: (opts: { brightness?: number; saturation?: number }) => unknown;
	webp: (opts: { quality?: number }) => { write: (path: string) => Promise<void> };
	metadata: () => Promise<{ width: number; height: number; format: string }>;
}) | undefined;

if (!BunImage) {
	console.error(
		`Bun.Image is not available in this runtime (Bun ${Bun.version}).\n` +
		`Bun.Image shipped in 1.3.14 — run \`bun upgrade\` and re-run.\n` +
		`Alternative: install sharp (\`bun add -D sharp\`) and use the\n` +
		`raw-buffer alpha-multiplication pattern (see Sharp docs).`,
	);
	process.exit(1);
}

async function dimCloud(file: string, brightness: number): Promise<void> {
	const path = resolve(STATIC_DIR, file);
	if (!existsSync(path)) {
		console.warn(`  ⚠️  ${file} not found at ${path} — skipping.`);
		return;
	}

	const input = Bun.file(path);
	const sizeBefore = input.size;

	if (dryRun) {
		console.log(`  ${file}: would dim brightness × ${brightness} (size ${sizeBefore} B)`);
		return;
	}

	// Round-trip: read → modulate(brightness) → webp encode → overwrite.
	// Saturation stays at 1.0 so the warm-tinted sunset versions still
	// pick up the SunGlow / Mie-scatter tint at runtime.
	const meta = await BunImage!(input).metadata();
	await BunImage!(input)
		.modulate({ brightness })
		.webp({ quality: 85 })
		.write(path);

	const sizeAfter = Bun.file(path).size;
	const pct = ((sizeAfter / sizeBefore - 1) * 100).toFixed(1);
	console.log(
		`  ✓  ${basename(file)}  ` +
		`${meta.width}×${meta.height}  ` +
		`brightness × ${brightness}  ` +
		`${sizeBefore} → ${sizeAfter} B (${pct}%)`,
	);
}

console.log(`process-clouds — ${dryRun ? 'DRY RUN' : 'writing'} into static/`);
for (const { file, brightness } of CLOUDS) {
	await dimCloud(file, brightness);
}

if (wantsBlur) {
	console.log(`process-clouds — generating soft-blur variants (sigma ${BLUR_SIGMA})`);
	// Dynamic import keeps Sharp optional — if not installed, the require
	// fails gracefully here without breaking the brightness pass above.
	let sharp: ((...args: unknown[]) => {
		blur: (sigma: number) => {
			webp: (opts: { quality?: number }) => { toFile: (path: string) => Promise<unknown> };
		};
	}) | undefined;
	try {
		sharp = (await import('sharp')).default as unknown as typeof sharp;
	} catch {
		console.error(
			`  ⚠️  sharp not installed. Run \`bun add -D sharp\` to enable\n` +
			`     real Gaussian blur preprocessing. Falling back to Bun.Image\n` +
			`     output only (no soft variants generated).`,
		);
	}

	if (sharp) {
		for (const { file } of CLOUDS) {
			const input = resolve(STATIC_DIR, file);
			if (!existsSync(input)) {
				console.warn(`  ⚠️  ${file} not found — skipping blur.`);
				continue;
			}
			const outFile = file.replace('.webp', '-soft.webp');
			const out = resolve(STATIC_DIR, outFile);
			if (dryRun) {
				console.log(`  ${file} → ${outFile}: would blur σ=${BLUR_SIGMA}`);
				continue;
			}
			await sharp(input).blur(BLUR_SIGMA).webp({ quality: 85 }).toFile(out);
			const sz = Bun.file(out).size;
			console.log(`  ✓  ${outFile}  σ=${BLUR_SIGMA}  ${sz} B`);
		}
	}
}

console.log('done.');
