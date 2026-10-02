/**
 * Comment stripping for the source-scanning check scripts.
 *
 * The check tools (check-determinism, check-cesium-isolation, check-rune-naming)
 * look for patterns "in code position". Their first implementation stripped
 * comments by hand — `line.split('//')[0]` and "skip lines starting with `*`" —
 * which fails both ways:
 *
 *   - `'https://x' + Math.random()`   the `//` inside the string hid the call
 *   - `// import { Viewer } from 'cesium'` a comment quoting an import flagged
 *
 * This is a single-pass character walk that knows about string literals
 * (`'`, `"`, template) and both comment forms, so a `//` inside a string is
 * text and a `cesium` inside a comment is not code. Comment characters are
 * replaced by spaces and newlines are kept, so line numbers in reports still
 * point at the right line and column arithmetic still works.
 *
 * Deliberately NOT handled (cost > benefit for lint-grade scanning):
 *   - regex literals (`/\/\//`)      would need a parser to disambiguate `/`
 *   - `${ }` nesting inside templates a template holding a `//` or a backtick
 *                                    inside its expression is vanishingly rare
 *   - a quoted block-comment terminator inside a block comment. `indexOf('*' + '/')`
 *     ends the comment at the FIRST such pair, even when it sits inside a
 *     quoted example, so the leftover quote then opens a phantom string that
 *     swallows a real `//` later on the line. Same class as the regex case —
 *     fixing it needs real parsing. (Writing this note without a literal
 *     terminator is not a stylistic choice: the first draft of it contained
 *     one and broke this very file.)
 *
 * SWEPT IN THIS APP, AND THE GAP IS REAL BUT ELSEWHERE. The sweep looks for a
 * regex literal containing a literal `//`, because the walker blanks from there.
 * aero-2 has one: `src/lib/wall.ts:132`
 *
 *     .refine((u) => /^(\/[^/]|https?:\/\/)/.test(u));
 *
 * the `\/\/` tail reads as a comment start, so `.test(u)` is invisible to any
 * checker using this. It does NOT reach `check-route-exports.mjs`, which only
 * reads `src/routes/` and found no such pattern there — the `http://` hits in
 * `admin/+page.svelte` and `AdminPanoramaLaunch.svelte` are inside STRING
 * literals, and this walker is string-aware, so they are text, not comments.
 * Accepted for the same reason as the regex case: fixing it needs a parser.
 * The day a checker pattern appears in a `? :` tail, this is the file hiding it,
 * so re-check `wall.ts` and any new `.test(`/`.match(`/`.replace(` line before
 * trusting a clean scan.
 *
 * For `.svelte` files, JS comment syntax only applies inside `<script>`; in
 * markup an `https://` in text is not a comment, an HTML comment is, and `<style>`
 * takes CSS block comments only. `stripSource` dispatches on the file extension.
 */

/** Strip JS/TS line and block comments, string-aware. Newlines preserved. */
export function stripJsComments(src) {
	let out = '';
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		const next = src[i + 1];
		if (c === '/' && next === '/') {
			while (i < n && src[i] !== '\n') {
				out += ' ';
				i++;
			}
			continue;
		}
		if (c === '/' && next === '*') {
			const end = src.indexOf('*/', i + 2);
			const stop = end === -1 ? n : end + 2;
			for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			const quote = c;
			out += c;
			i++;
			while (i < n) {
				const ch = src[i];
				out += ch;
				i++;
				if (ch === '\\') {
					if (i < n) {
						out += src[i];
						i++;
					}
					continue;
				}
				if (ch === quote) break;
				// Unterminated single-line string — bail at the newline so a
				// stray quote in code can't swallow the rest of the file.
				if (ch === '\n' && quote !== '`') break;
			}
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/** Strip CSS block comments. Newlines preserved. */
export function stripCssComments(src) {
	return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

/** Strip HTML comments. Newlines preserved. */
// Built from strings: a literal `<!` + `--` sequence is an HTML-like comment
// token to the JS lexer and is a SyntaxError inside an ES module.
const HTML_COMMENT = new RegExp('<' + '!--[\\s\\S]*?--' + '>', 'g');
export function stripHtmlComments(src) {
	return src.replace(HTML_COMMENT, (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Strip comments from a `.svelte` file: JS rules inside `<script>` blocks,
 * CSS rules inside `<style>` blocks, HTML comments in the markup between.
 */
export function stripSvelteComments(src) {
	const blocks = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)|(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g;
	let out = '';
	let last = 0;
	for (const m of src.matchAll(blocks)) {
		out += stripHtmlComments(src.slice(last, m.index));
		if (m[1] !== undefined) out += m[1] + stripJsComments(m[2]) + m[3];
		else out += m[4] + stripCssComments(m[5]) + m[6];
		last = m.index + m[0].length;
	}
	out += stripHtmlComments(src.slice(last));
	return out;
}

/** Strip comments by file type. `.svelte` → svelte rules, everything else → JS rules. */
export function stripSource(src, file) {
	return file.endsWith('.svelte') ? stripSvelteComments(src) : stripJsComments(src);
}
