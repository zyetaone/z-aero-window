/** The /admin page: one form that pushes a wall (src/wall.ts). The token stays in the form, never in storage. */
import { PLACES } from './places.ts';
import { REGIME_NAMES } from './day.ts';
import { fetchWall, PRESETS, type Wall } from './wall.ts';

const form = document.querySelector('form')!;
const status = document.querySelector('output')!;
const [preset, place, weather] = ['preset', 'place', 'weather'].map((n) => form.elements.namedItem(n)) as HTMLSelectElement[];
const clockInput = form.elements.namedItem('clock') as HTMLInputElement;
place!.add(new Option('Rotation (a new city every 10 min)', ''));
for (const id of Object.keys(PLACES)) place!.add(new Option(id.replace('_', ' '), id));
weather!.add(new Option("Today's weather", ''));
for (const name of REGIME_NAMES) weather!.add(new Option(name, name));

const describe = (w: Wall) =>
	w.version ? `Wall v${w.version}: ${w.place ?? 'rotation'}, ${w.weather ?? "today's weather"}, ${w.clock === null ? 'real time' : `${Math.floor(w.clock)}:${String(Math.round((w.clock % 1) * 60)).padStart(2, '0')} local`}` : 'Nothing pushed yet: panes follow the rotation.';

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
