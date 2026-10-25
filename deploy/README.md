# deploy/ — Raspberry Pi 5 fleet deployment

Provisioning, OTA updates, and kiosk services for the Pi 5 fleet.

**`pi/` is the canonical entry point** — see `deploy/pi/README.md`. The
installer (`deploy/pi/install.sh`) clones the repo, installs apt deps, Bun,
the systemd units (`aero-xserver`, `aero-app`, `aero-kiosk`, updater timer),
and cron jobs.

## Files in this directory

| File | Purpose |
| --- | --- |
| `pi/` | Installer, systemd units, cron jobs, branding — the live provisioning path |
| `aero-updater.sh` | OTA updater. Pulls the CI-blessed `release` branch, rebuilds, restarts services, and rolls back on install/build/health-probe failure. Invoked by `pi/aero-updater.service` (daily timer) as `/opt/zyeta-aero/app/deploy/aero-updater.sh`. |
| `aero-wifi-portal.sh` / `.service` | Boot-time WiFi check: if NetworkManager has no active connection after a 30 s grace period, starts the captive setup portal. Re-triggered by `POST /api/wifi/reset` (purge + reboot). |

## Deploy gate

The updater tracks the `release` branch, which CI fast-forwards only after
check + tests + build pass on `main` (`.github/workflows/ci.yml`). A red
commit never deploys. `release` is CI-owned — never push to it by hand.

## Cutting a Pi over to aero-3

aero-3 (`aero-3/`, Babylon on Bun) fits the contract above unchanged: `bun run build` writes
`build/index.js`, `bun run serve` runs it, `/api/status` answers the probe, and CI attaches a
`prebuilt-aero-3` tarball to each `build-<sha>` release that `aero-updater.sh` installs. The updater
reads the Bun floor from `aero-3/package.json` `engines.bun`. What differs is the data: `data/` is
gitignored, so each Pi gets its pack once with `bun aero-3/tools/ship-pack.ts <kiosk-user>@<pi>`
before `install.sh --app aero-3 --role <role> --wall http://<centre-pi>:3000`. The step-by-step
runbook, and the rule to cut over one Pi first, is in `aero-3/AGENTS.md` Run.

## Known, not changed (2026-10-25 review)

- The updater runs as root out of a checkout the kiosk user owns, with `safe.directory` set so it
  can. Hooks are disabled (`core.hooksPath=/dev/null`) and `/etc/aero` is root-owned since this
  review, but code execution as the kiosk user is still close to root through the sudoers grant
  and the kiosk-owned tree. Running the updater from a root-owned copy would close it; that
  changes the unit, so it waits for a provisioning pass.
- CI's smoke-tested aero-1 build and the packaged aero-1 prebuilt are two builds (the Build step
  still passes the Ion secret; the token is runtime now). Harmless today.
- A rollback after a prebuilt install restores the previous `build/` onto the NEW release's
  `node_modules`. For aero-1 (adapter-node externalises deps) a dependency bump between two
  releases plus a network that vanishes between download and probe is a failed rollback. Keep
  `node_modules.prev` beside `build.prev` if that ever bites.
- `install.sh` writes `.env` at INSTALL_DIR, not APP_DIR, so the updater's VITE_* read of
  `${APP_DIR}/.env` never sees it. Harmless while every VITE_* input comes from config.env.

## Parsed by tests (change the shape, redden CI)

- `aero-1/tests/tools/*.test.ts` and `aero-2/tests/bun-floor-engine.test.ts` lift shell functions out
  of `aero-updater.sh` by regex and run them in `bash -c`: `bun_meets_floor`, `hold_decision`,
  `apply_boundary` must start at column 0 as `name() {`, end at the first column-0 `}`, and be
  self-contained (no `log`, no globals).
- `restore_head_after_skip` is called exactly twice in the updater (bun-floor.test.ts counts).
- The block between `# ─── 3b. Runtime floor` and `snapshot_build` must mention
  `"@sveltejs/adapter-bun"`, `restore_head_after_skip` and `exit 0`, and must NOT mention
  `|| rollback` or `BAD_RELEASE_FILE` (not even in a comment).
- `ADAPTER_BUN_FLOOR="x.y.z"` at column 0 is read by aero-2's floor test and compared with the
  adapter's `engines.bun`.
- `aero.sudoers` grants are one `NOPASSWD:` line each, comma-separated, matched against
  `sudo -n nmcli <verb> <verb>` in aero-1's source.
- `install.sh` reads config.env with `grep -oP '^KEY=\K.*'` (first match wins; GNU only) and the
  installed unit's `^User=`; `health-check.sh` scrapes compact JSON with `grep -o '"fps":[0-9.]*'`,
  so string values in `/api/status` must stay free of `,` and `"`.
