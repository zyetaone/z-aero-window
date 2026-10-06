/**
 * The cabin around the glass, as plain DOM over the canvas (index.html holds
 * the CSS): the window rim darkening with the light, rain beads on rainy days,
 * and the blind. The blind starts closed in the markup, so a reload paints it
 * first; it lifts once the scene has drawn a few frames and the visit is past
 * its first seconds, and it comes down ahead of every slot boundary, where
 * main.ts reloads into the next visit. All of it from the wall clock.
 */
import { CREDITS } from './credits.ts';
import { qrSvg } from './qr.ts';
import { mulberry32 } from '#math.ts';
import { DWELL_SEC, PLACES, placeName } from '#flight/places.ts';
import { hhmm, solarHour } from '#world/sky/ephemeris.ts';

const BLIND_LEAD_SEC = 6; // down this long before the boundary
const LAG_SEC = 12; // and up no sooner than this after it, so panes lift together
const READY_FRAMES = 30; // and not before the scene has drawn this many frames

/**
 * `pane` seeds this window's rain. `openAfter` (wall seconds) is the wall push this page loaded into:
 * the blind lifts LAG_SEC after the later of it and the slot start, so after a push every pane
 * reveals on the same second rather than whenever its own scene finished building.
 */
export function cabinOverlay(blinds: boolean, rain: boolean, place: string, lon: number, pane: number, openAfter = 0) {
	const [blind, drops] = ['#blind', '#rain'].map((s) => document.querySelector<HTMLElement>(s)!) as [HTMLElement, HTMLElement];
	const clockEl = document.querySelector<HTMLElement>('#clock')!;
	blind.hidden = !blinds;
	blind.querySelector('span')!.textContent = placeName(place);
	blind.querySelector('small')!.textContent = CREDITS.join(' · '); // on the blind only: the open window stays a window
	clockEl.querySelector('span')!.textContent = placeName(place); // the tap clock (loneGestures): same visit, same city
	if (rain) beads(drops, pane);

	let [frames, last, held, night, clock] = [0, 0, false, '', ''];
	return {
		/** Down now and stay down: a wall push is about to reload the page. */
		hold() {
			held = true;
			blind.classList.remove('open');
		},
		/** Once per frame; touches the DOM four times a second at most. */
		update(wallSec: number, dark: number, skyMs = wallSec * 1000) {
			if (++frames < READY_FRAMES || wallSec - last < 0.25 || held) return;
			last = wallSec;
			// Steps of 0.05, and only on change: each write repaints the full-pane rim and rain.
			const n = (Math.round(dark * 20) / 20).toFixed(2);
			if (n !== night) document.documentElement.style.setProperty('--night', (night = n));
			const phase = ((wallSec % DWELL_SEC) + DWELL_SEC) % DWELL_SEC;
			const since = wallSec - Math.max(wallSec - phase, openAfter);
			blind.classList.toggle('open', phase < DWELL_SEC - BLIND_LEAD_SEC && since >= LAG_SEC);
			const hour = solarHour(skyMs, lon); // the sky's hour: a pinned clock shows its own time, not the wall's
			const t = hhmm(hour);
			if (t !== clock) {
				clock = t;
				blind.querySelector('time')!.textContent = t;
				clockEl.querySelector('time')!.textContent = `${t} local`;
			}
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
	let [started, timer, x0, y0] = [0, 0, 0, 0];
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
	addEventListener('pointerdown', (e: PointerEvent) => {
		if (!qr.hidden) {
			// A tap on the code keeps it up for aiming the phone; outside it drops.
			if (e.target instanceof Element && e.target.closest('#qr')) return;
			qr.hidden = true;
			return;
		}
		if (e.target instanceof Element && e.target.closest('#hud')) return;
		started = performance.now();
		[x0, y0] = [e.clientX, e.clientY];
		hold.hidden = false;
		timer = requestAnimationFrame(ring);
	});
	// A drag is looking around, not a hold.
	addEventListener('pointermove', (e: PointerEvent) => !hold.hidden && Math.hypot(e.clientX - x0, e.clientY - y0) > 12 && stop());
	for (const end of ['pointerup', 'pointercancel', 'pointerleave'] as const) addEventListener(end, stop);
}

/** A downward pull commits to a new place past this many px; less springs back. */
export const BLIND_DEPART_PX = 120;

/** Past the depart threshold (and downward): the finger has voted for a new city. */
export const dragCommits = (dyPx: number) => dyPx > BLIND_DEPART_PX;

/**
 * Pure: a different place for a blind-drag departure. Lone pane only, so an
 * unsynced draw is fine (the cabin drone rolls its own noise the same way).
 */
export function pickOtherPlace(ids: readonly string[], current: string | null, u: number): string {
	const pool = ids.filter((id) => id !== current);
	if (!pool.length) return current ?? ids[0] ?? '';
	return pool[Math.min(pool.length - 1, Math.floor(u * pool.length))]!;
}

/**
 * Lone-pane glass gestures (main.ts calls this only without `?role=`): a downward
 * drag pulls the open blind with the finger and, past BLIND_DEPART_PX, departs for
 * a different place (`?place=` reload, the placePicker pattern); a tap toggles the
 * clock overlay. Never on a wall pane: a departure would split the wall, and only
 * /admin pushes shared state. HUD and QR gestures keep priority: drags and taps
 * starting in #hud are ignored, and a tap that dismisses the QR never toggles.
 */
export function loneGestures(currentPlace: string) {
	const blind = document.querySelector<HTMLElement>('#blind')!;
	const clockEl = document.querySelector<HTMLElement>('#clock')!;
	const qr = document.querySelector<HTMLElement>('#qr')!;
	let [x0, y0, t0, dragging, suppressTap] = [0, 0, 0, false, false];
	const onGlass = (e: PointerEvent) => !(e.target instanceof Element && e.target.closest('#hud'));

	addEventListener('pointerdown', (e: PointerEvent) => {
		if (!onGlass(e)) return;
		[x0, y0, t0, dragging, suppressTap] = [e.clientX, e.clientY, performance.now(), false, !qr.hidden];
	});
	addEventListener('pointermove', (e: PointerEvent) => {
		if (!t0) return;
		if (e.pointerType === 'mouse' && e.buttons === 0) {
			t0 = 0; // a hover, not a drag: the button came up outside the window
			blind.style.transform = '';
			return;
		}
		if (!onGlass(e)) return;
		const dy = e.clientY - y0;
		if (!dragging) {
			if (Math.hypot(e.clientX - x0, dy) <= 12) return; // still a possible tap or QR hold
			dragging = true;
		}
		// Follow the finger down only: up, or a closed blind, springs back to the CSS pose.
		blind.style.transform = dy > 0 && blind.classList.contains('open') ? `translateY(calc(-101% + ${Math.min(dy, innerHeight)}px))` : '';
	});
	const end = (e: PointerEvent) => {
		if (!t0) return;
		const [dy, dt, wasDrag, suppress] = [e.clientY - y0, performance.now() - t0, dragging, suppressTap];
		[t0, dragging, suppressTap] = [0, false, false];
		blind.style.transform = ''; // the CSS transition springs it back (or the reload takes it)
		if (!onGlass(e)) return;
		if (wasDrag) {
			if (dragCommits(dy) && blind.classList.contains('open')) {
				const next = pickOtherPlace(Object.keys(PLACES), currentPlace, Math.random());
				if (next && next !== currentPlace) {
					const url = new URL(location.href);
					url.searchParams.set('place', next);
					location.assign(url);
				}
			}
			return;
		}
		if (dt < 400 && !suppress) clockEl.hidden = !clockEl.hidden;
	};
	for (const endOf of ['pointerup', 'pointercancel'] as const) addEventListener(endOf, end);
}

/**
 * Rain on the glass. Still drops are painted once to a canvas, so they cost nothing per frame:
 * mostly tiny, a few large, gathered in clusters the way water beads on a window, each shaded as
 * a lens (dark above, bright rim below, one glint). A handful run down with a trail. Seeded per
 * pane, so neighbouring windows do not rain in the same places.
 */
function beads(host: HTMLElement, seed: number) {
	const r = mulberry32(104729 ^ seed);
	const between = (a: number, b: number) => a + r() * (b - a);
	const dpr = Math.min(2, devicePixelRatio || 1);
	const canvas = Object.assign(document.createElement('canvas'), { width: innerWidth * dpr, height: innerHeight * dpr });
	const ctx = canvas.getContext('2d')!;
	ctx.scale(dpr, dpr);
	const centres = Array.from({ length: 10 }, () => [between(0.05, 0.95) * innerWidth, between(0.05, 0.95) * innerHeight] as const);
	for (let i = 0; i < 180; i++) {
		// Two in three drops sit in a cluster, the rest anywhere; radius skewed small.
		const [cx, cy] = r() < 0.66 ? centres[Math.floor(r() * centres.length)]! : [r() * innerWidth, r() * innerHeight];
		const spread = r() < 0.66 ? 90 : 0;
		const [x, y] = [cx + (r() + r() - 1) * spread, cy + (r() + r() - 1) * spread];
		const rad = 0.8 + 6 * r() ** 3;
		const [rx, ry] = [rad, rad * between(1, 1.2)];
		const body = ctx.createLinearGradient(0, y - ry, 0, y + ry);
		body.addColorStop(0, 'rgba(8,12,20,0.30)');
		body.addColorStop(0.6, 'rgba(255,255,255,0.04)');
		body.addColorStop(1, 'rgba(255,255,255,0.22)');
		ctx.fillStyle = body;
		ctx.beginPath();
		ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = 'rgba(255,255,255,0.45)'; // the rim catching light from below
		ctx.lineWidth = Math.max(0.5, rad * 0.16);
		ctx.beginPath();
		ctx.ellipse(x, y, rx * 0.86, ry * 0.86, 0, Math.PI * 0.15, Math.PI * 0.85);
		ctx.stroke();
		if (rad > 1.6) {
			ctx.fillStyle = 'rgba(255,255,255,0.75)'; // one glint
			ctx.beginPath();
			ctx.arc(x - rx * 0.35, y - ry * 0.4, Math.max(0.5, rad * 0.18), 0, Math.PI * 2);
			ctx.fill();
		}
	}
	host.append(canvas);
	for (let i = 0; i < 5; i++) {
		const bead = document.createElement('span');
		Object.assign(bead.style, { left: `${between(5, 95)}%`, top: `${between(0, 60)}%` });
		for (const [k, v] of Object.entries({
			'--s': `${between(7, 12)}px`,
			'--o': between(0.6, 0.9).toFixed(2),
			'--slide': `${between(80, 260)}px`,
			'--drift': `${between(-40, 40)}px`,
			'--dur': `${between(14, 26)}s`,
			'--delay': `${-between(0, 26)}s`
		}))
			bead.style.setProperty(k, v);
		host.append(bead);
	}
	host.hidden = false;
}
