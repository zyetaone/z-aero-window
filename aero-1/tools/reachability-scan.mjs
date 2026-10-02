// Dev utility: import-graph reachability from app entrypoints.
// Reports tracked src/ + content/ modules no entrypoint can reach.
// Resolution is path-based ($lib, $content, relative); dynamic imports counted.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const tracked = new Set(execSync('git ls-files src content server.ts').toString().trim().split('\n'));
const isModule = (f) => /\.(ts|js|svelte)$/.test(f);

const exists = (p) => tracked.has(p);
function resolve(spec, fromFile) {
	let base;
	if (spec.startsWith('$lib/')) base = 'src/lib/' + spec.slice(5);
	else if (spec.startsWith('$content/')) base = 'content/' + spec.slice(9);
	else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
	else return null;
	for (const c of [base, base + '.ts', base + '.svelte', base + '.js', base + '.svelte.ts', base + '/index.ts']) {
		if (exists(c)) return c;
	}
	return null;
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
function importsOf(file) {
	const text = fs.readFileSync(file, 'utf8');
	const out = [];
	for (const m of text.matchAll(IMPORT_RE)) {
		const r = resolve(m[1], file);
		if (r) out.push(r);
	}
	return out;
}

// Entrypoints: everything SvelteKit/Bun loads directly.
const entries = [...tracked].filter(
	(f) => isModule(f) && (f === 'server.ts' || /^src\/routes\/.*\/?\+(page|layout|server|error)/.test(f) || /^src\/(app|hooks)/.test(f)),
);

const seen = new Set();
const stack = [...entries];
while (stack.length) {
	const f = stack.pop();
	if (seen.has(f)) continue;
	seen.add(f);
	for (const dep of importsOf(f)) if (!seen.has(dep)) stack.push(dep);
}

// Deliberately parked, documented at its definition site. Keep this list
// short: each entry is a claim that dead code is intentional.
const PARKED = new Set([
	'content/shows/night-clouds.show.ts',
	'content/shows/midday-clouds.show.ts',
]);

const dead = [...tracked].filter((f) => isModule(f) && !seen.has(f) && !PARKED.has(f)).sort();
console.log(`entrypoints: ${entries.length}  reachable: ${seen.size}  UNREACHABLE: ${dead.length}`);
for (const f of dead) console.log('  ', f);
