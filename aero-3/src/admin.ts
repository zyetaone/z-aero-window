/** The /admin page: one form that pushes a wall (src/wall.ts). The token stays in the form, never in storage. */
import { PLACES, placeName } from './places.ts';
import { hhmm } from './sun.ts';
import { REGIME_NAMES } from './day.ts';
import { fetchWall, PRESETS, type Wall } from './wall.ts';
import { CREDITS } from './credits.ts';
import { STALE_SEC, type FleetRow } from './fleet.ts';

const form = document.querySelector('form')!;
const status = document.querySelector('output')!;
const [preset, place, weather] = ['preset', 'place', 'weather'].map((n) => form.elements.namedItem(n)) as HTMLSelectElement[];
const clockInput = form.elements.namedItem('clock') as HTMLInputElement;
place!.add(new Option('Rotation (a new city every 10 min)', ''));
for (const id of Object.keys(PLACES)) place!.add(new Option(placeName(id), id));
weather!.add(new Option("Today's weather", ''));
for (const name of REGIME_NAMES) weather!.add(new Option(name, name));

const describe = (w: Wall) =>
	w.version ? `Wall v${w.version}: ${w.place ?? 'rotation'}, ${w.weather ?? "today's weather"}, ${w.clock === null ? 'real time' : `${hhmm(w.clock)} local`}` : 'Nothing pushed yet: panes follow the rotation.';

const current = await fetchWall('');
status.textContent = describe(current);
place!.value = current.place ?? '';
weather!.value = current.weather ?? '';
clockInput.value = current.clock === null ? '' : String(current.clock);

// A preset only fills the form: the operator still reviews it and presses Push.
preset!.add(new Option('Choose a scene…', ''));
for (const name of Object.keys(PRESETS)) preset!.add(new Option(name, name));
preset!.addEventListener('change', () => {
	const scene = PRESETS[preset!.value];
	if (!scene) return;
	place!.value = scene.place ?? '';
	weather!.value = scene.weather ?? '';
	clockInput.value = scene.clock === null ? '' : String(scene.clock);
});

form.addEventListener('submit', async (event) => {
	event.preventDefault();
	const data = new FormData(form);
	const clock = String(data.get('clock') ?? '');
	const res = await fetch('/api/wall', {
		method: 'POST',
		headers: { Authorization: `Bearer ${data.get('token')}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ place: data.get('place') || null, weather: data.get('weather') || null, clock: clock === '' ? null : Number(clock) })
	});
	if (!res.ok) {
		status.textContent = `Not pushed: ${await res.text()}`;
		return;
	}
	const wall = (await res.json()) as Wall;
	status.textContent = `Pushed. ${describe(wall)}\nPanes change over at ${new Date(wall.applyAt * 1000).toLocaleTimeString()}.`;
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
