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
