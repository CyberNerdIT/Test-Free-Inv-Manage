#!/usr/bin/env bash
#
# Inventory Management (Free edition) — one-line installer
#
#   curl -fsSL https://raw.githubusercontent.com/CyberNerdIT/Test-Free-Inv-Manage/HEAD/install.sh | bash
#
# That is the public Free/test repository. INV_REPO / INV_SLUG can point this at
# a different one, but it must be public — nothing here sends a credential, so a
# private source answers 404 to the fetch.
#
# Options (pass as environment variables):
#   INV_DIR=~/apps/inventory   install location            (default: ~/.inventory-management)
#   INV_BRANCH=<name>          git branch to install       (default: repo's default branch)
#   INV_REPO=<git url>         source repository           (default: this project on GitHub)
#   INV_HOSTED=1               mark this as an instance YOU operate (the hosted
#                              product). Baked into the service unit. It grants
#                              nothing — it only replaces "run this command"
#                              with "contact support", which is the only honest
#                              advice for someone with no shell.
#   INV_SUPPORT_URL=<url>      where a hosted customer should be sent for help
#   INV_UPGRADE_URL=<url>      where the admin page points for the Pro upgrade
#   PORT=3000                  port the server listens on  (default: 3000)
#   INV_SERVICE=1              also install a background service (systemd user / launchd)
#   INV_SERVICE_USER=invmanage run the system service as this user (root install;
#                             implies a service, installs to /opt/inventory-management)
#   INV_START=1               start the app immediately after install
#   INV_NO_EXEC=1              never hand the terminal to the app at the end. For
#                              a script that calls this one and has its own work
#                              to do afterwards (see deploy-debian.sh) — without
#                              it, a box with no working systemd would leave the
#                              caller blocked in the foreground app forever.
#   INV_NO_AUTO_NODE=1         do NOT auto-install Node (just print instructions)
#
# Node.js 22+ is required (for the built-in SQLite module). If it's missing or
# too old, this installer installs a local copy via nvm by default — it does not
# touch any system Node — and pins the app to that binary. Opt out with
# INV_NO_AUTO_NODE=1 or --no-auto-node.
#
# You can also pass flags when piping:
#   curl -fsSL .../install.sh | bash -s -- --service --start
#
set -euo pipefail

# ---- configuration -------------------------------------------------------
REPO_URL="${INV_REPO:-https://github.com/CyberNerdIT/Test-Free-Inv-Manage.git}"
# Empty = follow the repository's default branch (whatever it is named).
BRANCH="${INV_BRANCH:-}"
REPO_SLUG="CyberNerdIT/Test-Free-Inv-Manage"
# Run the service as this user (root installs only). When set, the app is
# placed in a shared location the user can read/write instead of /root.
SERVICE_USER="${INV_SERVICE_USER:-}"
SERVICE_GROUP=""
if [ -n "${INV_DIR:-}" ]; then
  INSTALL_DIR="$INV_DIR"
elif [ -n "$SERVICE_USER" ] && [ "$(id -u)" = "0" ]; then
  INSTALL_DIR="/opt/inventory-management"
else
  INSTALL_DIR="$HOME/.inventory-management"
fi
PORT="${PORT:-3000}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=5
# Prefer a PATH directory. Root gets /usr/local/bin (on PATH); users get ~/.local/bin.
if [ -n "${INV_BIN_DIR:-}" ]; then
  BIN_DIR="$INV_BIN_DIR"
elif [ "$(id -u)" = "0" ] && [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
LAUNCHER="$BIN_DIR/inventory"

# ---- flags ---------------------------------------------------------------
DO_SERVICE="${INV_SERVICE:-0}"
# Specifying a service user implies you want the service.
[ -n "$SERVICE_USER" ] && DO_SERVICE=1
DO_START="${INV_START:-0}"
NO_EXEC="${INV_NO_EXEC:-0}"
# Auto-install Node by default; opt out with INV_NO_AUTO_NODE=1 / --no-auto-node.
AUTO_NODE="${INV_AUTO_NODE:-1}"
[ "${INV_NO_AUTO_NODE:-0}" = "1" ] && AUTO_NODE=0
NODE_BIN=""
SERVICE_OK=0
for arg in "$@"; do
  case "$arg" in
    --service) DO_SERVICE=1 ;;
    --start)   DO_START=1 ;;
    --auto-node) AUTO_NODE=1 ;;
    --no-auto-node) AUTO_NODE=0 ;;
    *) ;;
  esac
done

# ---- pretty output -------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  RED=$(printf '\033[31m'); BLUE=$(printf '\033[34m'); RESET=$(printf '\033[0m')
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; BLUE=""; RESET=""
fi
log()  { printf '%s==>%s %s\n' "$BLUE$BOLD" "$RESET" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s  !%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '%s  ✗ %s%s\n' "$RED$BOLD" "$*" "$RESET" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Download a URL to stdout using whatever downloader is available.
#
# No credential handling here on purpose: this repository is public, so nothing
# this script fetches needs a token. When the key-based Pro installer lands it
# will be its own script, with its own careful rules about which host a secret
# may be sent to.
dl() {
  if have curl; then
    curl -fsSL "$1"
  elif have wget; then
    wget -qO- "$1"
  else return 97
  fi
}

# ---- Node.js check / install ---------------------------------------------
node_version_ok() {
  have node || return 1
  local v major minor
  v=$(node -v 2>/dev/null | sed 's/^v//')
  major=${v%%.*}
  minor=$(printf '%s' "$v" | cut -d. -f2)
  [ "${major:-0}" -gt "$MIN_NODE_MAJOR" ] && return 0
  [ "${major:-0}" -eq "$MIN_NODE_MAJOR" ] && [ "${minor:-0}" -ge "$MIN_NODE_MINOR" ] && return 0
  return 1
}

install_node_via_nvm() {
  log "Installing Node.js LTS via nvm…"
  export NVM_DIR="$HOME/.nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    dl https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash \
      || die "Could not download nvm (need curl or wget). Install one — on Debian: sudo apt-get install -y curl — or install Node 22+ yourself."
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
}

ensure_node() {
  if node_version_ok; then
    ok "Node.js $(node -v) detected"
    NODE_BIN="$(command -v node)"
    return
  fi
  if have node; then
    warn "Node.js $(node -v) is too old (need >= v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} for the built-in SQLite module)."
  else
    warn "Node.js not found (need >= v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} for the built-in SQLite module)."
  fi
  if [ "$AUTO_NODE" = "1" ]; then
    install_node_via_nvm
    node_version_ok || die "Automatic Node install did not produce a compatible version. Install Node 22+ manually and re-run."
    NODE_BIN="$(command -v node)"
    ok "Node.js $(node -v) ready (local install, pinned to this app)"
  else
    cat <<EOF

  Node.js 22+ is required. Re-run WITHOUT --no-auto-node to let me install a
  local copy automatically, or install it yourself:

    ${BOLD}nvm${RESET} (recommended):
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
      then restart your shell and run:  nvm install 22

EOF
    die "Node.js 22+ required."
  fi
}

# ---- fetch / update source ----------------------------------------------
fetch_source() {
  if have git; then
    if [ -d "$INSTALL_DIR/.git" ]; then
      # A service install is chowned to the service user, so root re-running
      # this to update hits git's "dubious ownership" refusal — which is exactly
      # the path we tell people to use. Waive it for THIS command only: adding
      # it to the global git config would be a lasting change to the box made on
      # the app's behalf, for a directory the app happens to own.
      git_i() { git -c "safe.directory=$INSTALL_DIR" -C "$INSTALL_DIR" "$@"; }
      # Update in place: track whichever branch is checked out unless overridden.
      local cur="${BRANCH:-$(git_i rev-parse --abbrev-ref HEAD 2>/dev/null)}"
      [ -z "$cur" ] || [ "$cur" = "HEAD" ] && cur="$BRANCH"
      log "Updating existing install in $INSTALL_DIR…"
      if [ -n "$cur" ]; then
        git_i fetch --depth 1 origin "$cur"
        git_i checkout -B "$cur" "origin/$cur"
      else
        git_i fetch --depth 1 origin
        git_i reset --hard '@{u}'
      fi
    else
      rm -rf "$INSTALL_DIR"
      if [ -n "$BRANCH" ]; then
        log "Cloning $REPO_URL ($BRANCH) into $INSTALL_DIR…"
        git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
      else
        log "Cloning $REPO_URL (default branch) into $INSTALL_DIR…"
        git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
      fi
    fi
  else
    warn "git not found — downloading a tarball instead."
    { have curl || have wget; } || die "Need git, curl, or wget to download the app. On Debian: sudo apt-get install -y git"
    local tarball
    if [ -n "$BRANCH" ]; then
      tarball="https://codeload.github.com/$REPO_SLUG/tar.gz/refs/heads/$BRANCH"
    else
      # Redirects to the default-branch tarball.
      tarball="https://api.github.com/repos/$REPO_SLUG/tarball"
    fi
    mkdir -p "$INSTALL_DIR"
    dl "$tarball" | tar xz --strip-components=1 -C "$INSTALL_DIR" \
      || die "Failed to download source tarball${BRANCH:+ for branch '$BRANCH'}."
  fi
  ok "Source ready at $INSTALL_DIR"
}

# ---- launcher ------------------------------------------------------------
install_launcher() {
  mkdir -p "$BIN_DIR"
  cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# Inventory Management launcher (generated by install.sh)
export PORT="\${PORT:-$PORT}"
exec "$NODE_BIN" --experimental-sqlite "$INSTALL_DIR/src/server.js"
EOF
  chmod +x "$LAUNCHER"
  ok "Launcher installed: $LAUNCHER"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) warn "$BIN_DIR is not on your PATH. Add this to your shell profile:"
       printf '        export PATH="%s:$PATH"\n' "$BIN_DIR" ;;
  esac
}

# ---- optional background service ----------------------------------------
service_unit_body() {  # $1 = WantedBy target
  cat <<EOF
[Unit]
Description=Inventory Management (computer resale)
After=network.target

[Service]
Type=simple
${SERVICE_USER:+User=$SERVICE_USER}
${SERVICE_GROUP:+Group=$SERVICE_GROUP}
Environment=PORT=$PORT
${INV_HOSTED:+Environment=INV_HOSTED=$INV_HOSTED}
${INV_SUPPORT_URL:+Environment=INV_SUPPORT_URL=$INV_SUPPORT_URL}
${INV_UPGRADE_URL:+Environment=INV_UPGRADE_URL=$INV_UPGRADE_URL}
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN --experimental-sqlite $INSTALL_DIR/src/server.js
Restart=on-failure

[Install]
WantedBy=$1
EOF
}

manual_hint() {
  warn "You can always just run it in the foreground instead:"
  warn "    $LAUNCHER"
}

install_service() {
  local os; os="$(uname -s)"

  if [ "$os" = "Darwin" ]; then
    local plist="$HOME/Library/LaunchAgents/net.inventory.app.plist"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>net.inventory.app</string>
  <key>ProgramArguments</key>
  <array><string>$NODE_BIN</string><string>--experimental-sqlite</string><string>$INSTALL_DIR/src/server.js</string></array>
  <key>EnvironmentVariables</key><dict><key>PORT</key><string>$PORT</string></dict>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
</dict></plist>
EOF
    launchctl unload "$plist" 2>/dev/null || true
    if launchctl load "$plist" 2>/dev/null; then
      ok "launchd service installed and started ($plist)"; SERVICE_OK=1
    else
      warn "Could not load the launchd agent."; manual_hint
    fi
    return 0
  fi

  if [ "$os" != "Linux" ]; then
    warn "Service setup isn't supported on $os."; manual_hint; return 0
  fi
  if ! have systemctl; then
    warn "systemd (systemctl) not found — can't install a service."; manual_hint; return 0
  fi

  if [ "$(id -u)" = "0" ]; then
    # Running as root -> system-wide service.
    if [ -n "$SERVICE_USER" ]; then
      if id "$SERVICE_USER" >/dev/null 2>&1; then
        SERVICE_GROUP="$(id -gn "$SERVICE_USER" 2>/dev/null || echo "$SERVICE_USER")"
        # nvm installs Node under /root/.nvm (or a user's ~/.nvm), which is mode
        # 700 — an unprivileged service user can't traverse/execute it, so
        # systemd fails with status=203/EXEC. Bundle the single node binary into
        # the install dir (owned by the service user) and point the unit there.
        case "$NODE_BIN" in
          /root/*|/home/*)
            if cp "$NODE_BIN" "$INSTALL_DIR/node" 2>/dev/null; then
              chmod 0755 "$INSTALL_DIR/node"
              NODE_BIN="$INSTALL_DIR/node"
              ok "Bundled Node at $INSTALL_DIR/node so '$SERVICE_USER' can execute it"
            else
              warn "Could not copy Node into $INSTALL_DIR — service may fail with 203/EXEC."
            fi
            ;;
        esac
        chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR" 2>/dev/null \
          || warn "Could not chown $INSTALL_DIR to $SERVICE_USER — the service may fail to write its database."
        ok "Service will run as user '$SERVICE_USER' (data in $INSTALL_DIR)"
      else
        warn "User '$SERVICE_USER' does not exist — the service will run as root instead."
        SERVICE_USER=""
      fi
    fi
    service_unit_body "multi-user.target" > /etc/systemd/system/inventory.service
    systemctl daemon-reload 2>/dev/null || true
    systemctl reset-failed inventory.service 2>/dev/null || true  # clear any start-limit from prior crashes
    if systemctl enable inventory.service 2>/dev/null && systemctl restart inventory.service 2>/dev/null; then
      ok "systemd service installed & (re)started  (status: systemctl status inventory)"; SERVICE_OK=1
    else
      warn "Wrote /etc/systemd/system/inventory.service but couldn't start it"
      warn "(no system service manager here — e.g. a container without systemd)."
      warn "If systemd is available:  systemctl enable --now inventory"
      manual_hint
    fi
  else
    # Regular user -> user service (needs a user D-Bus session).
    # User=/Group= are not valid in a user unit; the service already runs as us.
    SERVICE_USER=""; SERVICE_GROUP=""
    local unit_dir="$HOME/.config/systemd/user"
    mkdir -p "$unit_dir"
    service_unit_body "default.target" > "$unit_dir/inventory.service"
    systemctl --user daemon-reload 2>/dev/null || true
    systemctl --user reset-failed inventory.service 2>/dev/null || true
    if systemctl --user enable inventory.service 2>/dev/null && systemctl --user restart inventory.service 2>/dev/null; then
      ok "systemd user service installed & (re)started  (status: systemctl --user status inventory)"; SERVICE_OK=1
      warn "Keep it running after logout:  loginctl enable-linger $USER"
    else
      warn "No user systemd session available (common over SSH or for a non-login user)."
      warn "Re-run this installer with sudo/root to set up a system-wide service,"
      manual_hint
    fi
  fi
  return 0
}

# ---- main ----------------------------------------------------------------
printf '\n%sInventory Management (Free edition) installer%s\n\n' "$BOLD" "$RESET"
ensure_node
fetch_source
install_launcher
[ "$DO_SERVICE" = "1" ] && install_service

# The command the user should type to run it: bare name if on PATH, else full path.
case ":$PATH:" in
  *":$BIN_DIR:"*) RUNCMD="inventory" ;;
  *) RUNCMD="$LAUNCHER" ;;
esac

printf '\n%s✓ Installed.%s\n\n' "$GREEN$BOLD" "$RESET"
if [ "$DO_SERVICE" = "1" ] && [ "$SERVICE_OK" = "1" ]; then
  printf '  Running as a background service on %shttp://localhost:%s%s\n' "$BOLD" "$PORT" "$RESET"
else
  [ "$DO_SERVICE" = "1" ] && printf '  %sThe service could not start automatically — run it directly:%s\n' "$YELLOW" "$RESET"
  printf '  Start it with:  %s%s%s   (or: PORT=%s %s)\n' "$BOLD" "$RUNCMD" "$RESET" "$PORT" "$RUNCMD"
  printf '  Then open:      %shttp://localhost:%s%s\n' "$BOLD" "$PORT" "$RESET"
fi
printf '  Installed in:   %s\n' "$INSTALL_DIR"
printf '  Update anytime: re-run this installer.\n\n'

# Start now if asked, or automatically when the service path did not come up —
# a person who typed --service wants it running, and a failed unit should not
# leave them staring at a prompt. A caller that has more to do afterwards sets
# INV_NO_EXEC=1, because this never returns.
if { [ "$DO_START" = "1" ] || { [ "$DO_SERVICE" = "1" ] && [ "$SERVICE_OK" != "1" ]; }; }; then
  if [ "$NO_EXEC" = "1" ]; then
    printf '  Start it with:  %s%s%s\n\n' "$BOLD" "$RUNCMD" "$RESET"
  else
    log "Starting Inventory Management on port $PORT (Ctrl+C to stop)…"
    exec "$LAUNCHER"
  fi
fi
