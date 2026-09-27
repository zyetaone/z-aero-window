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
			while (i < n && src[i] !== '\n') { out += ' '; i++; }
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
			out += c; i++;
			while (i < n) {
				const ch = src[i];
				out += ch; i++;
				if (ch === '\\') { if (i < n) { out += src[i]; i++; } continue; }
				if (ch === quote) break;
				// Unterminated single-line string — bail at the newline so a
				// stray quote in code can't swallow the rest of the file.
				if (ch === '\n' && quote !== '`') break;
			}
			continue;
		}
		out += c; i++;
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
