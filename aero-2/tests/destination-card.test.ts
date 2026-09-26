import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The PRD's visitor promise: a deliberate tap reveals a brief destination
 * card; it dismisses on a second tap or on its own; the window never keeps a
 * dashboard. Source-level, because the contract is in the wiring: the card
 * must be mounted behind the gesture flag and must own its own timeout.
 */
describe('destination card', () => {
	const display = readFileSync('src/lib/display/Display.svelte', 'utf8');
	const card = readFileSync('src/lib/display/cabin/DestinationCard.svelte', 'utf8');

	it('is revealed by the double-tap and mounted only while shown', () => {
		expect(display).toMatch(/onDoubleTap: \(\) => \(cardVisible = !cardVisible\)/);
		expect(display).toMatch(/\{#if cardVisible\}\s*<DestinationCard ondismiss=/);
	});

	it('dismisses itself, and soon: no persistent dashboard', () => {
		const m = /CARD_TIMEOUT_MS = ([\d_]+)/.exec(card);
		expect(m, 'timeout constant').not.toBeNull();
		const ms = Number(m![1].replace(/_/g, ''));
		expect(ms).toBeGreaterThanOrEqual(5_000);
		expect(ms).toBeLessThanOrEqual(20_000);
		expect(card).toMatch(/setTimeout\(ondismiss, CARD_TIMEOUT_MS\)/);
		expect(card).toMatch(/clearTimeout\(id\)/);
	});

	it('names the weather source, because the deck is a schedule not a forecast', () => {
		expect(card).toMatch(/scheduled, not a forecast/);
		expect(card).toMatch(/set by the operator/);
	});

	it('reads destination time from the flown pose, never a second clock', () => {
		expect(card).toMatch(/display\.view\.timeOfDay/);
		expect(card).not.toMatch(/timeZone/);
		// zone label composes the same offset as the clock beside it (Hud parity)
		expect(card).toMatch(/place\.utcOffset \+ display\.config\.clockOffsetH/);
		expect(card).not.toMatch(/utcOffsetAt/);
	});
});
