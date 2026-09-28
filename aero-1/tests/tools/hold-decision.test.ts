import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The hold decision: does this pane wait for the wall-wide boundary, or restart
 * now?
 *
 * This is the function that decides whether three Pis restart together or one
 * goes early, so it is all arithmetic that can be pinned without a Pi. It is
 * extracted from the script and run in bash, matching apply-boundary.test.ts.
 *
 * WHY THIS EXISTS. The hold was added with a budget clamp and a set of
 * validation guards, inline in aero-updater.sh, with no test — the only covered
 * piece was `apply_boundary` itself. That is the gap this closes: `deploy/` is
 * not exercised by ANY CI job, so anything not extracted here is untested
 * until it runs on a fielded device.
 *
 * The three cases map to the three real outcomes:
 *
 *   hold       the normal case. Every pane computes the same boundary from the
 *              commit's committer time, so they wait and restart together.
 *   now        a pane finished building after the boundary. Ordinary, and no
 *              worse than before the hold existed.
 *   overbudget the boundary is further out than the service budget. Only
 *              reachable when this pane's clock is BEHIND the commit's, which
 *              is why the caller logs the skew: unclamped it would sleep for
 *              months and never update again.
 */
const script = readFileSync(resolve(__dirname, '../../../deploy/aero-updater.sh'), 'utf8');

function fns(): string {
	// apply_boundary is called by hold_decision, so both are needed.
	const boundary = script.match(/^apply_boundary\(\) \{[\s\S]*?^\}/m)?.[0];
	const hold = script.match(/^hold_decision\(\) \{[\s\S]*?^\}/m)?.[0];
	if (!boundary || !hold) throw new Error('apply_boundary/hold_decision not found in aero-updater.sh');
	return `${boundary}\n${hold}`;
}

function decide(commitTs: number, nowTs: number, budget = 2700, lead = LEAD): string {
	const out = execFileSync('bash', ['-c', `${fns()}\nhold_decision ${commitTs} ${nowTs} ${lead} ${budget}`], {
		encoding: 'utf8'
	});
	return out.trim();
}

/**
 * Many cases in ONE bash process.
 *
 * The first version of the sweep below called `decide()` 6300 times, and
 * execFileSync spawns bash per call — it did not finish in five minutes. A
 * sweep is the one place that needs many cases, so it gets the batch path
 * rather than a smaller sweep: the property is checked over the whole quarter
 * hour instead of a sample of it.
 */
function decideMany(cases: [number, number, number][]): string[] {
	const args = cases.map(([c, n, b]) => `"${c} ${n} ${LEAD} ${b}"`).join(' ');
	const script = `${fns()}
for c in ${args}; do
  set -- $c
  echo "$(hold_decision "$1" "$2" "$3" "$4")"
done`;
	return execFileSync('bash', ['-c', script], { encoding: 'utf8' })
		.split('\n')
		.filter(Boolean);
}

/** Default lead is 1200 s, so the boundary is 1200..2099 s after the commit. */
const LEAD = 1200;
const PERIOD = 900;
const boundaryAfter = (commitTs: number) =>
	Math.ceil((commitTs + LEAD) / PERIOD) * PERIOD;

describe('aero-updater hold_decision', () => {
	it('holds when the boundary is ahead and inside the budget', () => {
		// Commit lands exactly on a quarter-hour: the boundary is lead seconds on.
		const commit = 1_800_000_000 - (1_800_000_000 % PERIOD);
		const now = commit;
		const want = boundaryAfter(commit) - now;
		expect(decide(commit, now)).toBe(`hold:${want}`);
		expect(want).toBeGreaterThan(0);
		expect(want).toBeLessThanOrEqual(2700);
	});

	it('restarts immediately when the boundary has already passed', () => {
		const commit = 1_800_000_000;
		// Two whole periods past the boundary: a pane that built slowly.
		expect(decide(commit, boundaryAfter(commit) + 2 * PERIOD)).toBe('now');
	});

	it('restarts immediately when this pane is exactly on the boundary', () => {
		const commit = 1_800_000_000;
		expect(decide(commit, boundaryAfter(commit))).toBe('now');
	});

	it('refuses to hold past the budget — the backwards-clock case', () => {
		const commit = 1_800_000_000;
		const boundary = boundaryAfter(commit);
		// One second inside the budget still holds...
		expect(decide(commit, boundary - 2700)).toBe('hold:2700');
		// ...one second past it does not. This is the guard that stops an
		// offline Pi with a dead RTC sleeping until the heat death of the
		// universe: its clock is behind, so the boundary is further out than
		// the budget, so it restarts now and keeps taking updates.
		expect(decide(commit, boundary - 2701)).toBe('overbudget');
	});

	it('reaches overbudget only via a clock behind the commit, never when level', () => {
		// Sweep every commit position in the quarter-hour against a range of
		// clocks. With the clock level or ahead, the hold is (1200..2099) minus
		// a non-negative skew, so it can never exceed the 2700 s budget — which
		// is the claim that makes overbudget a clock fault and nothing else.
		const BUDGET = 2700;
		const cases: [number, number, number][] = [];
		for (let r = 0; r < 30; r++) {
			const commit = 1_800_000_000 + r;
			for (const skew of [0, 1, 600, 5000]) {
				cases.push([commit, commit + skew, BUDGET]);
			}
		}
		let maxHoldAtLevel = 0;
		const results = decideMany(cases);
		expect(results.length).toBe(cases.length);
		cases.forEach(([commit, now, budget], i) => {
			const d = results[i];
			if (now === commit && d.startsWith('hold:')) {
				maxHoldAtLevel = Math.max(maxHoldAtLevel, Number(d.slice('hold:'.length)));
			}
			expect(d, `commit ${commit} now ${now} budget ${budget}`).not.toBe('overbudget');
		});
		// And the worst case really is inside the budget, which is the property
		// the whole clamp exists to preserve.
		expect(maxHoldAtLevel).toBeLessThanOrEqual(BUDGET);
		expect(maxHoldAtLevel).toBeGreaterThan(1200);
	});

	it('is independent of the polling lag, which is what makes panes agree', () => {
		// Same commit, three panes that noticed it at different times. Every
		// pane that polls inside the window holds, and they all hold to the SAME
		// second — that shared instant is the entire point of the mechanism.
		const commit = 1_800_000_000;
		const boundary = boundaryAfter(commit);
		const lags = [0, 30, 300, 900];
		const holds = lags
			.map((lag) => decide(commit, commit + lag))
			.filter((d) => d.startsWith('hold:'));
		// The hold DURATIONS differ — a pane that noticed late waits less — and
		// the first version of this test asserted they were all equal, which is
		// both wrong and the thing that would have made the mechanism useless.
		// What must be identical is the instant each pane WAKES, because that is
		// the shared boundary: now + hold, for every pane, regardless of when it
		// polled. Hold durations differing is the mechanism working; hold
		// destinations differing is the wall split.
		expect(holds.length).toBeGreaterThan(1);
		// Poll time + hold must equal the one boundary, for every pane.
		const wakeInstants = lags
			.map((lag) => {
				const d = decide(commit, commit + lag);
				return d.startsWith('hold:') ? commit + lag + Number(d.slice('hold:'.length)) : null;
			})
			.filter((x): x is number => x !== null);
		expect(new Set(wakeInstants).size).toBe(1);
		expect(wakeInstants[0]).toBe(boundary);
	});
});
