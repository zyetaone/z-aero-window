/**
 * usb-import — a pen drive as an IMPORT SOURCE, never a second serving path.
 *
 * WHY THIS SHAPE. The obvious design points the player at the stick: list it,
 * serve from it, play from it. That grows a second URL space, a second cache
 * policy (a stick is removable, so nothing on it can be `immutable`), and a
 * path join whose last segment comes from a filesystem a stranger formatted.
 * Every file would keep the name it was given, and `media-store`'s whole
 * traversal defence is that names are GENERATED, never received.
 *
 * Copying into the content-addressed store instead costs one read per file and
 * removes all of that. It is also idempotent for free: the same clip imported
 * from the same stick twice yields the same hash, the same name and the same
 * URL, so re-importing is a no-op rather than a duplicate. Pull the stick out
 * afterwards and the wall keeps playing.
 *
 * WHAT IS DELIBERATELY NOT HERE: any udev-to-app notification. Nothing watches
 * for a drive appearing; an operator presses a button. A mount event would need
 * a channel from a root-owned udev rule into an unprivileged server process,
 * which is a subsystem, and the thing it would save is one click on a page the
 * operator is already looking at to choose the tracks.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';

import { safeResolveWithin } from './fs-guard.js';
import { isAllowedExtension, listMedia, maxUploadBytes, mediaDir, saveMedia } from './media-store.js';
import type { MediaItem } from './media-store.js';

/**
 * Where `99-aero-usb.rules` mounts the stick. A knob because the mount point is
 * a deployment fact this module cannot see — a developer testing on a Mac has
 * no `/media/aero` and should not have to invent one.
 */
export function usbDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.AERO_USB_DIR ?? '/media/aero';
}

export interface UsbImportResult {
	/** False when the directory is absent — no stick, or the mount did not fire. */
	mounted: boolean;
	/** Newly copied into the store. */
	imported: MediaItem[];
	/** Already there, byte for byte. Re-importing the same stick is free. */
	alreadyPresent: MediaItem[];
	/** Name plus why, so an operator can see that their `.aiff` was the problem. */
	skipped: { name: string; reason: string }[];
}

/**
 * Copy every playable file at the top level of `from` into the media store.
 *
 * One level only, deliberately: a recursive walk over a stranger's filesystem
 * is unbounded work triggered by an unprivileged button, and every player that
 * has ever read a USB stick has expected the tracks at the root.
 *
 * Each name goes through `safeResolveWithin` even though `readdir` should not
 * produce an escaping one. `media-store` earns its exemption from this by
 * generating names; this module receives them, so it does not inherit that.
 */
export async function importFromUsb(
	from: string = usbDir(),
	to: string = mediaDir(),
	limit: number = maxUploadBytes()
): Promise<UsbImportResult> {
	const result: UsbImportResult = {
		mounted: false,
		imported: [],
		alreadyPresent: [],
		skipped: []
	};
	if (!existsSync(from)) return result;
	result.mounted = true;

	let names: string[];
	try {
		names = await readdir(from);
	} catch {
		return result;
	}

	// One listing up front, so "was it already there" costs nothing per file and
	// does not need saveMedia to report it — saveMedia's contract is that the
	// caller cannot tell, which is what makes it idempotent.
	const before = new Set((await listMedia(to)).map((m) => m.filename));

	for (const name of names.sort()) {
		if (!isAllowedExtension(name)) {
			result.skipped.push({ name, reason: 'not an audio or video format the cabin plays' });
			continue;
		}
		const safe = safeResolveWithin(from, name);
		if (safe.forbidden || safe.notFound) {
			result.skipped.push({ name, reason: 'not a file inside the drive' });
			continue;
		}
		try {
			const info = await stat(safe.filePath);
			if (!info.isFile()) {
				result.skipped.push({ name, reason: 'not a file' });
				continue;
			}
			if (info.size > limit) {
				result.skipped.push({ name, reason: `larger than the ${limit}-byte cap` });
				continue;
			}
			const item = await saveMedia(name, new Uint8Array(await readFile(safe.filePath)), to);
			(before.has(item.filename) ? result.alreadyPresent : result.imported).push(item);
		} catch {
			result.skipped.push({ name, reason: 'could not be read from the drive' });
		}
	}
	return result;
}
