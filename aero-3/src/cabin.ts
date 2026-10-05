/**
 * The cabin around the glass, as plain DOM over the canvas (index.html holds
 * the CSS): the window rim darkening with the light, rain beads on rainy days,
 * and the blind. The blind starts closed in the markup, so a reload paints it
 * first; it lifts once the scene has drawn a few frames and the visit is past
 * its first seconds, and it comes down ahead of every slot boundary, where
 * main.ts reloads into the next visit. All of it from the wall clock.
 */
import { mulberry32 } from './math.ts';
import { DWELL_SEC } from './places.ts';
import { solarHour } from './sun.ts';

const LEAD_SEC = 6; // down this long before the boundary (aero-2's BLIND_LEAD_SEC)
const LAG_SEC = 12; // and up no sooner than this after it, so panes lift together
const READY_FRAMES = 30; // and not before the scene has drawn this many frames

export function cabinOverlay(blinds: boolean, rain: boolean, place: string, lon: number) {
	const [frame, blind, drops] = ['#frame', '#blind', '#rain'].map((s) => document.querySelector<HTMLElement>(s)!) as [HTMLElement, HTMLElement, HTMLElement];
	blind.hidden = !blinds;
	blind.querySelector('span')!.textContent = place.replace('_', ' ');
	if (rain) beads(drops);

	let [frames, last, held] = [0, 0, false];
	return {
		/** Down now and stay down: a wall push is about to reload the page. */
		hold() {
			held = true;
			blind.classList.remove('open');
		},
		/** Once per frame; touches the DOM four times a second at most. */
		update(wallSec: number, dark: number) {
			if (++frames < READY_FRAMES || wallSec - last < 0.25 || held) return;
			last = wallSec;
			frame.style.setProperty('--night', dark.toFixed(2));
			const phase = ((wallSec % DWELL_SEC) + DWELL_SEC) % DWELL_SEC;
			blind.classList.toggle('open', phase < DWELL_SEC - LEAD_SEC && phase >= LAG_SEC);
			const hour = solarHour(wallSec * 1000, lon);
			blind.querySelector('time')!.textContent = `${Math.floor(hour)}`.padStart(2, '0') + ':' + `${Math.floor((hour % 1) * 60)}`.padStart(2, '0');
		}
	};
}

/** aero-2's RainGlass beads (flat variant, no backdrop blur): a fixed seed, so every pane rains alike. */
function beads(host: HTMLElement) {
	const r = mulberry32(104729);
	const between = (a: number, b: number) => a + r() * (b - a);
	for (let i = 0; i < 14; i++) {
		const runner = r() < 0.25;
		const bead = document.createElement('span');
		Object.assign(bead.style, { left: `${between(6, 94)}%`, top: `${between(8, 86)}%` });
		for (const [k, v] of Object.entries({
			'--s': `${between(8, 22)}px`,
			'--o': between(0.5, 0.85).toFixed(2),
			'--slide': `${runner ? between(40, 130) : between(2, 9)}px`,
			'--dur': `${between(7, 15)}s`,
			'--delay': `${-between(0, 12)}s`
		}))
			bead.style.setProperty(k, v);
		host.append(bead);
	}
	host.hidden = false;
}
