/**
 * schedulePrivileged — fire-and-forget spawn of a privileged (sudo) command.
 *
 * Shared by /api/update and /api/wifi/reset, which both hand a dangerous
 * command to the OS a beat AFTER responding to the caller. The delay exists
 * because the command typically kills the very process serving the request
 * (aero-app restart, network drop + reboot) — the caller gets its 200/202
 * first, then the command runs.
 *
 * Semantics both routes relied on, preserved here:
 *   - Linux-only: on any other platform it's a warn-and-no-op (dev hosts,
 *     tests) with a route-specific label so the log line identifies which
 *     endpoint declined to act.
 *   - `detached: true` + `unref()`: the child must not be tied to this
 *     process's lifetime — the command may be what tears this process down.
 *   - `stdio: 'ignore'`: no TTY, so an interactive sudo password prompt would
 *     hang forever; callers pass `sudo -n` to fail fast instead.
 *
 * Returns false when the command was NOT scheduled: on Linux, a `sudo -n true`
 * preflight verifies the box can sudo non-interactively at all (the deploy
 * ships /etc/sudoers.d/aero for exactly these hatches, and that fragment
 * grants `true` itself — without that line the preflight only passed on
 * images that happened to carry a blanket NOPASSWD rule). Previously a missing
 * sudoers entry meant the operator got a 200/202 and then nothing happened —
 * the worst kind of silent failure on a headless fleet. Non-Linux stays a
 * warn-and-returns-true no-op so dev hosts and tests keep the old contract.
 */

import { spawn, spawnSync } from 'node:child_process';

export function schedulePrivileged(argv: string[], delayMs: number, label: string): boolean {
	if (process.platform !== 'linux') {
		console.warn(`${label} non-linux platform — no-op`);
		return true;
	}
	const preflight = spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' });
	if (preflight.status !== 0) {
		console.warn(`${label} sudo -n preflight failed — is /etc/sudoers.d/aero installed? Command NOT scheduled.`);
		return false;
	}
	setTimeout(() => {
		const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: 'ignore' });
		child.unref();
	}, delayMs);
	return true;
}
