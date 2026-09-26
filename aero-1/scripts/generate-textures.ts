/**
 * Texture Generation Script — RGBA Channel-Packed Noise Textures
 *
 * Generates seamless tileable RGBA noise textures for volumetric cloud rendering.
 * Each RGBA channel carries an independent noise field, sampled in the shader.
 *
 * Texture A (cloud-noise.png) — 1024x1024 RGBA:
 *   R: Perlin-Worley blend (low freq, base cloud shapes)
 *   G: Worley F1 (medium freq, cumulus edges)
 *   B: Worley F1 (high freq, fine detail)
 *   A: Perlin FBM (very low freq, coverage gradient)
 *
 * Texture B (cloud-detail.png) — 512x512 RGBA (upscaled from 256 for more detail):
 *   R: Worley F2 (erosion)
 *   G: Curl noise X (distortion field)
 *   B: Curl noise Y (distortion field)
 *   A: High-frequency Perlin (micro-turbulence)
 *
 * Weather map (weather-map.png) — 256x256 grayscale:
 *   AI-generated if available, otherwise procedural large-scale blobs.
 *
 * Usage: bun run scripts/generate-textures.ts [--fallback-only]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

// .env is loaded via --env-file=.env in the npm script

const OUTPUT_DIR = path.join(process.cwd(), 'static/textures');
const USE_FALLBACK_ONLY = process.argv.includes('--fallback-only');

// ---------------------------------------------------------------------------
// Noise Primitives — Perlin, Worley (F1/F2), Curl, FBM
// ---------------------------------------------------------------------------

// Iquilez-style hash for seamless tiling: maps integer coords to pseudo-random gradient
// Uses bit mixing to produce high-quality deterministic randomness.
function hash2(ix: number, iy: number, seed: number): [number, number] {
	let x = ix * 1597334673 + iy * 3812015801 + seed * 2798796415;
	let y = ix * 2798796415 + iy * 1597334673 + seed * 3812015801;
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
	y = Math.imul(y ^ (y >>> 16), 0x45d9f3b);
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
	y = Math.imul(y ^ (y >>> 16), 0x45d9f3b);
	// Map to [-1, 1]
	return [(x >>> 0) / 0xffffffff * 2 - 1, (y >>> 0) / 0xffffffff * 2 - 1];
}

function hashFloat(ix: number, iy: number, seed: number): number {
	let x = ix * 1597334673 + iy * 3812015801 + seed * 2798796415;
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
	x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
	return (x >>> 0) / 0xffffffff;
}

function fade(t: number): number {
	return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
	return a + t * (b - a);
}

/**
 * Perlin noise with seamless tiling at integer period boundaries.
 * The `period` param controls the tiling period in noise space.
 */
function perlin(x: number, y: number, seed: number, period: number): number {
	const x0 = Math.floor(x);
	const y0 = Math.floor(y);
	const fx = x - x0;
	const fy = y - y0;
	const u = fade(fx);
	const v = fade(fy);

	// Wrap coords for seamless tiling
	const ix0 = ((x0 % period) + period) % period;
	const iy0 = ((y0 % period) + period) % period;
	const ix1 = (ix0 + 1) % period;
	const iy1 = (iy0 + 1) % period;

	// Gradient dot products
	const dot = (ix: number, iy: number, dx: number, dy: number) => {
		const [gx, gy] = hash2(ix, iy, seed);
		return gx * dx + gy * dy;
	};

	const n00 = dot(ix0, iy0, fx, fy);
	const n10 = dot(ix1, iy0, fx - 1, fy);
	const n01 = dot(ix0, iy1, fx, fy - 1);
	const n11 = dot(ix1, iy1, fx - 1, fy - 1);

	return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

/**
 * Fractional Brownian Motion using tileable Perlin noise.
 * Returns value in approximately [-1, 1].
 */
function fbm(
	x: number, y: number,
	octaves: number, lacunarity: number, gain: number,
	seed: number, basePeriod: number
): number {
	let value = 0;
	let amplitude = 1;
	let frequency = 1;
	let maxAmp = 0;
	for (let i = 0; i < octaves; i++) {
		value += amplitude * perlin(x * frequency, y * frequency, seed + i * 31, Math.round(basePeriod * frequency));
		maxAmp += amplitude;
		amplitude *= gain;
		frequency *= lacunarity;
	}
	return value / maxAmp;
}

/**
 * Worley (cellular) noise with seamless tiling.
 * Returns { f1, f2 } — distances to nearest and second-nearest feature points.
 * `cellCount` is the number of cells per unit in each dimension.
 */
function worley(x: number, y: number, cellCount: number, seed: number): { f1: number; f2: number } {
	const cx = x * cellCount;
	const cy = y * cellCount;
	const cellXi = Math.floor(cx);
	const cellYi = Math.floor(cy);

	let d1 = Infinity;
	let d2 = Infinity;

	for (let di = -1; di <= 1; di++) {
		for (let dj = -1; dj <= 1; dj++) {
			// Wrap cell indices for seamless tiling
			const ni = ((cellXi + di) % cellCount + cellCount) % cellCount;
			const nj = ((cellYi + dj) % cellCount + cellCount) % cellCount;

			// Feature point position within cell (deterministic from hash)
			const fpx = ni + hashFloat(ni, nj, seed);
			const fpy = nj + hashFloat(ni, nj, seed + 7919);

			// Check distance with wrapping offsets
			for (let wx = -1; wx <= 1; wx++) {
				for (let wy = -1; wy <= 1; wy++) {
					const dx = cx - (fpx + wx * cellCount);
					const dy = cy - (fpy + wy * cellCount);
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist < d1) {
						d2 = d1;
						d1 = dist;
					} else if (dist < d2) {
						d2 = dist;
					}
				}
			}
		}
	}

	// Normalize by expected cell size
	const norm = 1 / Math.sqrt(2);
	return { f1: Math.min(d1 * norm, 1), f2: Math.min(d2 * norm, 1) };
}

/**
 * Perlin-Worley blend — the classic volumetric cloud base shape.
 * Blends FBM Perlin with inverted Worley F1 for organic cloud shapes.
 */
function perlinWorley(x: number, y: number, seed: number): number {
	// Low-frequency Perlin FBM
	const p = fbm(x * 4, y * 4, 5, 2.0, 0.5, seed, 4);
	const pNorm = (p + 1) * 0.5; // [0,1]

	// Worley F1 at matching scale
	const { f1 } = worley(x, y, 4, seed + 100);
	const wNorm = 1 - f1; // Invert: bright in cell centers

	// Blend: Perlin provides macro shape, Worley adds cellular structure
	return Math.max(0, Math.min(1, lerp(pNorm, wNorm, 0.4)));
}

/**
 * Curl noise — divergence-free 2D vector field derived from Perlin noise.
 * Returns [curl_x, curl_y] in approximately [-1, 1].
 */
function curlNoise(x: number, y: number, seed: number, period: number): [number, number] {
	const eps = 0.01;
	// Partial derivatives of a Perlin scalar field
	const n = (px: number, py: number) => perlin(px, py, seed, period);

	// curl = (dN/dy, -dN/dx)
	const dNdy = (n(x, y + eps) - n(x, y - eps)) / (2 * eps);
	const dNdx = (n(x + eps, y) - n(x - eps, y)) / (2 * eps);

	return [dNdy, -dNdx];
}

// ---------------------------------------------------------------------------
// Texture Generators — RGBA channel packing
// ---------------------------------------------------------------------------

function clamp01(v: number): number {
	return Math.max(0, Math.min(1, v));
}

function toByte(v: number): number {
	return Math.round(clamp01(v) * 255);
}

/**
 * Texture A: Primary cloud noise — 512x512 RGBA
 * R: Perlin-Worley (low freq, base cloud shapes)
 * G: Worley F1 (medium freq, cumulus edges)
 * B: Worley F1 (high freq, fine detail)
 * A: Perlin FBM (very low freq, coverage gradient)
 */
function generateTextureA(width: number, height: number): Buffer {
	const pixels = Buffer.alloc(width * height * 4);
	console.log('    Computing R: Perlin-Worley (base shapes)...');

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = x / width;
			const v = y / height;
			const idx = (y * width + x) * 4;

			// R: Perlin-Worley blend — base cloud shapes
			const r = perlinWorley(u, v, 42);

			// G: Worley F1 medium frequency — cumulus edges
			const { f1: gF1 } = worley(u, v, 8, 1337);
			const g = 1 - gF1;

			// B: Worley F1 high frequency — fine detail
			const { f1: bF1 } = worley(u, v, 16, 9999);
			const b = 1 - bF1;

			// A: Very low frequency Perlin — coverage gradient
			const aVal = fbm(u * 2, v * 2, 3, 2.0, 0.6, 7777, 2);
			const a = (aVal + 1) * 0.5;

			pixels[idx] = toByte(r);
			pixels[idx + 1] = toByte(g);
			pixels[idx + 2] = toByte(b);
			pixels[idx + 3] = toByte(a);
		}

		if (y % 128 === 0 && y > 0) {
			console.log(`    ...row ${y}/${height}`);
		}
	}

	return pixels;
}

/**
 * Texture B: Detail/distortion noise — 256x256 RGBA
 * R: Worley F2 (erosion)
 * G: Curl noise X (distortion field)
 * B: Curl noise Y (distortion field)
 * A: High-frequency Perlin (micro-turbulence)
 */
function generateTextureB(width: number, height: number): Buffer {
	const pixels = Buffer.alloc(width * height * 4);
	console.log('    Computing channels: Worley F2, Curl XY, hi-freq Perlin...');

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = x / width;
			const v = y / height;
			const idx = (y * width + x) * 4;

			// R: Worley F2 — erosion patterns
			const { f2 } = worley(u, v, 6, 5555);
			const r = f2;

			// G,B: Curl noise — divergence-free distortion field
			const [curlX, curlY] = curlNoise(u * 8, v * 8, 3333, 8);
			const g = (curlX + 1) * 0.5;
			const b = (curlY + 1) * 0.5;

			// A: High-frequency Perlin — micro-turbulence
			const aVal = fbm(u * 16, v * 16, 4, 2.0, 0.5, 8888, 16);
			const a = (aVal + 1) * 0.5;

			pixels[idx] = toByte(r);
			pixels[idx + 1] = toByte(g);
			pixels[idx + 2] = toByte(b);
			pixels[idx + 3] = toByte(a);
		}
	}

	return pixels;
}

/**
 * Weather map: Large-scale coverage — 256x256 grayscale
 * Used for macro-scale cloud density variation.
 */
function generateWeatherMap(width: number, height: number): Buffer {
	const pixels = Buffer.alloc(width * height);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const u = x / width;
			const v = y / height;

			// Very low frequency FBM for large blobby patches
			const n = fbm(u * 3, v * 3, 4, 2.0, 0.55, 6161, 3);
			let value = (n + 1) * 0.5;
			// Smoothstep for blobby weather-map look
			value = value * value * (3 - 2 * value);

			pixels[y * width + x] = toByte(value);
		}
	}

	return pixels;
}

// ---------------------------------------------------------------------------
// AI Generation (for weather-map artistic textures only)
// ---------------------------------------------------------------------------

async function generateWeatherMapAI(): Promise<Buffer | null> {
	const apiKey = process.env.GOOGLE_GENAI_API_KEY;
	if (!apiKey) {
		console.warn('  [AI] GOOGLE_GENAI_API_KEY not set, skipping');
		return null;
	}

	const genAiModule = await import('@google/genai').catch(() => null);
	if (!genAiModule?.GoogleGenAI) {
		console.warn('  [AI] @google/genai is not installed, skipping');
		return null;
	}

	const { GoogleGenAI } = genAiModule;
	const ai = new GoogleGenAI({ apiKey });
	const prompt =
		'seamless tileable abstract cloud coverage map, grayscale, large soft blobs and clear patches, satellite weather view style, abstract noise texture, no text, no borders';

	// Try Imagen 3
	for (const model of ['imagen-3.0-generate-002', 'imagen-3.0-generate-001']) {
		try {
			console.log(`  [AI] Trying ${model}...`);
			const response = await ai.models.generateImages({
				model,
				prompt,
				config: { numberOfImages: 1, aspectRatio: '1:1', outputMimeType: 'image/png' }
			});
			const bytes = response.generatedImages?.[0]?.image?.imageBytes;
			if (bytes) {
				console.log(`  [AI] Success with ${model}`);
				return Buffer.from(bytes, 'base64');
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`  [AI] ${model} failed: ${msg}`);
		}
	}

	// Try Gemini generateContent with image modality
	try {
		console.log('  [AI] Trying gemini-2.0-flash generateContent...');
		const response = await ai.models.generateContent({
			model: 'gemini-2.0-flash',
			contents: prompt,
			config: { responseModalities: ['image'] }
		});
		const parts = response.candidates?.[0]?.content?.parts;
		if (parts) {
			for (const part of parts) {
				if (part.inlineData?.data) {
					console.log('  [AI] Success with gemini-2.0-flash');
					return Buffer.from(part.inlineData.data, 'base64');
				}
			}
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`  [AI] Gemini failed: ${msg}`);
	}

	return null;
}

// ---------------------------------------------------------------------------
// PNG Encoder — RGBA or Grayscale, zlib-compressed
// ---------------------------------------------------------------------------

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		crc ^= data[i];
		for (let j = 0; j < 8; j++) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type: string, data: Uint8Array): Buffer {
	const buf = Buffer.alloc(4 + 4 + data.length + 4);
	buf.writeUInt32BE(data.length, 0);
	buf.write(type, 4, 4, 'ascii');
	Buffer.from(data).copy(buf, 8);
	const crcInput = Buffer.alloc(4 + data.length);
	crcInput.write(type, 0, 4, 'ascii');
	Buffer.from(data).copy(crcInput, 4);
	buf.writeUInt32BE(crc32(crcInput), 8 + data.length);
	return buf;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function encodeRGBA_PNG(width: number, height: number, rgba: Buffer): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;  // bit depth
	ihdr[9] = 6;  // color type: RGBA
	ihdr[10] = 0; // compression
	ihdr[11] = 0; // filter
	ihdr[12] = 0; // interlace

	const rowBytes = width * 4;
	const rawData = Buffer.alloc(height * (rowBytes + 1));
	for (let y = 0; y < height; y++) {
		rawData[y * (rowBytes + 1)] = 0; // filter: None
		rgba.copy(rawData, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
	}
	const compressed = zlib.deflateSync(rawData, { level: 9 });

	return Buffer.concat([
		PNG_SIGNATURE,
		makeChunk('IHDR', ihdr),
		makeChunk('IDAT', compressed),
		makeChunk('IEND', Buffer.alloc(0))
	]);
}

function encodeGray_PNG(width: number, height: number, gray: Buffer): Buffer {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;  // bit depth
	ihdr[9] = 0;  // color type: Grayscale
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	const rawData = Buffer.alloc(height * (width + 1));
	for (let y = 0; y < height; y++) {
		rawData[y * (width + 1)] = 0; // filter: None
		gray.copy(rawData, y * (width + 1) + 1, y * width, (y + 1) * width);
	}
	const compressed = zlib.deflateSync(rawData, { level: 9 });

	return Buffer.concat([
		PNG_SIGNATURE,
		makeChunk('IHDR', ihdr),
		makeChunk('IDAT', compressed),
		makeChunk('IEND', Buffer.alloc(0))
	]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	console.log('=== Aero Window Texture Generator ===');
	console.log('  Output: RGBA channel-packed noise textures\n');
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });

	const results: { name: string; size: number }[] = [];

	// --- Texture A: Primary cloud noise (1024x1024 RGBA) ---
	{
		const name = 'cloud-noise.png';
		const outPath = path.join(OUTPUT_DIR, name);
		console.log(`[1/3] Generating ${name} (1024x1024 RGBA)`);
		console.log('  R: Perlin-Worley | G: Worley F1 (med) | B: Worley F1 (hi) | A: Perlin (lo)');

		const pixels = generateTextureA(1024, 1024);
		const png = encodeRGBA_PNG(1024, 1024, pixels);
		fs.writeFileSync(outPath, png);

		const kb = png.length / 1024;
		console.log(`  Saved: ${name} (${kb.toFixed(1)} KB)\n`);
		results.push({ name, size: png.length });
	}

	// --- Texture B: Detail/distortion noise (512x512 RGBA) ---
	{
		const name = 'cloud-detail.png';
		const outPath = path.join(OUTPUT_DIR, name);
		console.log(`[2/3] Generating ${name} (512x512 RGBA)`);
		console.log('  R: Worley F2 | G: Curl X | B: Curl Y | A: Hi-freq Perlin');

		const pixels = generateTextureB(512, 512);
		const png = encodeRGBA_PNG(512, 512, pixels);
		fs.writeFileSync(outPath, png);

		const kb = png.length / 1024;
		console.log(`  Saved: ${name} (${kb.toFixed(1)} KB)\n`);
		results.push({ name, size: png.length });
	}

	// --- Weather map (256x256 grayscale) ---
	{
		const name = 'weather-map.png';
		const outPath = path.join(OUTPUT_DIR, name);
		console.log(`[3/3] Generating ${name} (256x256 grayscale)`);

		let saved = false;

		// Try AI generation for weather map (artistic texture — good use case for AI)
		if (!USE_FALLBACK_ONLY) {
			const aiBuffer = await generateWeatherMapAI();
			if (aiBuffer && aiBuffer.length > 100) {
				fs.writeFileSync(outPath, aiBuffer);
				console.log(`  Saved (AI): ${name} (${(aiBuffer.length / 1024).toFixed(1)} KB)\n`);
				results.push({ name, size: aiBuffer.length });
				saved = true;
			}
		}

		if (!saved) {
			console.log('  Using procedural generation...');
			const pixels = generateWeatherMap(256, 256);
			const png = encodeGray_PNG(256, 256, pixels);
			fs.writeFileSync(outPath, png);

			const kb = png.length / 1024;
			console.log(`  Saved (procedural): ${name} (${kb.toFixed(1)} KB)\n`);
			results.push({ name, size: png.length });
		}
	}

	// --- Remove old textures that are no longer needed ---
	const oldFiles = ['cloud-wisp.png'];
	for (const old of oldFiles) {
		const oldPath = path.join(OUTPUT_DIR, old);
		if (fs.existsSync(oldPath)) {
			fs.unlinkSync(oldPath);
			console.log(`Removed obsolete: ${old}`);
		}
	}

	// --- Verification ---
	console.log('\n=== Verification ===');
	let allGood = true;
	for (const { name, size } of results) {
		const outPath = path.join(OUTPUT_DIR, name);
		if (fs.existsSync(outPath)) {
			console.log(`  OK: ${name} (${(size / 1024).toFixed(1)} KB)`);
		} else {
			console.error(`  MISSING: ${name}`);
			allGood = false;
		}
	}

	if (allGood) {
		console.log('\nAll textures generated successfully!');
	} else {
		console.error('\nSome textures are missing!');
		process.exit(1);
	}
}

main().catch((err) => {
	console.error('Fatal error:', err);
	process.exit(1);
});
