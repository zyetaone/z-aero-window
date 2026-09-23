/**
 * The single writer.
 *
 * One process owns `data/wall.json`. A client never proposes a `version` or an
 * `applyAtWallSec` — it sends a `WallState` and this decides when it lands.
 * That is the whole of ADR-007's positive half: no merge, no vector clock, no
 * bus. Two racing pushes serialize and the later one wins, which ADR-007
 * accepts explicitly.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { parseWallState, type WallSnapshot, type WallState } from '#lib/wall.js';

/**
 * How far ahead a push is scheduled.
 *
 * Long enough that every pane has polled and buffered the snapshot before the
 * second it names — a ~2 s poll plus fetch on a loaded Pi. Short enough that an
 * operator turning a knob does not think it broke. This is the number that
 * makes network jitter stop being an input to the pose: panes that received the
 * same snapshot 1.5 s apart still apply it at the same wall second.
 */
export const LEAD_SEC = 5;

const DEFAULT_WALL_PATH = 'data/wall.json';

const EMPTY: WallState = {
	placeId: '',
	presetId: '',
	weather: 'clear',
	clockOffsetH: 0,
	displayMode: 'flight',
	blindOpen: true,
	rotate: true,
	mediaUrls: [],
	audioUrls: []
};

/**
 * Version 0 means "nothing has ever been pushed", and panes treat it as
 * nothing to apply — a fresh wall runs on its own URL parameters, which is what
 * it did before any of this existed.
 */
export function readWall(path = DEFAULT_WALL_PATH): WallSnapshot {
	if (!existsSync(path)) return { version: 0, applyAtWallSec: 0, state: EMPTY };

	try {
		const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
		const state = parseWallState(raw.state);
		const version = typeof raw.version === 'number' && raw.version >= 0 ? raw.version : 0;
		const applyAtWallSec = typeof raw.applyAtWallSec === 'number' ? raw.applyAtWallSec : 0;
		if (!state || version === 0) return { version: 0, applyAtWallSec: 0, state: EMPTY };
		return { version, applyAtWallSec, state };
	} catch {
		// A corrupt file must not wedge the wall. Falling back to "never pushed"
		// leaves every pane on its own URL parameters, which is a working display.
		return { version: 0, applyAtWallSec: 0, state: EMPTY };
	}
}

/**
 * Write the next version. Temp-then-rename, because a pane may be reading this
 * file at any moment and a half-written JSON is the one thing `readWall`'s catch
 * cannot distinguish from a genuinely corrupt one.
 */
export function pushWall(
	state: WallState,
	nowSec: number = Date.now() / 1000,
	path = DEFAULT_WALL_PATH
): WallSnapshot {
	const next: WallSnapshot = {
		version: readWall(path).version + 1,
		applyAtWallSec: Math.ceil(nowSec) + LEAD_SEC,
		state
	};

	const dir = dirname(path);
	if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });

	const tmp = join(dir || '.', `.wall.${process.pid}.tmp`);
	writeFileSync(tmp, JSON.stringify(next, null, 2));
	renameSync(tmp, path);

	return next;
}
