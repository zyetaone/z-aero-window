/**
 * Smoke test: does the window actually build, by day and by night, in every place?
 *
 *   bun run smoke                 # every place; screenshots land in dist/smoke/
 *   bun run smoke dubai mumbai    # just these
 *
 * Starts the real server on a spare port, opens the page in Bun's native
 * WebView at a pinned noon and a pinned night, waits for the render loop, and
 * checks every layer made it into the scene — ground, far ring, buildings,
 * lamps, clouds, stars — plus that day/night switching flips the lamps and the
 * bloom. A boot that throws never starts the loop, so it fails here as a
 * timeout instead of as a black wall nobody notices.
 *
 * Headless WebKit renders on the CPU and caps near 30 fps: the fps line is a
 * liveness check, not a performance number. Measure on a Pi for that.
 */
const root = `${import.meta.dir}/..`;
const port = 3390 + Math.floor(Math.random() * 9);
const server = Bun.spawn(['bun', 'server.ts'], { cwd: root, env: { ...process.env, PORT: String(port) }, stdout: 'ignore', stderr: 'pipe' });
await Bun.sleep(1500);

type Check = [name: string, ok: boolean, detail: string];
const results: Check[] = [];
const scene = (expr: string) => `(() => { try { return JSON.stringify(${expr}) } catch (e) { return JSON.stringify({ error: String(e) }) } })()`;

const { PLACES } = await import('../src/visit/places.ts');
const places = Bun.argv.slice(2).length ? Bun.argv.slice(2) : Object.keys(PLACES);

try {
	for (const place of places)
	for (const [when, clock, night] of [['day', 12, false], ['night', 22, true]] as const) {
		const label = `${place} ${when}`;
		// A place with no OSM pack (the Himalayas) has no buildings and no street lamps to check.
		const city = (await fetch(`http://localhost:${port}/buildings/${place}.geojson`, { method: 'HEAD' })).ok;
		await using view = new Bun.WebView({ width: 1280, height: 540 });
		await view.navigate(`http://localhost:${port}/?place=${place}&clock=${clock}&blind=0&weather=scattered&audio=0&debug`);

		// The HUD readout only fills once the render loop is running.
		const started = Date.now();
		let hud = '';
		while (Date.now() - started < 60_000 && !hud.includes('fps')) {
			await Bun.sleep(500);
			hud = String(await view.evaluate("document.querySelector('output')?.textContent ?? ''"));
		}
		results.push([`${label}: render loop running`, hud.includes('fps'), hud || 'no HUD after 60 s']);
		if (!hud.includes('fps')) continue;
		await Bun.sleep(3000);

		const s = JSON.parse(
			String(
				await view.evaluate(
					scene(`({
						meshes: Object.fromEntries(scene.meshes.map(m => [m.name, { v: m.getTotalVertices(), on: m.isEnabled() }])),
						sprites: scene.spriteManagers.reduce((n, m) => n + m.sprites.length, 0),
						glow: scene.effectLayers[0]?.isEnabled ?? null,
						fps: scene.getEngine().getFps()
					})`)
				)
			)
		);
		const has = (name: string, min: number) => (s.meshes?.[name]?.v ?? 0) >= min;
		results.push(
			[`${label}: near ground`, has('near', 60_000), `${s.meshes?.near?.v} vertices`],
			[`${label}: far ring to the horizon`, has('far', 20_000), `${s.meshes?.far?.v} vertices`],
			[`${label}: buildings`, !city || has('buildings', 10_000), city ? `${s.meshes?.buildings?.v} vertices` : 'no pack'],
			[`${label}: streetlights`, !city || has('streetlights', 10_000), city ? `${s.meshes?.streetlights?.v} lamps` : 'no pack'],
			[`${label}: clouds`, s.sprites > 300, `${s.sprites} puffs`],
			[`${label}: stars`, has('stars', 8000), `${s.meshes?.stars?.v} stars`],
			[`${label}: lamps ${night ? 'on' : 'off'}`, !city || s.meshes?.streetlights?.on === night, `enabled ${s.meshes?.streetlights?.on}`],
			[`${label}: bloom ${night ? 'on' : 'off'}`, s.glow === night, `enabled ${s.glow}`],
			[`${label}: frames drawing`, s.fps > 1, `${Math.round(s.fps)} fps (headless, not a perf number)`]
		);
		await Bun.write(`${root}/dist/smoke/${place}-${when}.png`, await view.screenshot());
	}
} finally {
	server.kill();
}

for (const [name, ok, detail] of results) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(44)} ${detail}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed — screenshots in dist/smoke/`);
process.exit(failed ? 1 : 0);
