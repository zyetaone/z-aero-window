import { describe, it, expect, vi, afterEach } from 'vitest';
import { useBlind, FLIGHT_COOLDOWN_MS } from '#lib/display/cabin/use-blind.svelte.js';
import type { AeroDisplay } from '#lib/display/display.svelte.js';

/**
 * The blind is the one thing a PASSENGER touches, and its close gesture is
 * wired to `advanceLocation()` — so a bug here either strands the window on one
 * city, or lets someone working the blind up and down march the wall through
 * the whole catalogue in seconds. On a three-Pi wall only the touched pane
 * moves, so that second failure splits the panorama.
 *
 * None of it was covered. `integration.test.ts` names this file, but only in a
 * source scan that checks it writes `blindOpen`.
 *
 * `useBlind` calls `$effect` at module scope, so every construction needs an
 * effect root — the same reason a component cannot be instantiated outside one.
 * `$effect.root` gives that without mounting anything, and the disposers run in
 * `afterEach` so one case's effect cannot observe the next. The file is
 * `.test.svelte.ts` so the compiler processes the runes.
 */
const roots: (() => void)[] = [];
afterEach(() => {
	while (roots.length) roots.pop()!();
});

function harness(blindOpen = true) {
	let advanced = 0;
	const config = { blindOpen };
	const display = {
		config,
		// The controller reads the EFFECTIVE state (auto-occlusion folded in).
		get blindOpen() {
			return config.blindOpen;
		},
		advanceLocation: () => {
			advanced++;
		}
	} as unknown as AeroDisplay;

	let blind!: ReturnType<typeof useBlind>;
	roots.push(
		$effect.root(() => {
			blind = useBlind(display);
		})
	);

	return {
		display,
		blind,
		get advanced() {
			return advanced;
		}
	};
}

const OPEN_Y = -105;

/**
 * Drive the real pointer handlers.
 *
 * `containerHeight` comes from the attached element's `offsetHeight`, and
 * nothing is attached here, so it falls back to 1 — which makes every pixel a
 * 100% delta. That is exactly what we want for a unit test: `clientY` is
 * effectively "percent of travel", and the clamp to [OPEN_Y, CLOSED_Y] does the
 * rest.
 */
function drag(blind: ReturnType<typeof useBlind>, fromY: number, toY: number) {
	const target = { setPointerCapture() {} } as unknown as HTMLElement;
	blind.onPointerDown({
		clientY: fromY,
		currentTarget: target,
		pointerId: 1
	} as unknown as PointerEvent);
	blind.onPointerMove({ clientY: toY } as unknown as PointerEvent);
	blind.onPointerUp();
}

describe('blind gesture', () => {
	it('a drag shorter than the snap threshold springs back', () => {
		const h = harness(true);
		// 0.2 of the travel, below the 0.3 threshold.
		drag(h.blind, 0, 0.2);
		expect(h.display.config.blindOpen, 'a sub-threshold drag committed').toBe(true);
		expect(h.advanced).toBe(0);
	});

	it('pulling the blind DOWN closes it and advances the location', () => {
		const h = harness(true);
		drag(h.blind, 0, 1);
		expect(h.display.config.blindOpen).toBe(false);
		expect(h.advanced, 'closing the blind did not advance').toBe(1);
	});

	it('pushing it back UP opens it and does NOT advance', () => {
		const h = harness(false);
		drag(h.blind, 1, 0);
		expect(h.display.config.blindOpen).toBe(true);
		expect(h.advanced, 'opening the blind advanced the location').toBe(0);
	});

	/**
	 * Only the CLOSE edge advances.
	 *
	 * Mutation-checked, and the result is worth writing down: deleting
	 * `|| nextOpen` from the guard `if (!wasOpen || nextOpen) return` leaves the
	 * whole suite green, and that is CORRECT rather than a gap. The branch is
	 * unreachable by construction — `onPointerUp` commits
	 * `dragY < dragStartY`, so from an open blind the only reachable commit is
	 * close, from a closed one the only reachable commit is open (where
	 * `!wasOpen` already returns), and the keyboard always toggles. There is no
	 * open->open path, so no test can distinguish the two forms.
	 *
	 * Left in the source as defence, not deleted: it is one operator away from
	 * being reachable if a future "reset the cabin" action ever commits a state
	 * rather than a toggle. Recorded here so the next person to run a mutation
	 * tool does not spend the afternoon I just did trying to kill it.
	 */
	it('opening never advances, whichever way the blind gets there', () => {
		const h = harness(false);
		h.blind.onKeyDown({ key: 'Enter' } as KeyboardEvent);
		expect(h.display.config.blindOpen).toBe(true);
		expect(h.advanced, 'opening advanced the location').toBe(0);
	});

	/**
	 * Without the cooldown, a passenger working the blind walks the wall through
	 * the catalogue — and only on this pane.
	 */
	it('rate-limits repeated closes to one flight per cooldown', () => {
		const now = vi.spyOn(Date, 'now');
		try {
			now.mockReturnValue(1_000_000);
			const h = harness(true);

			drag(h.blind, 0, 1);
			expect(h.advanced).toBe(1);

			/**
			 * Reopen by DRAGGING, not by assigning `config.blindOpen`.
			 *
			 * The `$effect` that resyncs `dragY` from the model runs
			 * asynchronously, so a bare assignment leaves the blind's internal
			 * position still at the closed stop and the next drag has no travel to
			 * cross the snap threshold. Driving it through the gesture is both
			 * closer to what a passenger does and free of that ordering question.
			 */
			drag(h.blind, 1, 0);
			expect(h.display.config.blindOpen, 'the reopen drag did not take').toBe(true);

			drag(h.blind, 0, 1);
			expect(h.advanced, 'a second close inside the cooldown advanced again').toBe(1);

			now.mockReturnValue(1_000_000 + FLIGHT_COOLDOWN_MS + 1);
			drag(h.blind, 1, 0);
			drag(h.blind, 0, 1);
			expect(h.advanced, 'the cooldown never expired').toBe(2);
		} finally {
			now.mockRestore();
		}
	});

	/**
	 * `lastFlightAtMs` starts at 0, so the FIRST close is always past the
	 * cooldown however recently the pane booted. Deliberate — a passenger's
	 * first interaction should do something — and worth pinning, because
	 * initialising it to `Date.now()` instead would silently swallow it and
	 * look like nothing more than an unresponsive blind.
	 */
	it('the first close is never swallowed by the cooldown', () => {
		const now = vi.spyOn(Date, 'now');
		try {
			now.mockReturnValue(1_700_000_000_000);
			const h = harness(true);
			drag(h.blind, 0, 1);
			expect(h.advanced).toBe(1);
		} finally {
			now.mockRestore();
		}
	});

	it('keyboard toggles the blind the same way a drag does', () => {
		const h = harness(true);
		h.blind.onKeyDown({ key: 'Enter' } as KeyboardEvent);
		expect(h.display.config.blindOpen).toBe(false);
		expect(h.advanced).toBe(1);
	});

	it('a cancelled drag commits nothing', () => {
		const h = harness(true);
		const target = { setPointerCapture() {} } as unknown as HTMLElement;
		h.blind.onPointerDown({
			clientY: 0,
			currentTarget: target,
			pointerId: 1
		} as unknown as PointerEvent);
		h.blind.onPointerMove({ clientY: 1 } as unknown as PointerEvent);
		h.blind.onPointerCancel();
		h.blind.onPointerUp();
		expect(h.display.config.blindOpen, 'a cancelled drag still committed').toBe(true);
		expect(h.advanced).toBe(0);
	});

	it('reports the open stop as a transform, with a settle transition', () => {
		const h = harness(true);
		expect(h.blind.transform).toBe(`translateY(${OPEN_Y.toFixed(1)}%)`);
		expect(h.blind.transition).toContain('transform');
	});

	it('drops the transition while dragging, so the blind tracks the finger', () => {
		const h = harness(true);
		const target = { setPointerCapture() {} } as unknown as HTMLElement;
		h.blind.onPointerDown({
			clientY: 0,
			currentTarget: target,
			pointerId: 1
		} as unknown as PointerEvent);
		expect(h.blind.transition, 'a transition during a drag lags the finger').toBe('none');
		h.blind.onPointerCancel();
	});
});
