#!/usr/bin/env node
/**
 * Import-cycle check (ported from aero-2).
 *
 * Detect cycles, say nothing about layering. Cycles break tree-shaking,
 * produce undefined-at-import-time bugs that only show up at runtime, and
 * make files impossible to read in isolation.
 *
 * aero-1 adaptations: `$lib/` and `$content/` aliases (SvelteKit default +
 * svelte.config alias → content/), and both `src/` and `content/` are
 * walked because authored artifacts under content/ are imported as source
 * (Rule 0 content/control split). Like the original, this is not
 * type-aware: `import type` edges count, so a type-only round-trip still
 * fails — that is what caught `active → compose → camera → active` and
 * led to the `ActiveManager` port interface in `active.svelte.ts`.
 *
 * Run: node tools/check-cycles.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';

const APP = new URL('..', import.meta.url).pathname;
const SRC = join(APP, 'src');
const CONTENT = join(APP, 'content');
const LIB = join(SRC, 'lib');

function walk(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) out.push(...walk(p));
		else if (/\.(ts|svelte)$/.test(e)) out.push(p);
	}
	return out;
}

/** Resolve an import specifier to a real file path, or null if external. */
function resolveImport(spec, fromFile) {
	let base;
	if (spec.startsWith('$lib/')) base = join(LIB, spec.slice('$lib/'.length));
	else if (spec.startsWith('$content/')) base = join(CONTENT, spec.slice('$content/'.length));
	else if (spec.startsWith('./') || spec.startsWith('../')) base = resolve(dirname(fromFile), spec);
	else return null; // node_modules, $app/*, $env/*, cesium, etc.

	// SvelteKit/TS allow extensionless and directory imports.
	const cands = [
		base,
		base.replace(/\.js$/, '.ts'),
		`${base}.ts`,
		`${base}.svelte`,
		`${base}/index.ts`,
		`${base}/index.svelte`
	];
	for (const c of cands) {
		if (existsSync(c) && statSync(c).isFile()) return c;
	}
	return null;
}

const files = [...walk(SRC), ...walk(CONTENT)];
const graph = new Map();

/**
 * A `from '...'` edge counts only when it can exist at runtime.
 *
 * `import type`, `export type ... from`, and imports whose every specifier
 * is `type`-qualified are erased by TypeScript and can never form a
 * runtime cycle. aero-1 has four such type-only loops, all deliberate:
 * `types ↔ config-tree` (SSOT unions one way, SimulationContext config
 * fields the other), `config-tree → weather → types` (Rule 0: the control
 * plane reads authored content; the back-edges are types), and two
 * `utils → types → config-tree → {crdt-store,} utils` tails whose
 * loop-closing edges are types. Chasing those would mean churning the
 * config core and the content boundary against the documented
 * architecture — work without a bug. Anything that survives erasure
 * still fails below.
 */
function* runtimeImports(src) {
	// `import type ... from 'x'` — fully erased.
	// `import ... from 'x'` — erased only when every specifier is `type`-led.
	for (const m of src.matchAll(/\bimport\b(\s+type\b)?\s*([^;'"]*?)\bfrom\s*['"]([^'"]+)['"]/g)) {
		if (m[1]) continue;
		const body = m[2].trim();
		if (body.startsWith('{')) {
			const specs = body
				.slice(1, body.lastIndexOf('}'))
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			if (specs.length > 0 && specs.every((s) => /^\s*type\b/.test(s))) continue;
		}
		yield m[3];
	}
	// `export type ... from 'x'` re-exports are erased; value re-exports stay.
	for (const m of src.matchAll(/\bexport\b(\s+type\b)?\s*([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g)) {
		if (m[1]) continue;
		yield m[2];
	}
	// Side-effect imports and dynamic imports always execute.
	for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) yield m[1];
	for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) yield m[1];
}

for (const file of files) {
	const src = readFileSync(file, 'utf8');
	const deps = new Set();

	for (const spec of runtimeImports(src)) {
		const target = resolveImport(spec, file);
		if (target && target !== file) deps.add(target);
	}
	graph.set(file, [...deps]);
}

// Iterative DFS with an explicit stack, reporting the first cycle per entry.
const WHITE = 0,
	GREY = 1,
	BLACK = 2;
const colour = new Map(files.map((f) => [f, WHITE]));
const cycles = [];

function rel(p) {
	return p.startsWith(APP) ? p.slice(APP.length) : p;
}

for (const start of files) {
	if (colour.get(start) !== WHITE) continue;

	const stack = [[start, 0]];
	const path = [];
	colour.set(start, GREY);
	path.push(start);

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
 * A tracked file may not import an untracked one: a commit staged with an
 * explicit path still commits whatever that file says at commit time, and a
 * clean clone would then fail to build. Only the tracked -> untracked
 * direction is checked.
 */
let tracked;
try {
	tracked = new Set(
		execFileSync('git', ['-C', APP, 'ls-files', '-z', '--', 'src', 'content'], {
			encoding: 'utf8'
		})
			.split('\0')
			.filter(Boolean)
			.map((p) => resolve(APP, p))
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

if (dangling.length > 0) {
	console.error('Tracked files importing untracked files:\n');
	for (const d of dangling) console.error(`  ${d}\n`);
	console.error(`${dangling.length} dangling import(s) — git add the target, or fix the path.`);
	process.exit(1);
}

if (cycles.length > 0) {
	console.error('Import cycles:\n');
	for (const c of cycles) console.error(`  ${c}\n`);
	console.error(`${cycles.length} cycle(s).`);
	process.exit(1);
}

console.log(`No import cycles, no untracked imports — ${files.length} files checked.`);
