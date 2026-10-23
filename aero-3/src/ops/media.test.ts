import { expect, test } from 'bun:test';
import { listMedia, mediaUrl, parseIdList, parseMediaId } from './media.ts';
import { playheadAt } from '#cabin/media.ts';

test('IDs are bare store names, never paths or URLs', () => {
	expect(parseMediaId('dawn-chorus.mp3')).toBe('dawn-chorus.mp3');
	expect(parseMediaId('  clip01.ogg  ')).toBe('clip01.ogg');
	expect(parseMediaId('/api/media/x.mp3')).toBeNull();
	expect(parseMediaId('https://cdn.example/x.mp3')).toBeNull();
	expect(parseMediaId('../wall.json')).toBeNull();
	expect(parseMediaId('.hidden.mp3')).toBeNull();
	expect(parseMediaId('no-extension')).toBe('no-extension'); // the store, not the wall, enforces extensions
	expect(parseMediaId(7)).toBeNull();
});

test('an admin text field becomes a short deduped ID list', () => {
	expect(parseIdList('a.mp3, b.ogg ,a.mp3,,')).toEqual(['a.mp3', 'b.ogg']);
	expect(parseIdList('')).toEqual([]);
	expect(parseIdList(Array.from({ length: 20 }, (_, i) => `${i}.mp3`).join(','))).toHaveLength(8);
});

test('IDs resolve against the wall origin, never the pane', () => {
	expect(mediaUrl('', 'a.mp3')).toBe('/media/a.mp3');
	expect(mediaUrl('http://10.0.0.2:3300', 'a.mp3')).toBe('http://10.0.0.2:3300/media/a.mp3');
	expect(mediaUrl('http://10.0.0.2:3300', 'a b.mp3')).toBe('http://10.0.0.2:3300/media/a%20b.mp3');
});

test('an unreachable store lists nothing: panes never wait on it', async () => {
	expect(await listMedia('http://127.0.0.1:9')).toEqual([]);
});

test('a clip on the wall clock: three panes seed the same frame, and no duration means no seek', () => {
	expect(playheadAt(30, 12)).toBeCloseTo(6);
	expect(playheadAt(1_000_030, 12)).toBe(playheadAt(1_000_030, 12));
	expect(playheadAt(5, 12)).toBe(5);
	expect(playheadAt(100, NaN)).toBeNull();
	expect(playheadAt(100, 0)).toBeNull();
});
