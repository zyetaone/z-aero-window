#!/usr/bin/env node
/**
 * Repo static checks: import cycles, tracked→untracked imports, rune naming.
 *
 * This used to be two scripts (`check-cycles.mjs`, `check-rune-naming.mjs`)
 * that each walked and read every source file. One walk, one read pass,
 * one report — same three rules, half the I/O, one name to remember.
 *
 * Rule 1 — no import cycles. ARCHITECTURE.md claimed "no import cycles"
 * while `sim` and `stage` imported each other in both directions — a rule
 * nothing enforced, so nothing kept. Cycles break tree-shaking, produce
 * undefined-at-import-time bugs that only show up at runtime, and make
 * files impossible to read in isolation. So: detect cycles, say nothing
 * about layering. If a genuine layering rule is ever needed again, it
 * should arrive with a bug that proves it.
 *
 * Rule 2 — a tracked file may not import an untracked one. Three sessions
 * write to this working tree at once. A commit staged with an explicit path
 * still commits whatever that file says at commit time, and a file edited
 * by someone else between your read and your write carries their line --
 * which is how `Display.svelte` came to import `world/maplibre/Stage`, a
 * directory git has never seen. It resolved on disk, nothing complained,
 * and a clean clone of main could not build the display at all. Only the
 * tracked -> untracked direction is checked: a file you have just created
 * is untracked and imports whatever it likes; the moment something
 * committed depends on it, `git add` is no longer optional.
 *
 * Rule 3 — NEVER name a variable `state` when using `$state`. `state`
 * collides with the rune conceptually and in grep-ability. Use `model`,
 * `engine`, or `config`. Today zero files violate this; the check exists
 * so the first one fails loudly instead of becoming house style.
 *
 * Run: node tools/check-repo.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';

const LIB = new URL('../src/lib', import.meta.url).pathname;
const SRC = new URL('../src', import.meta.url).pathname;

function walk(dir) {
	const out = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (/\.(ts|svelte)$/.test(e)) out.push(p);
	}
	return out;
}

/** Resolve an import specifier to a real file path, or null if external. */
/**
 * A specifier this repo OWNS. It must resolve on disk; nothing else can supply
 * it. Bare specifiers (`svelte`, `$app/*`, `$env/*`) are somebody else's job.
 */
const isLocalSpec = (spec) =>
	// `./$types` is SvelteKit's generated route types. It is relative-looking
	// but lives in `.svelte-kit/types/`, so it never resolves next to the file
	// that imports it -- every +server.ts and +page.svelte would flag.
	!/(^|\/)\$types$/.test(spec) &&
	(spec.startsWith('#lib/') ||
	spec.startsWith('#routes/') ||
		spec.startsWith('./') ||
		spec.startsWith('../'));

function resolveImport(spec, fromFile) {
	let base;
	if (spec.startsWith('#lib/')) base = join(LIB, spec.slice('#lib/'.length));
	else if (spec.startsWith('#routes/')) base = join(SRC, 'routes', spec.slice('#routes/'.length));
	else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec);
	else return null; // node_modules, $app/*, $env/*, etc.

	// `#lib/x/y.js` is the TS-required extension for `y.ts`.
	const cands = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}.svelte`];
	for (const c of cands) {
		if (existsSync(c) && statSync(c).isFile()) return c;
	}
	return null;
}

// Single read pass shared by all three checks.
const files = walk(SRC);
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

function rel(p) {
	return p.slice(SRC.length + 1);
}

const problems = [];
const unresolved = [];

// --- Rule 1: cycles (iterative DFS, first cycle per entry) ---
const graph = new Map();
for (const [file, src] of sources) {
	const deps = new Set();
	// static `from '...'` plus dynamic `import('...')`
	for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
		const target = resolveImport(m[1], file);
		if (target && target !== file) deps.add(target);
		/**
		 * Rule 0 — a specifier we own that resolves to NOTHING.
		 *
		 * Rule 2 below catches an import whose target is on disk but untracked.
		 * It cannot catch one whose target is not there at all: `resolveImport`
		 * returns null for that, the dep is dropped, and the file is treated as
		 * having no such import. A typo'd path and a deleted-but-still-imported
		 * module therefore passed silently -- the two states where a clean clone
		 * MOST certainly cannot build.
		 *
		 * Verified by negative control, three ways: target absent (was silent,
		 * now caught), target on disk and untracked (Rule 2, caught), target
		 * staged (still passes -- see the note on Rule 2).
		 */
		else if (!target && isLocalSpec(m[1]))
			unresolved.push(`${rel(file)}\n      → ${m[1]} (resolves to nothing)`);
	}
	graph.set(file, [...deps]);
}

const WHITE = 0,
	GREY = 1,
	BLACK = 2;
const colour = new Map(files.map((f) => [f, WHITE]));
const cycles = [];

for (const start of files) {
	if (colour.get(start) !== WHITE) continue;
	const stack = [[start, 0]];
	const path = [start];
	colour.set(start, GREY);

	while (stack.length > 0) {
		const frame = stack[stack.length - 1];
		const [node, i] = frame;
		const deps = graph.get(node) ?? [];

		if (i >= deps.length) {
			colour.set(node, BLACK);
			stack.pop();
			path.pop();
			continue;
		}

		frame[1]++;
		const next = deps[i];
		const c = colour.get(next);

		if (c === GREY) {
			const from = path.indexOf(next);
			cycles.push([...path.slice(from), next].map(rel).join('\n      → '));
		} else if (c === WHITE) {
			colour.set(next, GREY);
			stack.push([next, 0]);
			path.push(next);
		}
	}
}

/**
 * --- Rule 2: tracked -> untracked ---
 *
 * KNOWN LIMIT, deliberately not closed. `git ls-files` reads the INDEX, so a
 * file another session has STAGED but not committed counts as tracked here and
 * this rule passes. That is the right ergonomic locally -- `git add` is the
 * documented remedy, and demanding a commit instead would flag ordinary work.
 *
 * It is also how `main` went nine days unbuildable: `git commit -- <path>`
 * commits what a file says ON DISK, so committing a file you edited also
 * commits an edit someone else made to it -- and an importer can go to `main`
 * while its staged-only import stays behind. Twenty-three files ended up
 * referenced by `main` and absent from it.
 *
 * No static check run against a dirty shared tree can answer "would HEAD still
 * build". Check HEAD itself after committing a subset of a shared tree:
 *
 *     git worktree add -q --detach /tmp/wt HEAD && (cd /tmp/wt/aero-2 && bun run check)
 */
let tracked;
try {
	// `git ls-files` prints paths relative to the CURRENT directory, not the
	// repo root -- so `-C` fixes the base and the paths join back onto it. The
	// first draft resolved against the repo root instead, every path missed,
	// the tracked set matched nothing, and the check passed by comparing
	// nothing at all. Which is the failure it was written to catch.
	const root = resolve(SRC, '..');
	tracked = new Set(
		execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'src'], { encoding: 'utf8' })
			.split('\0')
			.filter(Boolean)
			.map((p) => resolve(root, p))
	);
} catch {
	tracked = null; // not a git checkout; nothing to compare against
}

const dangling = [];
if (tracked?.size) {
	for (const [file, deps] of graph) {
		if (!tracked.has(file)) continue;
		for (const dep of deps) {
			if (!tracked.has(dep)) dangling.push(`${rel(file)}\n      → ${rel(dep)} (untracked)`);
		}
	}
}

// --- Rule 3: rune naming ---
const violations = [];
for (const [file, src] of sources) {
	const hits = [];
	src.split('\n').forEach((line, i) => {
		const s = line.trim();
		if (s.startsWith('*') || s.startsWith('//')) return;
		if (/(let|const|var)\s+state\s*=\s*\$state/.test(s.split('//')[0])) hits.push(i + 1);
	});
	if (hits.length > 0) violations.push({ rel: rel(file), hits });
}

// --- One report ---
if (unresolved.length > 0) {
	console.error('Imports that resolve to nothing:\n');
	for (const u of unresolved) console.error(`  ${u}\n`);
	problems.push(`${unresolved.length} unresolved import(s) — fix the path, or restore the file.`);
}
if (dangling.length > 0) {
	console.error('Tracked files importing untracked files:\n');
	for (const d of dangling) console.error(`  ${d}\n`);
	problems.push(`${dangling.length} dangling import(s) — git add the target, or fix the path.`);
}
if (cycles.length > 0) {
	console.error('Import cycles:\n');
	for (const c of cycles) console.error(`  ${c}\n`);
	problems.push(`${cycles.length} cycle(s).`);
}
if (violations.length > 0) {
	console.error('Variables named `state` holding $state:\n');
	for (const v of violations) {
		console.error(`  ${v.rel} (lines ${v.hits.join(', ')})`);
	}
	problems.push('Rename to `model`, `engine`, or `config`.');
}

if (problems.length > 0) {
	for (const p of problems) console.error(p);
	process.exit(1);
}

console.log(
	`Repo checks pass — ${files.length} files, every local import resolves, no cycles, no dangling imports, rune naming holds.`
);
