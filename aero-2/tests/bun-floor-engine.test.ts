import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The updater's hardcoded `BUN_FLOOR` is a second copy of a fact whose
 * authority is the adapter it protects: @sveltejs/adapter-bun declares its own
 * minimum in `engines.bun` (">=1.4.0" today). When the adapter raises that
 * minimum, the updater keeps enforcing 1.4.0 — the guard goes silently
 * under-enforcing against exactly the failure class it was written for — and
 * no test reddens. This pins the copy to its source.
 *
 * Lives in aero-2, not beside the shell-function tests in aero-1/tests/tools,
 * because aero-2 is the app that depends on adapter-bun and whose node_modules
 * carries the authoritative `engines` field.
 */
const script = readFileSync(resolve(__dirname, '../../deploy/aero-updater.sh'), 'utf8');
const fn = script.match(/^bun_meets_floor\(\) \{[\s\S]*?^\}/m)?.[0];
const adapterManifest = resolve(__dirname, '../node_modules/@sveltejs/adapter-bun/package.json');

function meetsFloor(have: string, floor: string): boolean {
	if (!fn) throw new Error('bun_meets_floor() not found in aero-updater.sh');
	const out = execFileSync(
		'bash',
		['-c', `${fn}\nif bun_meets_floor '${have}' '${floor}'; then echo true; else echo false; fi`],
		{ encoding: 'utf8' }
	);
	return out.trim() === 'true';
}

describe('aero-updater BUN_FLOOR stays at the adapter floor', () => {
	const installed = existsSync(adapterManifest);

	it.skipIf(!installed)('floor is at or above adapter-bun\u2019s engines.bun minimum', () => {
		const floor = script.match(/BUN_FLOOR="([^"]+)"/)?.[1];
		if (!floor) throw new Error('BUN_FLOOR not found in aero-updater.sh');

		const engines = JSON.parse(readFileSync(adapterManifest, 'utf8')).engines;
		const min = (engines?.bun ?? '').match(/\d+\.\d+(?:\.\d+)?/)?.[0];
		if (!min) {
			throw new Error(`adapter-bun engines.bun '${engines?.bun}' has no parseable version`);
		}

		// floor >= min. bun_meets_floor is extracted from the SAME script, so
		// the comparison here is the updater's own, not a reimplementation
		// that could drift from it.
		expect(
			meetsFloor(floor, min),
			`BUN_FLOOR ${floor} must meet adapter-bun's minimum ${min}`
		).toBe(true);
	});
});
