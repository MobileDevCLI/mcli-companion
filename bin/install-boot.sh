#!/usr/bin/env bash
# install-boot.sh — one-shot installer that wires mcli-companion into
# Termux:Boot (auto-start on device power-on) AND registers a cron
# every-5-min keepalive as a belt-and-suspenders fallback.
#
# Idempotent. Safe to re-run — will replace an existing boot script but
# never duplicate the cron entry.

set -eu

log() { printf '  %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$REPO_DIR/bin/mcli-companion.js"
[ -f "$ENTRY" ] || die "companion entry $ENTRY missing"

# ---- Termux detection ------------------------------------------------------
# TERMUX_VERSION is set by Termux's login script for every interactive shell.
# When absent we bail — this installer only knows Termux paths.
if [ -z "${TERMUX_VERSION:-}" ]; then
  die "not running inside Termux (TERMUX_VERSION unset). Boot install is Termux-only."
fi

log "Termux $TERMUX_VERSION detected"
log "repo:  $REPO_DIR"
log "entry: $ENTRY"

# ---- Boot script -----------------------------------------------------------
BOOT_DIR="$HOME/.termux/boot"
BOOT_SCRIPT="$BOOT_DIR/mcli-companion"
SRC_BOOT="$REPO_DIR/etc/boot-mcli-companion"

# Ship a canonical copy inside the repo so `npx mcli-companion install-boot`
# always has a fresh copy to lay down, independent of what's already installed.
mkdir -p "$REPO_DIR/etc"
if [ ! -f "$SRC_BOOT" ]; then
  cat > "$SRC_BOOT" <<'BOOT_EOF'
#!/data/data/com.termux/files/usr/bin/bash
# mcli-companion boot script — installed by install-boot.sh
set -eu
LOG="$HOME/.mcli-companion.log"
ENTRY="$HOME/mcli-companion-repo/bin/mcli-companion.js"
[ -f "$ENTRY" ] || { echo "[$(date -Iseconds)] boot: entry missing" >> "$LOG"; exit 0; }
if pgrep -f 'mcli-companion\.js' >/dev/null 2>&1; then
  echo "[$(date -Iseconds)] boot: already running" >> "$LOG"; exit 0
fi
termux-wake-lock 2>/dev/null || true
sleep 3
setsid nohup node "$ENTRY" >> "$LOG" 2>&1 </dev/null &
disown 2>/dev/null || true
echo "[$(date -Iseconds)] boot: launched pid $!" >> "$LOG"
BOOT_EOF
fi

mkdir -p "$BOOT_DIR"
cp "$SRC_BOOT" "$BOOT_SCRIPT"
chmod +x "$BOOT_SCRIPT"
log "boot script installed: $BOOT_SCRIPT"

if [ ! -d "$BOOT_DIR" ] || [ ! -d "$HOME/.termux" ]; then
  log "warning: ~/.termux/boot directory did not exist. Install Termux:Boot from"
  log "         F-Droid (https://f-droid.org/en/packages/com.termux.boot/) then"
  log "         RE-RUN this script. Without it the boot script never fires."
fi

# ---- Cron keepalive (fallback) --------------------------------------------
# Cronie is a manual `pkg install cronie` on Termux. When absent, skip the
# cron branch with a note — the boot script alone still covers cold boots.
if command -v crontab >/dev/null 2>&1; then
  MARKER='# mcli-companion keepalive'
  KEEPALIVE="* * * * * pgrep -f mcli-companion\\.js >/dev/null 2>&1 || (nohup node $ENTRY >> \$HOME/.mcli-companion.log 2>&1 &)  $MARKER"

  CURRENT="$(crontab -l 2>/dev/null || true)"
  if printf '%s\n' "$CURRENT" | grep -qF "$MARKER"; then
    log "cron keepalive already registered"
  else
    { printf '%s\n' "$CURRENT"; printf '%s\n' "$KEEPALIVE"; } | crontab -
    log "cron keepalive added (checks every minute)"
  fi
  # Start crond if not running (Termux doesn't auto-start it)
  if ! pgrep -x crond >/dev/null 2>&1; then
    crond 2>/dev/null || log "note: could not start crond — install: pkg install cronie"
  fi
else
  log "note: crontab not installed. For a keepalive fallback, run:"
  log "        pkg install cronie && bash $0"
fi

# ---- One immediate start so the user doesn't have to reboot ---------------
if ! pgrep -f 'mcli-companion\.js' >/dev/null 2>&1; then
  log "starting companion now (so you don't have to reboot)…"
  termux-wake-lock 2>/dev/null || true
  setsid nohup node "$ENTRY" >> "$HOME/.mcli-companion.log" 2>&1 </dev/null &
  disown 2>/dev/null || true
  sleep 1
  if pgrep -f 'mcli-companion\.js' >/dev/null 2>&1; then
    log "companion running (pid $(pgrep -f mcli-companion.js | head -1))"
  else
    log "warning: companion did not start. Check $HOME/.mcli-companion.log"
  fi
else
  log "companion already running (pid $(pgrep -f mcli-companion.js | head -1))"
fi

printf '\n'
printf 'Companion will now start on device boot.\n'
printf 'Tail live log: tail -f $HOME/.mcli-companion.log\n'
