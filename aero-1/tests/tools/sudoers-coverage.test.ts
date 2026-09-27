import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every privileged command the server runs must be granted by the sudoers
 * fragment install.sh ships — including the `sudo -n true` preflight, which
 * once passed only because stock Pi OS carries a blanket NOPASSWD file.
 */
const root = resolve(__dirname, '../../..');
const sudoers = readFileSync(resolve(root, 'deploy/pi/aero.sudoers'), 'utf8');
const grants = sudoers
	.split('\n')
	.filter((l) => l.includes('NOPASSWD:'))
	.flatMap((l) => l.split('NOPASSWD:')[1].split(',').map((c) => c.trim()));

const granted = (cmd: string) => grants.some((g) => g.replace(/^\/(usr\/)?s?bin\//, '') === cmd || g.endsWith('/' + cmd));

describe('deploy/pi/aero.sudoers covers what the server sudoes', () => {
	it('grants the preflight', () => {
		expect(granted('true')).toBe(true);
	});
	it('grants the updater trigger and reboot', () => {
		expect(granted('systemctl start aero-updater.service')).toBe(true);
		expect(granted('reboot')).toBe(true);
	});
	it('grants only the nmcli subcommand the Wi-Fi reset runs', () => {
		const reset = readFileSync(resolve(root, 'aero-1/src/routes/api/wifi/reset/+server.ts'), 'utf8');
		const uses = [...reset.matchAll(/sudo -n nmcli ([a-z]+ [a-z]+)/g)].map((m) => m[1]);
		expect(uses.length).toBeGreaterThan(0);
		for (const u of uses) expect(granted(`nmcli ${u} *`)).toBe(true);
		expect(granted('nmcli')).toBe(false);
	});
});
