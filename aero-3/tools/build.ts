/**
 * `bun run build`: the deploy contract (deploy/pi/aero-app.service, aero-updater.sh) is "build
 * writes build/index.js, `bun run serve` runs it". aero-3 has nothing to compile ahead of time:
 * Bun bundles index.html when the server starts. So the build is a two-line entry that starts the
 * server from the app root, where its ../data paths resolve. (A `bun build` server bundle looks its
 * page assets up from the working directory, which then breaks those paths.)
 */
await Bun.write(`${import.meta.dir}/../build/index.js`, "process.chdir(new URL('..', import.meta.url).pathname);\nawait import('../server.ts');\n");
console.info('wrote build/index.js');
