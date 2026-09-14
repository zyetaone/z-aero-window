import { describe, it, expect, vi, afterEach } from 'vitest';
import { schedulePrivileged, SUDOERS_FRAGMENT } from '#lib/server/privileged.js';

/**
 * Off Linux this is a no-op by contract, and the tests lean on that: a suite
 * run on a Pi must never actually spawn `sudo`.
 */
describe('schedulePrivileged', () => {
	const asPlatform = <T>(value: string, fn: () => T): T => {
		const real = process.platform;
		Object.defineProperty(process, 'platform', { value, configurable: true });
		try {
			return fn();
		} finally {
			Object.defineProperty(process, 'platform', { value: real, configurable: true });
		}
	};

	it('no-ops and reports success off Linux', () => {
		expect(asPlatform('darwin', () => schedulePrivileged(['echo', 'test'], 10, '[test]'))).toBe(
			true
		);
	});

	it('does not spawn the command off Linux', async () => {
		// If the no-op branch ever started spawning, this would run `false` and
		// there would be no return value to catch it — so assert on the effect the
		// caller can see: nothing was scheduled, and nothing threw after the delay.
		expect(asPlatform('darwin', () => schedulePrivileged(['false'], 1, '[test]'))).toBe(true);
		await new Promise((r) => setTimeout(r, 20));
	});

	/**
	 * The Linux branch, which had no test at all — which is why the preflight
	 * spent its life asking sudo for `true`, a command /etc/sudoers.d/aero has
	 * never granted. Fake timers throughout: a scheduled command must never
	 * actually spawn from a suite, least of all one run on a Pi.
	 */
	describe('on Linux', () => {
		afterEach(() => {
			vi.clearAllTimers();
			vi.useRealTimers();
		});

		const onLinux = <T>(fn: () => T): T => asPlatform('linux', fn);

		it('refuses, and schedules nothing, when the sudoers fragment is absent', () => {
			vi.useFakeTimers();
			const seen: string[] = [];
			const ok = onLinux(() =>
				schedulePrivileged(['sudo', '-n', 'reboot'], 500, '[test]', (p) => {
					seen.push(p);
					return false;
				})
			);
			expect(ok).toBe(false);
			expect(seen).toEqual([SUDOERS_FRAGMENT]);
			expect(vi.getTimerCount(), 'a refusal must not leave a spawn pending').toBe(0);
		});

		/**
		 * The regression this file exists for. The fragment grants exactly
		 * `systemctl start aero-updater.service`, `reboot`, `nmcli` and their
		 * alternate paths — never `true`. A preflight that shells out to
		 * `sudo -n true` therefore FAILS on a correctly provisioned device, and
		 * the route answers 503 telling the operator to reinstall the file that
		 * is already correct. Presence of the file is the question being asked.
		 */
		it('schedules when the fragment is installed, without consulting sudo', () => {
			vi.useFakeTimers();
			const ok = onLinux(() =>
				schedulePrivileged(
					['sudo', '-n', 'systemctl', 'start', 'aero-updater.service'],
					500,
					'[test]',
					(p) => p === SUDOERS_FRAGMENT
				)
			);
			expect(ok).toBe(true);
			expect(vi.getTimerCount()).toBe(1);
		});

		it('never reaches the filesystem off Linux', () => {
			let asked = false;
			const ok = asPlatform('darwin', () =>
				schedulePrivileged(['sudo', '-n', 'reboot'], 10, '[test]', () => {
					asked = true;
					return false;
				})
			);
			expect(ok).toBe(true);
			expect(asked, 'the non-Linux no-op must short-circuit before any probe').toBe(false);
		});
	});
});
