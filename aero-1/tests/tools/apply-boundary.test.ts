import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The updater's apply boundary is what makes a release land on all three
 * panes within seconds of each other. It is a pure bash function; this
 * extracts it from the script and runs it, so the arithmetic is pinned
 * without executing the updater.
 */
const script = readFileSync(resolve(__dirname, '../../../deploy/aero-updater.sh'), 'utf8');
const fn = script.match(/^apply_boundary\(\) \{[\s\S]*?^\}/m)?.[0];

function boundary(commitTs: number, lead?: number): number {
	if (!fn) throw new Error('apply_boundary() not found in aero-updater.sh');
	const args = lead === undefined ? `${commitTs}` : `${commitTs} ${lead}`;
	const out = execFileSync('bash', ['-c', `${fn}\napply_boundary ${args}`], { encoding: 'utf8' });
	return Number(out.trim());
}

describe('aero-updater apply_boundary', () => {
	it('is the first quarter-hour at or after commit time + lead', () => {
		// 12:00:00 commit, 20 min lead → 12:20 → rounds up to 12:30.
		const noon = 1_800_000_000 - (1_800_000_000 % 86400) + 12 * 3600;
		expect(boundary(noon)).toBe(noon + 30 * 60);
	});
	it('does not round an exact boundary upward', () => {
		const t = 900 * 1000;
		expect(boundary(t, 900)).toBe(t + 900);
	});
	it('is identical for every pane regardless of when it polled', () => {
		const commit = 1_700_000_123;
		const a = boundary(commit);
		// Polling time is not an input at all — same commit, same answer.
		expect(boundary(commit)).toBe(a);
		expect(a % 900).toBe(0);
		expect(a).toBeGreaterThanOrEqual(commit + 1200);
		expect(a - (commit + 1200)).toBeLessThan(900);
	});
	it('honours a custom lead', () => {
		expect(boundary(0, 0)).toBe(0);
		expect(boundary(1, 0)).toBe(900);
	});
});
