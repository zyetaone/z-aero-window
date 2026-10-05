/**
 * Smoke test: does the window actually build, by day and by night?
 *
 *   bun run smoke            # screenshots land in dist/smoke/
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

try {
	for (const [label, clock, night] of [['day', 12, false], ['night', 22, true]] as const) {
		await using view = new Bun.WebView({ width: 1280, height: 540 });
		await view.navigate(`http://localhost:${port}/?place=hyderabad&clock=${clock}&debug`);

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
			[`${label}: buildings`, has('buildings', 100_000), `${s.meshes?.buildings?.v} vertices`],
			[`${label}: streetlights`, has('streetlights', 50_000), `${s.meshes?.streetlights?.v} lamps`],
			[`${label}: clouds`, s.sprites > 300, `${s.sprites} puffs`],
			[`${label}: stars`, has('stars', 8000), `${s.meshes?.stars?.v} stars`],
			[`${label}: lamps ${night ? 'on' : 'off'}`, s.meshes?.streetlights?.on === night, `enabled ${s.meshes?.streetlights?.on}`],
			[`${label}: bloom ${night ? 'on' : 'off'}`, s.glow === night, `enabled ${s.glow}`],
			[`${label}: frames drawing`, s.fps > 1, `${Math.round(s.fps)} fps (headless, not a perf number)`]
		);
		await Bun.write(`${root}/dist/smoke/${label}.png`, await view.screenshot());
	}
} finally {
	server.kill();
}

for (const [name, ok, detail] of results) console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(36)} ${detail}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} failed` : `\nall ${results.length} passed — screenshots in dist/smoke/`);
process.exit(failed ? 1 : 0);
