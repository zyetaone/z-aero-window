/**
 * The cabin around the glass, as plain DOM over the canvas (index.html holds
 * the CSS): the window rim darkening with the light, rain beads on rainy days,
 * and the blind. The blind starts closed in the markup, so a reload paints it
 * first; it lifts once the scene has drawn a few frames and the visit is past
 * its first seconds, and it comes down ahead of every slot boundary, where
 * main.ts reloads into the next visit. All of it from the wall clock.
 */
import { qrSvg } from '../../aero-2/src/lib/qr.ts';
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

/**
 * The cabin's sound: aero-2's synthesised drone (media/ambient-audio.ts), looped
 * noise through a low-pass whose cutoff falls as the aircraft climbs. No files.
 * A kiosk Chromium runs with autoplay allowed; anywhere else the first tap starts it.
 */
export function cabinDrone(volume = 0.6) {
	const ctx = new AudioContext();
	const gain = ctx.createGain();
	gain.gain.value = volume * 0.35;
	const filter = Object.assign(ctx.createBiquadFilter(), { type: 'lowpass' as const });
	filter.Q.value = 2.5;
	const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
	const data = buffer.getChannelData(0);
	for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1; // ponytail: unsynced across panes, and inaudibly so
	const noise = Object.assign(ctx.createBufferSource(), { buffer, loop: true });
	noise.connect(filter).connect(gain).connect(ctx.destination);
	noise.start();
	addEventListener('pointerdown', () => ctx.resume(), { once: true });
	return {
		/** Lower and duller as the aircraft climbs: 220 Hz on the ground to 110 Hz at 12 km. */
		setAltitude(altitudeM: number) {
			filter.frequency.setTargetAtTime(220 - Math.min(1, Math.max(0, altitudeM / 12_000)) * 110, ctx.currentTime, 0.5);
		}
	};
}

/**
 * aero-2's admin QR: hold the glass for 15 s and the wall Pi's /admin appears as a
 * QR code for a phone. A long press because the wall is public (nobody does it
 * by accident); a LAN address, not a secret, because /admin's pushes still need
 * the token. Tap to dismiss; it also leaves on its own after a minute.
 */
export function adminQr(wallOrigin: string) {
	const HOLD_MS = 15_000;
	const [hold, qr] = [document.querySelector<HTMLElement>('#hold')!, document.querySelector<HTMLElement>('#qr')!];
	let [started, timer] = [0, 0];
	const stop = () => {
		cancelAnimationFrame(timer);
		hold.hidden = true;
	};
	const ring = () => {
		const p = (performance.now() - started) / HOLD_MS;
		hold.style.setProperty('--p', Math.min(1, p).toFixed(3));
		if (p < 1) timer = requestAnimationFrame(ring);
		else (stop(), show());
	};
	async function show() {
		const status = await fetch(`${wallOrigin}/api/status`).then((r) => r.json()).catch(() => null);
		const url = status?.lan ? `http://${status.lan}:${status.port}/admin` : null;
		qr.querySelector('div')!.innerHTML = url ? qrSvg(url) : ''; // qrSvg builds the SVG from our own URL: no outside markup
		qr.querySelector('p')!.textContent = url ?? 'This wall has no LAN address to show.';
		qr.hidden = false;
		setTimeout(() => (qr.hidden = true), 60_000);
	}
	addEventListener('pointerdown', (e) => {
		if (!qr.hidden) return void (qr.hidden = true);
		if (e.target instanceof Element && e.target.closest('#hud')) return;
		started = performance.now();
		hold.hidden = false;
		timer = requestAnimationFrame(ring);
	});
	for (const end of ['pointerup', 'pointercancel', 'pointerleave'] as const) addEventListener(end, stop);
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
