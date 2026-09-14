/**
 * schedulePrivileged — fire-and-forget spawn of a command that needs sudo.
 *
 * Every caller hands the OS something that typically kills the very process
 * serving the request (an app restart, a network drop, a reboot), which is why
 * the spawn is delayed: the caller gets its 202 first, then the command runs.
 *
 * Semantics callers depend on:
 *   - Linux-only. Anywhere else it warns and no-ops, so dev hosts and tests
 *     exercise the route without the machine acting on it.
 *   - `detached` + `unref()`: the child must outlive this process, because the
 *     command may be what tears this process down.
 *   - `stdio: 'ignore'`: no TTY, so an interactive sudo prompt would hang
 *     forever — callers pass `sudo -n` to fail fast instead.
 *   - Returns false when the command was NOT scheduled, because
 *     /etc/sudoers.d/aero is not installed — which otherwise gave the operator
 *     a 202 and then silence: the worst failure mode on a headless fleet.
 *
 * It lives here rather than in `update.ts` because OTA is only its first
 * caller; anything else needing a privileged hatch imports this, not the
 * updater.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * The fragment `deploy/pi/install.sh` writes, and the thing this module is
 * really asking about. install.sh validates it with `visudo -cf` and SKIPS the
 * install when that fails, warning "privileged endpoints will 503" — so absence
 * is exactly the state that warning predicts.
 */
export const SUDOERS_FRAGMENT = '/etc/sudoers.d/aero';

/**
 * Fire-and-forget execution of a privileged command.
 *
 * Runs after a short delay so the HTTP response (202 Accepted) can be cleanly
 * transmitted before the process is terminated/restarted by the systemd service.
 *
 * @param argv Command and arguments array (e.g. `['sudo', '-n', 'systemctl', 'start', 'aero-updater.service']`)
 * @param delayMs Milliseconds to wait before spawning the detached process (default: 500ms)
 * @param label Logging prefix for diagnostics
 * @param exists Injected for tests, exactly as `wifiRecoveryAvailable` does it.
 * @returns boolean `true` if scheduled successfully or in non-Linux dev mode; `false` if the sudoers fragment is absent.
 */
export function schedulePrivileged(
	argv: string[],
	delayMs = 500,
	label = '[server/update]',
	exists: (p: string) => boolean = existsSync
): boolean {
	if (process.platform !== 'linux') {
		console.info(`${label} Non-Linux platform (${process.platform}) — simulated update trigger`);
		return true;
	}

	/**
	 * This used to run `spawnSync('sudo', ['-n', 'true'])`.
	 *
	 * `true` is not one of the commands /etc/sudoers.d/aero grants. That file
	 * lists exactly four: `systemctl start aero-updater.service`, `reboot`,
	 * `nmcli`, and their alternate paths. So the preflight asked for a
	 * permission the deployment deliberately withholds, and on a host without a
	 * blanket NOPASSWD rule it fails on a CORRECTLY provisioned Pi — turning
	 * every privileged route into a 503 whose message tells the operator to
	 * reinstall the file that is already right. Where it did pass, it passed
	 * because the stock `pi` user carries NOPASSWD: ALL, which means the scoped
	 * fragment was doing nothing and the check was measuring the blanket rule.
	 *
	 * Presence, not capability — the same trade `wifiRecoveryAvailable` makes
	 * one file over, for the same reason: it needs no spawn (this one ran
	 * synchronously in the request path, blocking the event loop for all three
	 * panes), and never-installed is the narrow failure this exists to catch.
	 * It cannot prove sudo will succeed; neither could `sudo -n true`.
	 */
	if (!exists(SUDOERS_FRAGMENT)) {
		console.warn(`${label} ${SUDOERS_FRAGMENT} is not installed. Command NOT scheduled.`);
		return false;
	}

	setTimeout(() => {
		try {
			const child = spawn(argv[0], argv.slice(1), {
				detached: true,
				stdio: 'ignore'
			});
			child.unref();
		} catch (err) {
			console.error(`${label} Failed to spawn privileged process:`, err);
		}
	}, delayMs);

	return true;
}
