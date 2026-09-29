// @vitest-environment node

/**
 * Memory-pressure guard tests — install the real listener, emit the real
 * process event, assert log + release + (un)install semantics.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	installMemoryPressureGuard,
	type MemoryPressureLevel,
} from '$lib/server/memory-pressure';

type Release = (level: MemoryPressureLevel) => void;

let uninstall: (() => void) | undefined;
let release: Release;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	release = vi.fn();
	warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	uninstall?.();
	uninstall = undefined;
	vi.restoreAllMocks();
});

function emitPressure(level: MemoryPressureLevel): void {
	process.emit('memoryPressure', level);
}

describe('installMemoryPressureGuard', () => {
	it('logs the level and memory snapshot on critical', () => {
		uninstall = installMemoryPressureGuard({ release });
		emitPressure('critical');
		expect(release).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledWith('critical');
		expect(warn).toHaveBeenCalledTimes(1);
		const line = warn.mock.calls[0][0] as string;
		expect(line).toContain('[memory-pressure] level=critical');
		expect(line).toMatch(/rss=\d+MB/);
		expect(line).toMatch(/heapUsed=\d+MB/);
	});

	it('handles warning level too (macOS fires both)', () => {
		uninstall = installMemoryPressureGuard({ release });
		emitPressure('warning');
		expect(release).toHaveBeenCalledWith('warning');
		expect(warn.mock.calls[0][0]).toContain('level=warning');
	});

	it('uninstall stops the listener', () => {
		uninstall = installMemoryPressureGuard({ release });
		uninstall();
		uninstall = undefined;
		emitPressure('critical');
		expect(release).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it('reinstalling replaces the previous listener (no stacked calls)', () => {
		const first: Release = vi.fn();
		uninstall = installMemoryPressureGuard({ release: first });
		const second: Release = vi.fn();
		uninstall = installMemoryPressureGuard({ release: second });
		emitPressure('critical');
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('a throwing release does not suppress the log line', () => {
		const failing: Release = vi.fn(() => {
			throw new Error('boom');
		});
		uninstall = installMemoryPressureGuard({ release: failing });
		emitPressure('critical');
		// Two warnings: the pressure line (always) + the release failure.
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[0][0]).toContain('[memory-pressure] level=critical');
		expect(warn.mock.calls[1][0]).toContain('release failed');
	});
});
