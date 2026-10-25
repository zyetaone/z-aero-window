import { describe, it, expect, beforeEach } from 'vitest';
import { publish, subscribe, subscriberCount, replayTo, bufferSize, clearBuffer, type SseEvent } from '$lib/server/fleet/sse-bus';

describe('sse-bus', () => {
	// The bus is module-scope, shared across tests. Each test cleans up its
	// own subscriptions in the individual `it` body — there's no reset hook
	// exported (and we don't want one: the subscriber set IS the truth).
	beforeEach(() => {
		expect(subscriberCount()).toBe(0);
		clearBuffer();
	});

	it('publish with no subscribers is a no-op', () => {
		expect(() => publish({ type: 'x', data: {} })).not.toThrow();
	});

	it('subscribe returns an unsubscribe that decrements count', () => {
		const unsubscribe = subscribe(() => {});
		expect(subscriberCount()).toBe(1);
		unsubscribe();
		expect(subscriberCount()).toBe(0);
	});

	it('publish fans out to every current subscriber', () => {
		const received: SseEvent[][] = [[], [], []];
		const unsubs = received.map((_, i) => subscribe((ev) => { received[i].push(ev); }));
		const event: SseEvent = { type: 'config_patch', data: { path: 'x.y', value: 1 } };

		publish(event);

		for (const log of received) {
			expect(log).toHaveLength(1);
			expect(log[0]).toEqual(event);
		}
		unsubs.forEach((u) => u());
	});

	it('one throwing subscriber does not block others', () => {
		const received: SseEvent[] = [];
		const unsubA = subscribe(() => { throw new Error('boom'); });
		const unsubB = subscribe((ev) => { received.push(ev); });

		const event: SseEvent = { type: 'ping', data: null };
		expect(() => publish(event)).not.toThrow();
		expect(received).toEqual([event]);

		unsubA();
		unsubB();
	});

	it('unsubscribe only removes the matching callback', () => {
		const aReceived: SseEvent[] = [];
		const bReceived: SseEvent[] = [];
		const unsubA = subscribe((ev) => { aReceived.push(ev); });
		const unsubB = subscribe((ev) => { bReceived.push(ev); });

		publish({ type: '1', data: null });
		unsubA();
		publish({ type: '2', data: null });

		expect(aReceived).toHaveLength(1);
		expect(bReceived).toHaveLength(2);

		unsubB();
	});

	describe('event buffer', () => {
		beforeEach(() => clearBuffer());

		it('buffers config_patch events', () => {
			publish({ type: 'config_patch', data: { path: 'a', value: 1 } });
			expect(bufferSize()).toBe(1);
		});

		it('buffers command events', () => {
			publish({ type: 'command', data: { type: 'set_scene', location: 'dubai' } });
			expect(bufferSize()).toBe(1);
		});

		it('does not buffer non-replayable events', () => {
			publish({ type: 'ping', data: null });
			expect(bufferSize()).toBe(0);
		});

		it('replayTo delivers buffered events in insertion order', () => {
			publish({ type: 'config_patch', data: { path: 'a', value: 1 } });
			publish({ type: 'command', data: { type: 'set_scene' } });
			publish({ type: 'config_patch', data: { path: 'b', value: 2 } });

			const received: SseEvent[] = [];
			replayTo((ev) => received.push(ev));

			expect(received).toHaveLength(3);
			expect(received[0]).toEqual({ type: 'config_patch', data: { path: 'a', value: 1 } });
			expect(received[1]).toEqual({ type: 'command', data: { type: 'set_scene' } });
			expect(received[2]).toEqual({ type: 'config_patch', data: { path: 'b', value: 2 } });
		});

		it('replayTo replays all config patches and the latest command of each kind', () => {
			publish({ type: 'command', data: { type: 'set_scene', location: 'dubai' } });
			publish({ type: 'config_patch', data: { path: 'a', value: 1 } });
			publish({ type: 'command', data: { type: 'set_scene', location: 'london' } });
			publish({ type: 'config_patch', data: { path: 'b', value: 2 } });
			publish({ type: 'command', data: { type: 'set_mode', mode: 'night' } });

			const received: SseEvent[] = [];
			replayTo((ev) => received.push(ev));

			// The stale set_scene (dubai) is dropped; london survives set_mode, so a
			// browser that reloads after a hop lands on the hop, not the boot city.
			expect(received).toHaveLength(4);
			expect(received[0]).toEqual({ type: 'config_patch', data: { path: 'a', value: 1 } });
			expect(received[1]).toEqual({ type: 'command', data: { type: 'set_scene', location: 'london' } });
			expect(received[2]).toEqual({ type: 'config_patch', data: { path: 'b', value: 2 } });
			expect(received[3]).toEqual({ type: 'command', data: { type: 'set_mode', mode: 'night' } });
		});

		it('ring buffer evicts oldest when capacity exceeded', () => {
			// Fill past BUFFER_SIZE (32).
			for (let i = 0; i < 40; i++) {
				publish({ type: 'config_patch', data: { path: 'x', value: i } });
			}
			expect(bufferSize()).toBe(32);

			// First 8 should have been evicted; buffer holds 8..39.
			const received: SseEvent[] = [];
			replayTo((ev) => received.push(ev));
			expect(received).toHaveLength(32);
			expect((received[0].data as { value: number }).value).toBe(8);
			expect((received[31].data as { value: number }).value).toBe(39);
		});

		it('clearBuffer empties the buffer', () => {
			publish({ type: 'config_patch', data: { path: 'a', value: 1 } });
			expect(bufferSize()).toBe(1);
			clearBuffer();
			expect(bufferSize()).toBe(0);
		});
	});
});
