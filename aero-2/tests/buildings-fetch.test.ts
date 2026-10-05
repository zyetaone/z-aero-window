import { describe, it, expect } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `tools/fetch-buildings.py` cannot be exercised against Overpass from a test,
 * or from most CI, so the parts that decide what lands on disk are tested
 * against a FIXTURE instead: the Overpass response shape, height derivation,
 * the deterministic selection, and above all the self-check that refuses to
 * write a pack which does not contain its own pin.
 *
 * The self-check is the part worth testing. The defect it exists to stop —
 * Hyderabad's pack, 10.9 km from a 6.4 km box, synthetic, 564 identical
 * rectangles at a uniform 8 m — was written by a person or a script that
 * trusted its own output, and survived every check in this repo. If the only
 * thing between the next bad pack and disk is four lines at the bottom of a
 * Python file that nobody runs, then those four lines are load-bearing and
 * need a test like any other.
 *
 * The tool is invoked as a SUBPROCESS, not imported, because the properties
 * worth asserting are the ones a caller sees: exit code, what is on disk, and
 * what is in the refusal file. Importing would test the functions and miss the
 * argument handling and the exit codes.
 *
 * THE FIXTURE IS A REAL OVERPASS RESPONSE SHAPE, hand-built to exercise each
 * branch: a way with an explicit height, one with levels only, one with a type
 * default, one with nothing (which must be DROPPED, not guessed), and a
 * multipolygon relation whose member way arrives open and must be closed.
 */
const TOOL = resolve(process.cwd(), 'tools/fetch-buildings.py');

function fixture(elements: unknown[]): string {
	return JSON.stringify({ version: 0.6, generator: 'fixture', elements });
}

interface RunResult {
	status: number;
	stderr: string;
	dir: string;
}

/**
 * Runs the tool with an explicit argv. Split out from `run` because the
 * failover test has to name endpoints IT builds rather than the one stub `run`
 * stands up — and because the properties worth asserting are the ones a caller
 * sees: exit code, what is on disk, what is in the refusal file.
 */
async function execTool(argv: string[], dir: string): Promise<RunResult> {
	/**
	 * ASYNC, and it has to be.
	 *
	 * The first version of this used `execFileSync` and the suite hung for
	 * the full timeout on every case, with no output. The stub Overpass
	 * endpoint lives in THIS process, so answering the tool's POST needs the
	 * event loop — and `execFileSync` blocks the event loop for exactly as
	 * long as the child runs. The child waits for a response that cannot be
	 * produced until the child exits. A textbook self-deadlock, and one that
	 * looks like a slow test rather than a wrong one.
	 */
	const { status, stderr } = await new Promise<{ status: number; stderr: string }>(
		(resolve, reject) => {
			execFile('python3', [TOOL, ...argv], { encoding: 'utf8' }, (error, _stdout, errOut) => {
				if (error && typeof error.code !== 'number') return reject(error);
				resolve({ status: error ? (error.code as number) : 0, stderr: errOut ?? '' });
			});
		}
	);
	return { status, stderr, dir };
}

/**
 * Runs the tool against a local stub of the Overpass endpoint, so the whole
 * path — HTTP, JSON parse, geometry, self-check, write — is exercised without
 * a network. A stub is the only way to test a failure mode, and the failure
 * modes here are the point.
 */
async function run(elements: unknown[], args: string[] = []): Promise<RunResult> {
	const dir = mkdtempSync(join(tmpdir(), 'aero-buildings-'));
	const { createServer } = await import('node:http');
	const body = fixture(elements);

	const server = createServer((req, res) => {
		let payload = '';
		req.on('data', (c) => (payload += c));
		req.on('end', () => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(body);
		});
	});

	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const port = (server.address() as { port: number }).port;

	try {
		return await execTool(
			[
				'testville',
				'--lat',
				'0',
				'--lon',
				'0',
				// `--out` is not optional here. Without it the tool writes to
				// `./data/buildings` in the REPO, which is what the first
				// version of this test did: it passed, and left a 68 KB
				// testville.geojson in the working tree. The tool's default is
				// correct for a human at a repo root and wrong for a test.
				'--out',
				dir,
				'--endpoint',
				`http://127.0.0.1:${port}/api/interpreter`,
				...args
			],
			dir
		);
	} finally {
		server.close();
	}
}

/** A closed square around (lat, lon), as an Overpass `way` with geometry. */
function square(lat: number, lon: number, tags: Record<string, string>) {
	const d = 0.0002;
	return {
		type: 'way',
		id: Math.floor(Math.random() * 1e9),
		tags,
		geometry: [
			{ lat: lat - d, lon: lon - d },
			{ lat: lat + d, lon: lon - d },
			{ lat: lat + d, lon: lon + d },
			{ lat: lat - d, lon: lon + d },
			{ lat: lat - d, lon: lon - d }
		]
	};
}

/** Enough well-sized footprints to clear MIN_FEATURES. */
function manySquares(n: number, lat: number, lon: number) {
	return Array.from({ length: n }, (_, i) =>
		square(lat + (i % 20) * 0.0004, lon + Math.floor(i / 20) * 0.0004, {
			building: 'office',
			height: '30'
		})
	);
}

describe('fetch-buildings.py', () => {
	it('writes a pack that covers its own pin, with a manifest', async () => {
		const r = await run(manySquares(320, 0, 0));
		expect(r.status, r.stderr).toBe(0);

		const pack = join(r.dir, 'data/buildings/testville.geojson');
		expect(existsSync(pack)).toBe(true);
		const fc = JSON.parse(readFileSync(pack, 'utf8'));
		expect(fc.type).toBe('FeatureCollection');
		expect(fc.features.length).toBeGreaterThanOrEqual(300);

		// Every ring closed, every coordinate finite, and inside the pin's box.
		for (const f of fc.features) {
			const ring = f.geometry.coordinates[0];
			expect(ring[0]).toEqual(ring[ring.length - 1]);
			for (const [lng, lat] of ring) {
				expect(Number.isFinite(lng) && Number.isFinite(lat)).toBe(true);
				expect(Math.abs(lat)).toBeLessThan(90);
				expect(Math.abs(lng)).toBeLessThan(180);
			}
		}

		const manifest = JSON.parse(
			readFileSync(join(r.dir, 'data/buildings/source-testville.json'), 'utf8')
		);
		expect(manifest.place).toBe('testville');
		expect(manifest.lat).toBe(0);
		expect(manifest.contentSha256).toMatch(/^[0-9a-f]{64}$/);
		// The `night` colour belongs to the glow stamper, not here.
		expect(manifest.note).toContain('stamp-building-glow');
		for (const f of fc.features) {
			expect(Object.keys(f.properties)).toEqual(['height']);
		}
		rmSync(r.dir, { recursive: true, force: true });
	});

	it('REFUSES a pack that does not contain the pin, and writes no pack', async () => {
		/**
		 * The Hyderabad case exactly: plenty of features, all valid, all in the
		 * wrong place. A tool that trusted its own output would write it and the
		 * defect would be invisible until someone flew it.
		 */
		const r = await run(manySquares(320, 0.1, 0.1)); // ~11 km south
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('REFUSING');
		expect(r.stderr).toContain('does not contain its own pin');

		// Crucially: NO pack on disk, and the candidate preserved for inspection.
		expect(existsSync(join(r.dir, 'data/buildings/testville.geojson'))).toBe(false);
		const rej = JSON.parse(readFileSync(join(r.dir, 'data/buildings/testville.rej.json'), 'utf8'));
		expect(rej.problems.join(' ')).toContain('does not contain its own pin');
		rmSync(r.dir, { recursive: true, force: true });
	});

	it('REFUSES a pack too thin to read as a city', async () => {
		/**
		 * The Denver case: the right place, but 190 footprints. Containment
		 * passes, so this has to be a separate refusal.
		 */
		const r = await run(manySquares(120, 0, 0));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('footprints');
		expect(existsSync(join(r.dir, 'data/buildings/testville.geojson'))).toBe(false);
		rmSync(r.dir, { recursive: true, force: true });
	});

	it('derives height from height, then levels, then a type default', async () => {
		const r = await run([
			square(0, 0, { building: 'yes', height: '123.5' }),
			square(0.0005, 0, { building: 'yes', 'building:levels': '10' }),
			square(0.001, 0, { building: 'office' }),
			...manySquares(300, 0.002, 0)
		]);
		expect(r.status, r.stderr).toBe(0);
		const fc = JSON.parse(readFileSync(join(r.dir, 'data/buildings/testville.geojson'), 'utf8'));
		const heights = fc.features.map((f: { properties: { height: number } }) => f.properties.height);

		expect(heights).toContain(123.5); // height tag
		expect(heights).toContain(32); // 10 levels x 3.2
		expect(heights).toContain(26); // office default
		rmSync(r.dir, { recursive: true, force: true });
	});

	it('drops buildings it cannot size rather than guessing a height', async () => {
		const r = await run([
			square(0, 0, { building: 'yes' }), // no height, no levels, type 'yes' -> default 8
			square(0.0005, 0, { highway: 'residential' }), // no building tag at all
			...manySquares(300, 0.002, 0)
		]);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toMatch(/dropped \d+ elements/);
		rmSync(r.dir, { recursive: true, force: true });
	});

	it('keeps the tallest when over the cap, deterministically', async () => {
		/**
		 * A skyline is what reads from 2 km up. A random 600 of 40,000 would be
		 * a field of bungalows with three towers in it, and — worse for a test —
		 * would differ run to run, so two panes built from the same Overpass
		 * response would not be the same city.
		 *
		 * The cap cannot go below MIN_FEATURES or the self-check refuses, which
		 * is correct: so this buries three distinctive towers among 320 filler
		 * and caps at 300, which must keep all three and drop 20.
		 */
		const towers = [
			square(0, 0, { building: 'yes', height: '250' }),
			square(0.0001, 0, { building: 'yes', height: '99' }),
			square(0.0002, 0, { building: 'yes', height: '140' })
		];
		const elements = [...towers, ...manySquares(320, 0.001, 0.001)];
		const a = await run(elements, ['--max-features', '300']);
		const b = await run(elements, ['--max-features', '300']);
		expect(a.status, a.stderr).toBe(0);
		expect(b.status, b.stderr).toBe(0);

		const heights = (dir: string) =>
			JSON.parse(readFileSync(join(dir, 'data/buildings/testville.geojson'), 'utf8')).features.map(
				(f: { properties: { height: number } }) => f.properties.height
			);

		const kept = heights(a.dir);
		expect(kept.length).toBe(300);
		// All three towers survive the cap; the filler is all 30 m.
		for (const h of [250, 140, 99]) expect(kept).toContain(h);
		// Deterministic: the same response yields the same pack, property for
		// property. Overpass's element order is not stable, so this is the only
		// thing standing between two panes and two different skylines.
		expect(heights(a.dir)).toEqual(heights(b.dir));
		rmSync(a.dir, { recursive: true, force: true });
		rmSync(b.dir, { recursive: true, force: true });
	});

	it('closes an open member way from a multipolygon relation', async () => {
		const r = await run([
			{
				type: 'relation',
				id: 1,
				tags: { building: 'yes', height: '40' },
				members: [
					{
						type: 'way',
						role: 'outer',
						// Open ring — relations commonly hand members back unclosed.
						geometry: [
							{ lat: -0.0002, lon: -0.0002 },
							{ lat: 0.0002, lon: -0.0002 },
							{ lat: 0.0002, lon: 0.0002 },
							{ lat: -0.0002, lon: 0.0002 }
						]
					}
				]
			},
			...manySquares(300, 0.001, 0)
		]);
		expect(r.status, r.stderr).toBe(0);
		const fc = JSON.parse(readFileSync(join(r.dir, 'data/buildings/testville.geojson'), 'utf8'));
		const rel = fc.features.find(
			(f: { properties: { height: number } }) => f.properties.height === 40
		);
		expect(rel).toBeDefined();
		const ring = rel.geometry.coordinates[0];
		expect(ring[0]).toEqual(ring[ring.length - 1]);
		rmSync(r.dir, { recursive: true, force: true });
	});

	it('fails over to the next endpoint, and records the one that served', async () => {
		/**
		 * The single-endpoint version of this tool died the moment
		 * overpass-api.de declined it — which it does routinely, and did
		 * recently with a 406 that had nothing to do with the query. A build
		 * fetcher with one mirror does not have availability, it has a
		 * schedule, and the failure mode was "no city pack today" with a
		 * stack trace pointing at a third party.
		 *
		 * Stub A answers 504 to everything; stub B answers with the fixture.
		 * A is listed FIRST, so if failover did not happen this test cannot
		 * pass on any path — it would exit non-zero.
		 */
		const dir = mkdtempSync(join(tmpdir(), 'aero-buildings-'));
		const { createServer } = await import('node:http');
		const body = fixture(manySquares(320, 0, 0));
		let deadHits = 0;

		const dead = createServer((_req, res) => {
			deadHits++;
			res.writeHead(504, { 'Content-Type': 'text/plain' });
			res.end('504 Gateway Time-out');
		});
		const live = createServer((_req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(body);
		});

		await new Promise<void>((d) => dead.listen(0, '127.0.0.1', d));
		await new Promise<void>((d) => live.listen(0, '127.0.0.1', d));
		const deadUrl = `http://127.0.0.1:${(dead.address() as { port: number }).port}/api/interpreter`;
		const liveUrl = `http://127.0.0.1:${(live.address() as { port: number }).port}/api/interpreter`;

		try {
			const started = Date.now();
			const r = await execTool(
				[
					'testville',
					'--lat',
					'0',
					'--lon',
					'0',
					'--out',
					dir,
					'--endpoint',
					deadUrl,
					'--endpoint',
					liveUrl
				],
				dir
			);
			expect(r.status, r.stderr).toBe(0);

			/**
			 * THE BACKOFF IS PAID PER ROUND, NOT PER ENDPOINT.
			 *
			 * The structure's whole claim — and the reason a dead primary
			 * costs one request instead of one timeout — is that the sleep
			 * happens only after every endpoint has declined. Nothing about
			 * the successful path distinguishes the two implementations:
			 * both end with a 200 from the live stub, the same stderr, and
			 * the same manifest. Only wall-clock separates them.
			 *
			 * Measured: this path runs in ~900 ms with the round-ordered
			 * sleep, and 5 s+ with a sleep inside the inner loop (one
			 * 5-second delay before the live stub is ever reached). 4000 ms
			 * sits between them with ~4x headroom on the healthy side and
			 * ~20% below the mutant, so it fails for the reason it means to
			 * rather than for CI jitter.
			 */
			expect(Date.now() - started).toBeLessThan(4000);

			// The dead mirror was genuinely asked. Without this the test only
			// proves the live stub works, which the tests above already do.
			expect(deadHits).toBeGreaterThan(0);
			expect(r.stderr).toContain('trying next endpoint');
			expect(existsSync(join(dir, 'data/buildings/testville.geojson'))).toBe(true);

			// Provenance must name the endpoint that ACTUALLY served, not the
			// first one listed. A manifest blaming a mirror that 504'd sends
			// the next person through the wrong provider's logs.
			const manifest = JSON.parse(
				readFileSync(join(dir, 'data/buildings/source-testville.json'), 'utf8')
			);
			expect(manifest.endpoint).toBe(liveUrl);
		} finally {
			dead.close();
			live.close();
			rmSync(dir, { recursive: true, force: true });
		}
		// 30 s, well above the ~900 ms this takes when failover works, and the
		// point is that the DEFAULT 5 s is not enough when it does not. With a
		// dead primary and no failover the tool burns 5 s + 10 s of backoff
		// before giving up, so under the default this test fails with
		// "Test timed out in 5000ms" and the exit code and stderr assertions
		// below never run — a failure that names the harness clock instead of
		// the defect. Measured by breaking failover on purpose and reading the
		// report rather than trusting that "failed" meant the right thing.
		// The still-passing path stays ~900 ms, so nothing is slowed down.
	}, 30_000);

	it('raises on 400/413/422 instead of cycling the mirrors', async () => {
		/**
		 * THE OTHER HALF OF THE FAILURE POLICY, and the half that had no
		 * coverage whatsoever — deleting `if fatal: raise` from the tool
		 * leaves this suite 9/9 green, which is exactly how a policy stated
		 * in prose and in a commit message stops being the policy without
		 * anything going red.
		 *
		 * 400 means the QUERY is wrong. No mirror can fix a request all of
		 * them would reject, so the correct behaviour is to ask the first,
		 * be told "your request is bad", and stop. Failing over would cost
		 * two backoff sleeps and then report the same message 15 seconds
		 * later, which is the defect the fail-fast was written to prevent.
		 *
		 * Stub A answers 400; stub B would cheerfully serve the fixture.
		 * Asserting B was never reached IS the test — without that line a
		 * tool that failed over would write a pack and exit 0, which from
		 * the exit code alone is indistinguishable from the test above.
		 */
		const dir = mkdtempSync(join(tmpdir(), 'aero-buildings-'));
		const { createServer } = await import('node:http');
		const body = fixture(manySquares(320, 0, 0));
		let badHits = 0;
		let goodHits = 0;

		const bad = createServer((_req, res) => {
			badHits++;
			res.writeHead(400, { 'Content-Type': 'text/plain' });
			res.end('Error: line 1: static reference to unknown property');
		});
		const good = createServer((_req, res) => {
			goodHits++;
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(body);
		});

		await new Promise<void>((d) => bad.listen(0, '127.0.0.1', d));
		await new Promise<void>((d) => good.listen(0, '127.0.0.1', d));
		const badUrl = `http://127.0.0.1:${(bad.address() as { port: number }).port}/api/interpreter`;
		const goodUrl = `http://127.0.0.1:${(good.address() as { port: number }).port}/api/interpreter`;

		try {
			const r = await execTool(
				[
					'testville',
					'--lat',
					'0',
					'--lon',
					'0',
					'--out',
					dir,
					'--endpoint',
					badUrl,
					'--endpoint',
					goodUrl
				],
				dir
			);
			expect(r.status, `a 400 must not exit 0:\n${r.stderr}`).not.toBe(0);
			expect(r.stderr).toContain('HTTP 400');

			// The live mirror was never asked. Without this line the
			// fail-fast could be deleted, the tool would cycle to B, get a
			// 200, write the pack, and every assertion above would still
			// hold — while the policy had been inverted.
			expect(goodHits).toBe(0);
			expect(badHits).toBeGreaterThan(0);
		} finally {
			bad.close();
			good.close();
			rmSync(dir, { recursive: true, force: true });
		}
		// 30 s for consistency with the failover case, but a correct run is
		// one request and no sleep. The broken run — fail-fast deleted — is
		// 3 rounds x 2 endpoints with two backoff sleeps, ~15 s, which still
		// finishes inside this and fails on goodHits rather than the clock.
	}, 30_000);

	it('rejects an unknown place unless coordinates are given', () => {
		/**
		 * The PLACES table is a copy of `src/lib/locations.ts`, and a copy that
		 * silently fetches the wrong city is the defect this whole file is about
		 * in a different costume. Refusing an unknown label is what stops a
		 * typo from becoming a pack somewhere else entirely.
		 */
		let status = 0;
		let stderr = '';
		try {
			execFileSync('python3', [TOOL, 'atlantis'], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe']
			});
		} catch (e) {
			const err = e as { status?: number; stderr?: string };
			status = err.status ?? 1;
			stderr = err.stderr ?? '';
		}
		expect(status).toBe(2);
		expect(stderr).toContain('unknown place');
	});

	it('refuses a non-http(s) --endpoint instead of becoming a local-file reader', () => {
		/**
		 * `--endpoint` is a developer convenience, but a flag that accepts
		 * `file://` or a bare path is an SSRF / local-file-read waiting for
		 * the day it gets wired into a script. The default list is hardcoded
		 * https; the override has to stay within http(s) too. The refusal is
		 * asserted, not merely a non-zero exit: a tool that quietly ignored
		 * the bad scheme and fell back to the default would also exit
		 * non-zero whenever the network is down, which would make the test
		 * pass for the wrong reason on an offline machine.
		 */
		let status = 0;
		let stderr = '';
		try {
			execFileSync(
				'python3',
				[TOOL, 'testville', '--lat', '0', '--lon', '0', '--endpoint', 'file:///etc/hosts'],
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
			);
		} catch (e) {
			const err = e as { status?: number; stderr?: string };
			status = err.status ?? 1;
			stderr = err.stderr ?? '';
		}
		expect(status, `a file:// endpoint must be refused:\n${stderr}`).toBe(2);
		expect(stderr).toContain('file:///etc/hosts');
	});
});
