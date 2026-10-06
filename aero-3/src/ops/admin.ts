/** The /admin page: one form that pushes a wall (src/ops/wall.ts). The token stays in the form, never in storage. */
import { PLACES, placeName } from '#flight/places.ts';
import { hhmm } from '#world/sky/ephemeris.ts';
import { REGIME_NAMES } from '#flight/weather.ts';
import { fetchWall, PRESETS, type Wall } from './wall.ts';
import { listMedia, parseIdList, parseMediaId, uploadMedia } from './media.ts';
import { CREDITS } from '#cabin/credits.ts';
import { STALE_SEC, type FleetRow } from './fleet.ts';

const form = document.querySelector('form')!;
const status = document.querySelector('output')!;
const [preset, place, weather] = ['preset', 'place', 'weather'].map((n) => form.elements.namedItem(n)) as HTMLSelectElement[];
const clockInput = form.elements.namedItem('clock') as HTMLInputElement;
const gainNames = ['street', 'building', 'far', 'haze', 'glow'] as const;
const gainInputs = gainNames.map((n) => form.elements.namedItem(n) as HTMLInputElement);
const fillGains = (g: Wall['gains']) => gainInputs.forEach((input, i) => {
	const v = (g ?? {})[gainNames[i]!];
	input.value = v === null || v === undefined ? '' : String(v);
});
place!.add(new Option('Rotation (a new city every 10 min)', ''));
for (const id of Object.keys(PLACES)) place!.add(new Option(placeName(id), id));
weather!.add(new Option("Today's weather", ''));
for (const name of REGIME_NAMES) weather!.add(new Option(name, name));

/** Empty means default; a set gain replaces the pane's own (wall.ts: override, never multiply). */
const gainText = (g: Wall['gains']) => {
	const parts = (Object.entries(g ?? {}) as [string, number | null][]).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v}`);
	return parts.length ? `, gains ${parts.join(' ')}` : '';
};

const audioInput = form.elements.namedItem('audio') as HTMLInputElement;
const videoInput = form.elements.namedItem('video') as HTMLInputElement;

/** Empty means silent flight; a set track list replaces the cabin drone. */
const mediaText = (m: Wall['media']) => {
	const parts: string[] = [];
	if (m && m.audio.length) parts.push(`${m.audio.length} track${m.audio.length > 1 ? 's' : ''} (${m.audio.join(', ')})`);
	if (m && m.video) parts.push(`video ${m.video}`);
	return parts.length ? `, ${parts.join(', ')}` : '';
};

const describe = (w: Wall) =>
	w.version
		? `Wall v${w.version}: ${w.place ?? 'rotation'}, ${w.weather ?? "today's weather"}, ${w.clock === null ? 'real time' : `${hhmm(w.clock)} local`}${gainText(w.gains)}${mediaText(w.media)}`
		: 'Nothing pushed yet: panes follow the rotation.';

const current = await fetchWall('');
status.textContent = describe(current);
place!.value = current.place ?? '';
weather!.value = current.weather ?? '';
clockInput.value = current.clock === null ? '' : String(current.clock);
fillGains(current.gains);
audioInput.value = (current.media?.audio ?? []).join(', ');
videoInput.value = current.media?.video ?? '';

// A preset only fills the form: the operator still reviews it and presses Push.
preset!.add(new Option('Choose a scene…', ''));
for (const name of Object.keys(PRESETS)) preset!.add(new Option(name, name));
preset!.addEventListener('change', () => {
	const scene = PRESETS[preset!.value];
	if (!scene) return;
	place!.value = scene.place ?? '';
	weather!.value = scene.weather ?? '';
	clockInput.value = scene.clock === null ? '' : String(scene.clock);
	fillGains(scene.gains);
	audioInput.value = (scene.media?.audio ?? []).join(', ');
	videoInput.value = scene.media?.video ?? '';
});

form.addEventListener('submit', async (event) => {
	event.preventDefault();
	const data = new FormData(form);
	const clock = String(data.get('clock') ?? '');
	const numOrNull = (name: string) => {
		const raw = String(data.get(name) ?? '');
		return raw === '' ? null : Number(raw);
	};
	const res = await fetch('/api/wall', {
		method: 'POST',
		headers: { Authorization: `Bearer ${data.get('token')}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			place: data.get('place') || null,
			weather: data.get('weather') || null,
			clock: clock === '' ? null : Number(clock),
			gains: { street: numOrNull('street'), building: numOrNull('building'), far: numOrNull('far'), haze: numOrNull('haze'), glow: numOrNull('glow') },
			media: { audio: parseIdList(String(data.get('audio') ?? '')), video: parseMediaId(String(data.get('video') ?? '')) }
		})
	});
	if (!res.ok) {
		status.textContent = `Not pushed: ${await res.text()}`;
		return;
	}
	const wall = (await res.json()) as Wall;
	status.textContent = `Pushed. ${describe(wall)}\nPanes change over at ${new Date(wall.applyAt * 1000).toLocaleTimeString()}.`;
});

/** The store as attach buttons: Audio appends to the playlist, Video pins the clip. Built with textContent. */
async function showLibrary() {
	const host = document.querySelector('#library')!;
	const names = await listMedia('');
	host.replaceChildren();
	if (!names.length) {
		host.append(Object.assign(document.createElement('li'), { textContent: 'Empty: upload the first track below.' }));
		return;
	}
	for (const name of names) {
		const li = document.createElement('li');
		li.append(Object.assign(document.createElement('span'), { textContent: name }));
		for (const [label, attach] of [['Audio', () => (audioInput.value = parseIdList(`${audioInput.value},${name}`).join(', '))], ['Video', () => (videoInput.value = name)]] as const) {
			const button = Object.assign(document.createElement('button'), { textContent: label, type: 'button' });
			button.addEventListener('click', attach);
			li.append(' ', button);
		}
		host.append(li);
	}
}
showLibrary();

document.querySelector('#upload')!.addEventListener('submit', async (event) => {
	event.preventDefault();
	const upload = event.target as HTMLFormElement;
	const data = new FormData(upload);
	const file = data.get('file');
	if (!(file instanceof File) || !file.size) {
		status.textContent = 'Not uploaded: choose a file first.';
		return;
	}
	const token = String(new FormData(form).get('token') ?? '');
	try {
		const name = await uploadMedia(file, token);
		status.textContent = `Uploaded ${name}: attach it above, then push.`;
		upload.reset();
		showLibrary();
	} catch (e) {
		status.textContent = `Not uploaded: ${e instanceof Error ? e.message : e}`;
	}
});

document.querySelector('footer')!.textContent = CREDITS.join(' · ');

/** The panes' heartbeats as a table. Built with textContent: the fields come from the network. */
async function showFleet() {
	const rows = (await fetch('/api/fleet/heartbeat').then((r) => (r.ok ? r.json() : [])).catch(() => [])) as FleetRow[];
	if (!rows.length) return;
	const table = document.createElement('table');
	const line = (cells: string[], tag: 'th' | 'td', cls = '') => {
		const tr = table.insertRow();
		tr.className = cls;
		for (const c of cells) tr.appendChild(document.createElement(tag)).textContent = c;
	};
	line(['Pane', 'fps', '°C', 'Up', 'Seen', 'Commit', 'Note'], 'th');
	const now = Date.now();
	for (const r of rows.sort((a, b) => a.role.localeCompare(b.role))) {
		const ago = Math.round((now - r.receivedAt) / 1000);
		const skew = r.clockMs ? Math.round((r.clockMs - r.receivedAt) / 1000) : 0;
		const note = [r.thermalAction !== 'ok' && r.thermalAction, Math.abs(skew) > 2 && `clock ${skew > 0 ? '+' : ''}${skew}s`, r.crashCount && `${r.crashCount} restarts`, r.lastError].filter(Boolean).join(' · ');
		line([`${r.role || '?'} ${r.deviceId}`, r.fps.toFixed(1), r.temp.toFixed(0), `${Math.round(r.uptime / 3600)} h`, ago < 60 ? 'now' : `${Math.round(ago / 60)} min ago`, r.commit.slice(0, 8), note], 'td', ago > STALE_SEC ? 'stale' : '');
	}
	document.querySelector('#fleet')!.replaceChildren(table);
}
showFleet();
setInterval(showFleet, 30_000);
