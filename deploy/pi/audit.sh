#!/usr/bin/env bash
# audit.sh — READ-ONLY inventory of one fielded Pi: which layout it runs,
# which commit, which units are live, and what older installs left behind.
# Changes nothing. Run:  ssh kiosk@<pi> 'sudo bash -s' < deploy/pi/audit.sh
set -u
say() { printf '\n== %s\n' "$*"; }
have() { [[ -e "$1" ]] && printf '  present  %s\n' "$1" || printf '  absent   %s\n' "$1"; }

say "host / clock"
hostname; uptime -p 2>/dev/null
timedatectl show -p NTPSynchronized -p TimeUSec 2>/dev/null | tr '\n' ' '; echo
date -u +'  utc now %FT%T'

say "layouts"
have /opt/aero-window            # current install.sh
have /opt/zyeta-aero             # provision-pi.sh (pre 2026-07-28)
have /home/kiosk/aero-window     # pre-git legacy
have /home/pi/aero-window        # pre-git legacy (portal + gpio units pointed here)
have /etc/aero/config.env        # current config
have /opt/zyeta-aero/config.env  # old config

say "config (secrets redacted)"
for f in /etc/aero/config.env /opt/zyeta-aero/config.env; do
  [[ -f $f ]] && { echo "  -- $f"; sed -E 's/(TOKEN|SECRET|KEY)=.*/\1=<redacted>/' "$f" | sed 's/^/     /'; }
done

say "checkout + commit per layout"
for d in /opt/aero-window /opt/zyeta-aero /home/kiosk/aero-window /home/pi/aero-window; do
  [[ -d $d/.git ]] || continue
  printf '  %s  ' "$d"
  git -C "$d" log -1 --format='%h %cd %s' --date=short 2>/dev/null || echo '(git error)'
  printf '     branch %s  shallow=%s  app-subdir-dirs:' "$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null)" "$(git -C "$d" rev-parse --is-shallow-repository 2>/dev/null)"
  for a in aero-1 aero-2; do [[ -d $d/$a ]] && printf ' %s' "$a"; done; echo
  [[ -d $d/build ]] && printf '     root build/ (old layout) mtime %s\n' "$(date -r "$d/build" +%F 2>/dev/null)"
  for a in aero-1 aero-2; do [[ -d $d/$a/build ]] && printf '     %s/build mtime %s\n' "$a" "$(date -r "$d/$a/build" +%F)"; done
  git -C "$d" status --short 2>/dev/null | head -5 | sed 's/^/     dirty: /'
done

say "aero units (enabled / active / ExecStart)"
for f in /etc/systemd/system/aero-*.service /etc/systemd/system/aero-*.timer; do
  [[ -e $f ]] || continue; u=${f##*/}
  printf '  %-28s %-9s %-9s ' "$u" "$(systemctl is-enabled "$u" 2>/dev/null)" "$(systemctl is-active "$u" 2>/dev/null)"
  grep -m1 -E '^ExecStart=' "/etc/systemd/system/$u" | cut -c1-90 || echo
done

say "orphan candidates (from superseded layouts)"
have /etc/systemd/system/aero-watchdog.timer      # provision-pi.sh; not in DEAD_UNITS
have /etc/systemd/system/aero-watchdog.service
have /etc/systemd/system/aero-fleet.service       # retired by install.sh DEAD_UNITS
have /etc/systemd/system/aero-gpio-reset.service  # pre-git; ExecStart under /home/pi
have /etc/NetworkManager/conf.d/no-powersave.conf # old name (new: aero-no-powersave.conf)
have /opt/zyeta-aero/aero-updater.sh              # COPIED updater — never self-updates
have /usr/local/share/wifi-portal/index.html      # wifi-connect UI (new portal)
have /usr/local/bin/wifi-connect
have /usr/local/lib/aero/aero-wifi-portal.sh
have /etc/udev/rules.d/99-aero-usb.rules
have /etc/sudoers.d/aero
have /etc/sudoers.d/010_pi-nopasswd                # stock blanket rule (see review A3)
for c in /etc/cron.d/*aero*; do [[ -e $c ]] && echo "  cron.d: ${c##*/}"; done

say "failed units mentioning aero"
systemctl --failed --no-legend 2>/dev/null | grep -i aero || echo "  none"

say "timers (live cadence)"
systemctl list-timers --no-legend 'aero-*' 2>/dev/null | sed 's/^/  /'

say "updater log (owner/mode, tail) + last journal"
stat -c '  %U %a %n' /var/log/aero-updater.log 2>/dev/null || echo "  no /var/log/aero-updater.log"
tail -n 8 /var/log/aero-updater.log 2>/dev/null | sed 's/^/  /'
journalctl -u aero-updater --since -2d --no-pager 2>/dev/null | tail -12 | sed 's/^/  /'


say "sudo preflight, as the service user (what the app's privileged hatch runs)"
U=$(grep -m1 '^User=' /etc/systemd/system/aero-app.service 2>/dev/null | cut -d= -f2)
echo "  service user: ${U:-<none in unit>}"
if [[ -n ${U:-} ]]; then
  runuser -u "$U" -- sudo -n true 2>/dev/null && echo "  sudo -n true: OK" || echo "  sudo -n true: FAILS (update / wifi-reset hatches would 503)"
fi

say "app answers locally"
curl -s -m 3 http://127.0.0.1:3000/api/status | head -c 400; echo

say "listening + reachable via wall origin"
ss -ltnp 2>/dev/null | grep -E ':3000|:80 ' | sed 's/^/  /'
