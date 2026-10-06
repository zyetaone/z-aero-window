/**
 * The lone-pane HUD (index.html #hud, #lights, #place): a time-of-day slider, the light gains and a
 * place picker. Off on a wall pane (the kiosk URL carries ?role=): a touch on one pane's slider
 * would split the wall.
 */
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine';
import { PLACES, placeName } from '#flight/places.ts';
import { hhmm, solarHour } from '#world/sky/ephemeris.ts';

/** Mounts the panels. `clock.pinned` and `mix` are the render loop's own: the panels write them. */
export function createHud<M extends Record<string, number>>(engine: AbstractEngine, lon: number, clock: { pinned: number | null }, mix: M, pinnedPlace: string | null) {
	placePicker(pinnedPlace);
	lightsPanel(mix);
	return clockControls(engine, lon, clock);
}

/** Rotation follows the wall clock; a city pins it (?place=). Both reload. */
function placePicker(pinnedPlace: string | null) {
	const select = document.querySelector<HTMLSelectElement>('#place')!;
	select.add(new Option('Rotation', ''));
	for (const id of Object.keys(PLACES)) select.add(new Option(placeName(id), id));
	select.value = pinnedPlace ?? '';
	select.addEventListener('change', () => {
		const url = new URL(location.href);
		if (select.value) url.searchParams.set('place', select.value);
		else url.searchParams.delete('place');
		location.assign(url);
	});
}

/** Each slider writes one gain in `mix`, read by the render loop. */
function lightsPanel(mix: Record<string, number>) {
	for (const input of document.querySelectorAll<HTMLInputElement>('#lights input')) {
		input.value = String(mix[input.name]);
		input.addEventListener('input', () => (mix[input.name] = Number(input.value)));
	}
}

/** Drag to pin the sky to an hour, "Now" to follow the real sun again. Returns the 4 Hz readout. */
function clockControls(engine: AbstractEngine, lon: number, clock: { pinned: number | null }) {
	const panel = document.querySelector<HTMLElement>('#hud')!;
	const slider = panel.querySelector<HTMLInputElement>('input')!;
	const [readout, live] = [panel.querySelector('output')!, panel.querySelector('button')!];
	panel.hidden = false;
	slider.addEventListener('input', () => (clock.pinned = Number(slider.value)));
	live.addEventListener('click', () => (clock.pinned = null));
	return (skyMs: number, elevationDeg: number) => {
		const hour = solarHour(skyMs, lon);
		slider.value = String(hour);
		const fps = engine.getFps();
		readout.textContent = `${hhmm(hour)} solar · sun ${elevationDeg.toFixed(0)}° · ${Number.isFinite(fps) ? fps.toFixed(0) : '–'} fps ${engine.isWebGPU ? 'WebGPU' : 'WebGL2'}`;
		live.disabled = clock.pinned === null;
	};
}
