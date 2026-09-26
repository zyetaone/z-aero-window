#!/usr/bin/env node
/**
 * Determinism check (architectural invariant #4).
 *
 * The 3-Pi wall reads as one window only when every pane derives the same
 * picture from the same inputs. `Math.random()` in shipped code gives each
 * Pi its own stream and breaks the seam — the blessed source is
 * `createSeededRng(daySeed())` from `world/prng.ts`.
 *
 * This scans `src/` + `content/` (shipped code; tests are out of scope)
 * for `Math.random` in code position (comment mentions don't count) and
 * fails on any file WITHOUT a documented waiver below. A waiver means the
 * randomness provably cannot desync the wall — not that it "looks fine".
 * New files with Math.random fail until they earn one.
 *
 * waiver format: path (relative to aero-1/) → why the wall can't desync.
 *
 * Run: node tools/check-determinism.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP = new URL('..', import.meta.url).pathname;

const WAIVERS = new Map([
	[
		'src/lib/director/autopilot.svelte.ts',
		'leader-only: every draw feeds a broadcast director_decision; followers apply, never draw.'
	],
	[
		'src/lib/director/scenarios.ts',
		'pickScenario callers inject rng (flight.svelte.ts); pickNextLocation draws funnel into broadcast manual/leader decisions.'
	],
	[
		'src/lib/utils.ts',
		'injectable `rng` defaults only; stocked callers inject seeded rng (RainGlass) or run leader-side (autopilot).'
	],
	[
		'src/lib/shell/audio/ambient-audio.ts',
		'white-noise PCM buffer: statistically identical per pane, no visual seam to break.'
	],
	[
		'src/lib/flight/motion.svelte.ts',
		'deliberate per-pane bump sign (visual noise, see comment at the call site); symmetric either way.'
	],
	[
		'src/lib/fleet/device-id.ts',
		'fresh display id MUST differ per Pi — randomness is the requirement, not the hazard.'
	],
	[
		'src/lib/fleet/rest-admin.svelte.ts',
		'admin session/command correlation ids: admin actions, not shared-scene paths (see in-file comment).'
	],
	[
		'content/compositions/lightning.ts',
		'injectable rng default; docstring requires seeded callers on the panorama (full-screen flash must agree).'
	]
]);

function walk(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (/\.(ts|svelte)$/.test(e)) out.push(p);
	}
	return out;
}

/** `Math.random` hits in code position (strips // tails, skips *-comment lines). */
function codeHits(src) {
	const hits = [];
	src.split('\n').forEach((line, i) => {
		const s = line.trim();
		if (s.startsWith('*') || s.startsWith('//')) return;
		const code = s.split('//')[0];
		if (code.includes('Math.random')) hits.push(i + 1);
	});
	return hits;
}

const violations = [];
for (const file of [...walk(join(APP, 'src')), ...walk(join(APP, 'content'))]) {
	const rel = file.slice(APP.length);
	const hits = codeHits(readFileSync(file, 'utf8'));
	if (hits.length === 0) continue;
	if (WAIVERS.has(rel)) continue;
	violations.push({ rel, hits });
}

if (violations.length > 0) {
	console.error('Math.random in shipped code without a determinism waiver:\n');
	for (const v of violations) {
		console.error(`  ${v.rel} (lines ${v.hits.join(', ')})`);
	}
	console.error('\nUse createSeededRng(daySeed()) from world/prng.ts, or document a waiver in this tool.');
	process.exit(1);
}

console.log('Determinism holds — no unwaived Math.random in shipped code.');
