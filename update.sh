#!/usr/bin/env bash
# Update the running app to the latest source WITHOUT touching the systemd unit
# or the bundled Node binary. This avoids two things that have caused trouble:
#   1) the raw.githubusercontent HEAD CDN cache (we use the GitHub API tarball,
#      which is never stale), and
#   2) regenerating the systemd unit (which is what kept resetting ExecStart to
#      a Node path the service user can't execute -> status=203/EXEC).
#
# Run as root:  /opt/inventory-management/update.sh
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
# The repository this install follows. Override for a fork:  INV_SLUG=owner/repo
SLUG="${INV_SLUG:-CyberNerdIT/InventoryManagement-Free}"

# No credentials anywhere in here: this repository is public, so an update is a
# plain download. Keeping secrets out of the routine update path means a bad
# token can never break the thing that ships bug fixes.
dl() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  else wget -qO- "$1"; fi
}

echo "==> Refreshing app source in $DIR from $SLUG (latest default branch)"
# Extract to a staging directory first, then swap whole top-level entries in.
#
# This used to untar straight over $DIR, which ADDS and OVERWRITES but never
# DELETES. A file removed upstream stayed on the install forever, so an updated
# machine ran a mix of old and new code that no commit ever produced — and that
# is exactly the kind of state that is impossible to debug from a bug report.
# Replacing each directory outright means the tree matches the release.
#
# Deliberately preserved, because they are yours and are NOT in the tarball:
#   data/  your database and uploads
#   node/  the bundled Node binary
#   certs/ *.pem  TLS material from gen-cert.sh
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/inv-update.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
if ! dl "https://api.github.com/repos/$SLUG/tarball" | tar xz --strip-components=1 -C "$STAGE"; then
  echo "!!  Could not download $SLUG."
  echo "!!  Check network access to api.github.com, then retry."
  exit 1
fi

if [ ! -f "$STAGE/package.json" ] || [ ! -d "$STAGE/src" ]; then
  echo "!!  The download does not look like the app (no src/ or package.json)."
  echo "!!  Nothing was changed. Check network access to api.github.com and retry."
  exit 1
fi

NEW_UPDATER=0
for entry in "$STAGE"/* "$STAGE"/.[!.]*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  case "$name" in
    # Never let a release clobber local state, whatever the tarball contains.
    data|node|certs) continue ;;
    # Replacing this script while bash is still reading it corrupts the run.
    update.sh) cp "$entry" "$DIR/update.sh.new"; NEW_UPDATER=1; continue ;;
  esac
  rm -rf "$DIR/$name"
  mv "$entry" "$DIR/$name"
done

# Keep everything owned by the service user, if the unit runs as one.
U="$(sed -n 's/^User=//p' /etc/systemd/system/inventory.service 2>/dev/null | head -1 || true)"
if [ -n "${U:-}" ]; then chown -R "$U:$U" "$DIR" || true; fi

EXPECTED_BUILD="20260805f"

echo "==> Restarting service"
systemctl reset-failed inventory 2>/dev/null || true
if systemctl restart inventory 2>/dev/null; then
  RESTARTED=1
elif systemctl --user restart inventory 2>/dev/null; then
  RESTARTED=1
else
  RESTARTED=0
fi

if [ "$RESTARTED" = 0 ]; then
  echo "!!  Could not restart via systemctl. The app may be running OUTSIDE systemd"
  echo "!!  (e.g. started by hand or via pm2/nohup) — in that case the OLD code keeps"
  echo "!!  running and serving stale pages. Stop that process and restart the app,"
  echo "!!  or run:  systemctl restart inventory"
fi

# Verify the RUNNING process is actually the new code (not a stale process still
# serving old JS/branding). Find the port from the unit's env, default 3000.
PORT="$(sed -n 's/.*PORT=\([0-9]\+\).*/\1/p' /etc/systemd/system/inventory.service 2>/dev/null | head -1)"
PORT="${PORT:-3000}"
sleep 1
if command -v curl >/dev/null 2>&1; then
  LIVE="$(curl -fsSL "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
else
  LIVE="$(wget -qO- "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
fi
echo "==> Health on port $PORT: ${LIVE:-<no response>}"
if printf '%s' "$LIVE" | grep -q "\"build\":\"$EXPECTED_BUILD\""; then
  echo "==> OK — running the latest build ($EXPECTED_BUILD)."
  echo "    In your browser, do ONE hard refresh (Ctrl+Shift+R) to drop old cached files."
else
  echo "!!  The running app is NOT reporting build $EXPECTED_BUILD."
  echo "!!  A stale process is still serving old code. Fix it with:"
  echo "!!      systemctl restart inventory   (then re-run this check)"
  echo "!!  If you don't use systemd, kill the old 'node .../src/server.js' process and relaunch."
fi
if [ "$NEW_UPDATER" = 1 ] && ! cmp -s "$DIR/update.sh" "$DIR/update.sh.new"; then
  echo "==> This updater itself has changed upstream. Adopt it with:"
  echo "        sudo mv $DIR/update.sh.new $DIR/update.sh && sudo chmod +x $DIR/update.sh"
else
  rm -f "$DIR/update.sh.new"
fi
systemctl status inventory --no-pager 2>/dev/null | head -5 || true
echo "==> Done."
