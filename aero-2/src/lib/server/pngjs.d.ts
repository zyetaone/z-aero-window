/**
 * Minimal pngjs surface the tile route uses.
 *
 * pngjs ships no types; rather than a @types dependency for two methods,
 * declare exactly the surface `server/viirs-tint.ts` stands on. If a future
 * use needs more of the API, widen this — do not `any` the import.
 */
declare module 'pngjs' {
	export interface PngImage {
		width: number;
		height: number;
		data: Buffer;
	}

	export class PNG {
		constructor(options: { width: number; height: number });
		width: number;
		height: number;
		data: Buffer;
		static sync: {
			read(buffer: Uint8Array | Buffer): PngImage;
			write(png: PngImage | PNG): Buffer;
		};
	}
}
