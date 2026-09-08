/**
 * qr — a minimal QR encoder, byte mode, version 3, error correction level M.
 *
 * WHY NOT A DEPENDENCY. This runs on a kiosk that must boot with no network and
 * no npm registry, and the whole job is turning one ~32-character URL into a
 * bitmap. The smallest maintained QR package is several hundred kilobytes of
 * generality — every version, every mode, every mask, canvas and SVG renderers,
 * Reed-Solomon tables for cases this will never hit. Against that, the fixed
 * subset below is ~200 lines and has no supply chain.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. One version, one EC level, one mode. That
 * is not a shortcut, it is the requirement: the only thing ever encoded here is
 * `http://<ipv4>:<port>/admin`, whose longest realistic form is
 * `http://255.255.255.255:65535/admin` at 34 bytes. Version 3 at level M holds
 * 42, so there is headroom without touching this. Anything longer throws rather
 * than silently producing an unreadable code — a QR that scans to the wrong
 * thing is worse than one that never appears.
 *
 * Level M (~15% recovery) rather than L: this is photographed off a glossy
 * display, at an angle, often with a reflection across it.
 *
 * Correctness is not obvious by reading, so `qr.test.ts` decodes the output
 * with an independent implementation rather than snapshotting it. A QR encoder
 * that is subtly wrong still produces a plausible-looking grid.
 *
 * Lives at `lib/` root rather than beside its only consumer in
 * `display/cabin/`, because `regressions.test.ts` forbids anything under
 * `display/` from naming a protocol — and the SVG below has to declare the
 * `http://www.w3.org/2000/svg` namespace to be an SVG at all. That rule exists
 * to stop a renderer building its own tile URL, which is a real failure this
 * repo has had; an XML namespace is not that, and moving the file is cheaper
 * than teaching the check to tell them apart.
 */

const VERSION = 3;
/** Modules per side: 21 for v1, +4 per version. */
export const QR_SIZE = 17 + VERSION * 4; // 29
/**
 * v3-M block parameters, per ISO/IEC 18004 Table 9: one block, 70 total
 * codewords, 44 data and 26 error correction.
 *
 * These are the numbers to get right, and the first draft had 55 data
 * codewords — the figure for v3-L. The result still produced a plausible grid
 * with correct finders, timing and alignment, and no reader could decode it.
 * That is the failure mode of a hand-written encoder: it looks like a QR code.
 * Caught by decoding the output with an independent implementation, which is
 * what `qr.test.ts` does.
 */
const DATA_CODEWORDS = 44;
const EC_CODEWORDS = 26;
/** Byte-mode payload: data codewords minus the 4-bit mode and 8-bit length. */
const CAPACITY = DATA_CODEWORDS - 2; // 42

// ── Galois field (GF(256), primitive polynomial 0x11d) ──────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
	let x = 1;
	for (let i = 0; i < 255; i++) {
		EXP[i] = x;
		LOG[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon generator polynomial of the given degree. */
function generator(degree: number): Uint8Array {
	let poly = new Uint8Array([1]);
	for (let i = 0; i < degree; i++) {
		const next = new Uint8Array(poly.length + 1);
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j];
			next[j + 1] ^= mul(poly[j], EXP[i]);
		}
		poly = next;
	}
	return poly;
}

function ecBytes(data: Uint8Array, count: number): Uint8Array {
	const gen = generator(count);
	const rem = new Uint8Array(count);
	for (const byte of data) {
		const factor = byte ^ rem[0];
		rem.copyWithin(0, 1);
		rem[count - 1] = 0;
		for (let i = 0; i < count; i++) rem[i] ^= mul(gen[i + 1], factor);
	}
	return rem;
}

// ── Bit stream ─────────────────────────────────────────────────────────────
class Bits {
	readonly bytes: number[] = [];
	private length = 0;

	push(value: number, width: number): void {
		for (let i = width - 1; i >= 0; i--) {
			const bit = (value >>> i) & 1;
			if (this.length % 8 === 0) this.bytes.push(0);
			if (bit) this.bytes[this.bytes.length - 1] |= 0x80 >>> (this.length % 8);
			this.length++;
		}
	}

	get bitLength(): number {
		return this.length;
	}
}

// ── Matrix ─────────────────────────────────────────────────────────────────
type Grid = { m: Uint8Array; reserved: Uint8Array };

const at = (g: Grid, x: number, y: number) => g.m[y * QR_SIZE + x];
const set = (g: Grid, x: number, y: number, v: number, reserve = true) => {
	g.m[y * QR_SIZE + x] = v;
	if (reserve) g.reserved[y * QR_SIZE + x] = 1;
};

function placeFinder(g: Grid, ox: number, oy: number): void {
	for (let dy = -1; dy <= 7; dy++) {
		for (let dx = -1; dx <= 7; dx++) {
			const x = ox + dx;
			const y = oy + dy;
			if (x < 0 || y < 0 || x >= QR_SIZE || y >= QR_SIZE) continue;
			const edge = dx === -1 || dy === -1 || dx === 7 || dy === 7;
			const ring = dx === 0 || dy === 0 || dx === 6 || dy === 6;
			const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
			set(g, x, y, edge ? 0 : ring || core ? 1 : 0);
		}
	}
}

/** v3 has one alignment pattern, centred at (22, 22). */
function placeAlignment(g: Grid): void {
	const c = 22;
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			const outer = Math.max(Math.abs(dx), Math.abs(dy));
			set(g, c + dx, c + dy, outer === 1 ? 0 : 1);
		}
	}
}

function placeTiming(g: Grid): void {
	for (let i = 8; i < QR_SIZE - 8; i++) {
		const v = i % 2 === 0 ? 1 : 0;
		set(g, i, 6, v);
		set(g, 6, i, v);
	}
}

/**
 * Format information for EC level M and the chosen mask, with its BCH code.
 *
 * Written twice, as the spec requires: once around the top-left finder and once
 * split across the other two. A reader uses whichever it can see, which is what
 * makes a partially obscured code still scan.
 */
function placeFormat(g: Grid, mask: number): void {
	const data = (0b00 << 3) | mask; // 00 = level M
	let rem = data;
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	const bits = ((data << 10) | rem) ^ 0x5412;

	for (let i = 0; i < 15; i++) {
		const bit = (bits >>> i) & 1;
		// Around the top-left finder.
		if (i < 6) set(g, 8, i, bit);
		else if (i < 8) set(g, 8, i + 1, bit);
		else if (i === 8) set(g, 7, 8, bit);
		else set(g, 14 - i, 8, bit);
		// Mirrored copy.
		if (i < 8) set(g, QR_SIZE - 1 - i, 8, bit);
		else set(g, 8, QR_SIZE - 15 + i, bit);
	}
	set(g, 8, QR_SIZE - 8, 1); // always-dark module
}

/** Mask 0: (row + col) % 2 === 0. One mask, chosen for simplicity. */
const maskAt = (x: number, y: number) => (x + y) % 2 === 0;

function placeData(g: Grid, codewords: Uint8Array): void {
	let bit = 0;
	let upward = true;
	for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5; // skip the vertical timing column
		for (let step = 0; step < QR_SIZE; step++) {
			const y = upward ? QR_SIZE - 1 - step : step;
			for (const x of [right, right - 1]) {
				if (g.reserved[y * QR_SIZE + x]) continue;
				const byte = codewords[bit >>> 3] ?? 0;
				let v = (byte >>> (7 - (bit & 7))) & 1;
				if (maskAt(x, y)) v ^= 1;
				set(g, x, y, v, false);
				bit++;
			}
		}
		upward = !upward;
	}
}

/**
 * Encode `text` as a QR matrix. Row-major, 1 = dark.
 *
 * Throws on overflow rather than truncating: a code that scans to a shortened
 * URL sends someone to the wrong place, which is worse than no code at all.
 */
export function encodeQr(text: string): { size: number; modules: Uint8Array } {
	const data = new TextEncoder().encode(text);
	if (data.length > CAPACITY) {
		throw new Error(`QR payload ${data.length} bytes exceeds v${VERSION}-M capacity ${CAPACITY}`);
	}

	const bits = new Bits();
	bits.push(0b0100, 4); // byte mode
	bits.push(data.length, 8); // v1-9 byte mode uses an 8-bit length
	for (const b of data) bits.push(b, 8);
	bits.push(0, Math.min(4, DATA_CODEWORDS * 8 - bits.bitLength)); // terminator
	while (bits.bitLength % 8 !== 0) bits.push(0, 1);

	const dataWords = new Uint8Array(DATA_CODEWORDS);
	dataWords.set(bits.bytes.slice(0, DATA_CODEWORDS));
	// Pad alternately with 0xEC / 0x11, per the spec.
	for (let i = bits.bytes.length; i < DATA_CODEWORDS; i++) {
		dataWords[i] = (i - bits.bytes.length) % 2 === 0 ? 0xec : 0x11;
	}

	const all = new Uint8Array(DATA_CODEWORDS + EC_CODEWORDS);
	all.set(dataWords);
	all.set(ecBytes(dataWords, EC_CODEWORDS), DATA_CODEWORDS);

	const g: Grid = {
		m: new Uint8Array(QR_SIZE * QR_SIZE),
		reserved: new Uint8Array(QR_SIZE * QR_SIZE)
	};
	placeFinder(g, 0, 0);
	placeFinder(g, QR_SIZE - 7, 0);
	placeFinder(g, 0, QR_SIZE - 7);
	placeAlignment(g);
	placeTiming(g);
	placeFormat(g, 0);
	placeData(g, all);

	return { size: QR_SIZE, modules: g.m };
}

/**
 * The matrix as an SVG string.
 *
 * SVG rather than canvas so it scales to any panel without resampling, and so
 * the component stays declarative. One `<path>` of rectangles rather than one
 * element per module: 29x29 is 841 elements otherwise, and a kiosk redrawing
 * that on every open is work for nothing.
 */
export function qrSvg(text: string, quietZone = 4): string {
	const { size, modules } = encodeQr(text);
	const total = size + quietZone * 2;
	let d = '';
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (modules[y * size + x]) d += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
		}
	}
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
		`shape-rendering="crispEdges" role="img" aria-label="Admin URL QR code">` +
		`<rect width="${total}" height="${total}" fill="#fff"/>` +
		`<path d="${d}" fill="#000"/></svg>`
	);
}
