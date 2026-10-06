/**
 * ship-pack — copy aero-3's data onto a Pi, and prove the running server sees it.
 *
 * data/ is gitignored, so the release branch the updater pulls never carries it
 * (aero-2/tools/ship-tiles.sh explains the same gap for aero-2). aero-3 needs a
 * different slice: only the zooms it reads (Sentinel-2 z7/8/11/12, Terrarium
 * z8/10, VIIRS z8), the road packs, and its own OSM building packs.
 *
 *   bun aero-3/tools/ship-pack.ts pi@10.0.0.31             # from anywhere
 *   bun aero-3/tools/ship-pack.ts pi@10.0.0.31 --dry-run [--dir /opt/aero-window]
 *
 * rsync over ssh with --partial: resumable on a flaky wall LAN, and a no-op for
 * what the Pi already has. Then the app restarts (data routes mount at startup)
 * and the DEVICE is asked which routes it serves: rsync's exit code is not proof.
 */
import { $ } from 'bun';
import { readdirSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: { dir: { type: 'string', default: '/opt/aero-window' }, 'dry-run': { type: 'boolean', default: false } } });
const target = positionals[0];
if (!target) {
	console.error('usage: bun aero-3/tools/ship-pack.ts <user@host> [--dir /opt/aero-window] [--dry-run]');
	process.exit(2);
}
$.cwd(`${import.meta.dir}/../..`); // the repo root: rsync --relative keeps these paths on the Pi

const PACK = [
	'./data/tiles/sentinel2/7', './data/tiles/sentinel2/8', './data/tiles/sentinel2/11', './data/tiles/sentinel2/12',
	'./aero-2/data/tiles/terrarium/8', './aero-2/data/tiles/terrarium/10',
	'./aero-2/data/tiles/viirs/8',
	'./data/roads',
	'./aero-3/data/buildings'
];
for (const dir of PACK) {
	let entries: string[] = [];
	try {
		entries = readdirSync(`${import.meta.dir}/../../${dir}`);
	} catch {}
	if (!entries.length) throw new Error(`missing or empty locally: ${dir} (fetch it before shipping)`);
}

const size = (await $`du -shc ${PACK}`.text()).trim().split('\n').at(-1)!.split('\t')[0];
console.info(`shipping ${size} to ${target}:${values.dir}`);
const dry = values['dry-run'] ? ['--dry-run'] : [];
await $`rsync -a --relative --partial --info=progress2 ${dry} ${PACK} ${`${target}:${values.dir}/`}`;
if (values['dry-run']) process.exit(0);

console.info('restarting the app so the new folders mount, then asking it what it serves...');
const status = await $`ssh ${target} ${'sudo systemctl restart aero-app && for i in $(seq 1 30); do curl -sf http://127.0.0.1:3000/api/status && exit 0; sleep 2; done; exit 1'}`.json();
console.info(status);
const missing = ['tiles/imagery', 'tiles/terrain', 'tiles/lights', 'buildings', 'roads', 'models'].filter((route) => !status.data?.includes(route));
if (missing.length) throw new Error(`the device does not serve: ${missing.map((r) => `/${r}`).join(', ')}`);
console.info('ok: the device serves every aero-3 data route');
