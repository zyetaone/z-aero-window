import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The runtime floor guard in aero-updater.sh.
 *
 * @sveltejs/adapter-bun throws below Bun 1.4.0, and without a guard the
 * failure is invisible where it matters: the build fails, rollback() reverts
 * to the previous commit (which builds fine on adapter-node), the sha is
 * appended to bad-release on every rollback, and the two-strikes check bans it
 * after the second poll. The journal says "build failed" twice and then nothing
 * — while the cause is a stack trace about `Bun.serve` nobody reads.
 *
 * Two things are worth pinning, and neither is the version number itself:
 *
 * 1. The comparison. It is written with `sort -V`, so the test exists to stop
 *    someone "simplifying" it into a numeric sort that calls 1.10 older than
 *    1.9 — the classic way a floor check silently admits the wrong runtime.
 * 2. That it fails CLOSED. Measured while writing the guard: a failed
 *    `--version` echoing `unavailable` sorted BELOW `1.4.0`, so the naive
 *    implementation returned true for a runtime it could not measure at all.
 *    The bug was caught by reading the helper's own claim, not by running it,
 *    which is why it is a test case now.
 *
 * The second half of this file is structural rather than behavioural: it
 * asserts the guard is armed exactly for the app that needs it and that it
 * puts HEAD back. Both are properties of the script's text, and both are the
 * kind of thing that gets quietly deleted during an unrelated edit — the HEAD
 * restore in particular, whose absence turns "retried until Bun is upgraded"
 * into "consumed once, never retried", with nothing failing loudly either way.
 *
 * Extracted from the script and run in a bare shell, the same way
 * apply-boundary.test.ts covers apply_boundary — the updater cannot be
 * executed here (it wants systemd, git remotes and /etc/aero/config.env).
 */
const script = readFileSync(resolve(__dirname, '../../../deploy/aero-updater.sh'), 'utf8');
const fn = script.match(/^bun_meets_floor\(\) \{[\s\S]*?^\}/m)?.[0];

function meetsFloor(have: string, floor: string): boolean {
	if (!fn) throw new Error('bun_meets_floor() not found in aero-updater.sh');
	// The function signals with its EXIT STATUS, not with stdout — unlike
	// apply_boundary, which echoes arithmetic. `execFileSync` returns what was
	// printed, so reading it directly gives '' and every assertion silently
	// compares against the empty string. Convert here rather than making the
	// script echo, because the call site in the updater is `if ! bun_meets_floor`
	// and a function that also printed would be shaped around its test.
	// Quote both args: a `--version` failure and an empty string are inputs
	// worth testing, and unquoted they would vanish or split.
	const out = execFileSync(
		'bash',
		[
			'-c',
			`${fn}\nif bun_meets_floor '${have}' '${floor}'; then echo true; else echo false; fi`
		],
		{ encoding: 'utf8' }
	);
	return out.trim() === 'true';
}

/** The guard block, from its header to the next pipeline step. */
const guard = script.match(
	/# ─── 3b\. Runtime floor[\s\S]*?^snapshot_build/m
)?.[0];

describe('aero-updater bun_meets_floor', () => {
	it('accepts the runtime that meets the floor, including the exact boundary', () => {
		expect(meetsFloor('1.4.2', '1.4.0')).toBe(true);
		expect(meetsFloor('1.4.0', '1.4.0')).toBe(true);
		expect(meetsFloor('1.5.0', '1.4.0')).toBe(true);
		expect(meetsFloor('2.0.0', '1.4.0')).toBe(true);
	});

	it('rejects a runtime below the floor', () => {
		expect(meetsFloor('1.3.9', '1.4.0')).toBe(false);
		expect(meetsFloor('0.9.0', '1.4.0')).toBe(false);
		expect(meetsFloor('1.3', '1.4.0')).toBe(false);
	});

	it('compares versions positionally, not numerically on the whole string', () => {
		// The reason this is a function and not `[[ 1.10 > 1.9 ]]`: a plain
		// lexicographic compare calls 1.10 older than 1.9, which would block a
		// perfectly good runtime the moment the minor version hits two digits.
		expect(meetsFloor('1.10.0', '1.9.0')).toBe(true);
		expect(meetsFloor('1.10.0', '1.4.0')).toBe(true);
		expect(meetsFloor('1.9.0', '1.10.0')).toBe(false);
	});

	it('FAILS CLOSED on a version it cannot parse', () => {
		/**
		 * The bug this exists to prevent. `sort -V` orders `1.4.0` before
		 * `unavailable` because digits sort before letters, so the naive
		 * comparison measured a runtime it could not read as being ABOVE the
		 * floor — the guard would have passed an unmeasurable runtime straight
		 * through, which is the one case it absolutely has to catch (a
		 * `--version` that fails, or an error message on stdout).
		 */
		expect(meetsFloor('unavailable', '1.4.0')).toBe(false);
		expect(meetsFloor('', '1.4.0')).toBe(false);
		expect(meetsFloor('command not found', '1.4.0')).toBe(false);
	});

	it('accepts a prerelease suffix rather than blocking a newer canary', () => {
		expect(meetsFloor('1.4.2-canary.1', '1.4.0')).toBe(true);
		expect(meetsFloor('1.3.0-canary.1', '1.4.0')).toBe(false);
	});
});

describe('aero-updater runtime floor guard', () => {
	it('is present in the script', () => {
		expect(guard, 'the 3b runtime-floor block is missing').toBeDefined();
	});

	it('is armed by the app dependency, not by a hardcoded app name', () => {
		/**
		 * The point of keying on `@sveltejs/adapter-bun` rather than on
		 * "aero-2": one updater serves both apps and a device mid-migration,
		 * so the requirement follows the tree being built. And the shipped
		 * fleet must be untouched — asserting that aero-1 does NOT carry the
		 * dependency is how we know this guard is inert for it, rather than
		 * trusting that we remembered to scope it.
		 */
		expect(guard).toContain('"@sveltejs/adapter-bun"');
		const aero1 = readFileSync(resolve(__dirname, '../../package.json'), 'utf8');
		const aero2 = readFileSync(resolve(__dirname, '../../../aero-2/package.json'), 'utf8');
		expect(aero1).not.toContain('adapter-bun');
		expect(aero2).toContain('adapter-bun');
	});

	it('restores HEAD, so the release is retried rather than consumed', () => {
		/**
		 * `git reset --hard` has already moved HEAD to the incoming commit
		 * before this guard runs. Exiting in place leaves HEAD == REMOTE, so
		 * is_newer is false on every later poll and the log says "nothing to
		 * apply" forever — the device would never build that release even
		 * after Bun was upgraded. Without this assertion the line is one
		 * refactor away from being dropped, and nothing would fail.
		 */
		expect(guard).toContain('git reset --hard "${LOCAL}"');
	});

	it('skips rather than rolling back or poisoning the release', () => {
		// Match the CALL, not the word: this block's own comment explains the
		// rollback path it is avoiding, so `not.toContain('rollback')` failed
		// against my own prose. The invocation form is what would actually
		// append the sha and ban a good release for a fault it cannot cause.
		expect(guard).toContain('exit 0');
		expect(guard).not.toContain('|| rollback');
		expect(guard).not.toContain('BAD_RELEASE_FILE');
	});
});
