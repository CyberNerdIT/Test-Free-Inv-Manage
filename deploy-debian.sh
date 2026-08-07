#!/usr/bin/env bash
#
# Inventory Management — one-shot Debian/Ubuntu server deployment.
#
#   curl -fsSL https://raw.githubusercontent.com/CyberNerdIT/InventoryManagement-Free/HEAD/deploy-debian.sh | bash
#
# Takes a bare Debian box — a fresh VM, an LXC container, a VPS — to a running,
# auto-starting service in one command. It does the things install.sh
# deliberately does not, because install.sh also has to work on a laptop, on
# macOS, and without root:
#
#   * installs the apt packages the install needs (curl, git, openssl, CAs)
#   * creates the unprivileged system user the service runs as
#   * hands over to install.sh for the app itself, the Node bootstrap and the
#     systemd unit — one implementation of that, not two
#   * generates a self-signed TLS certificate, so the box serves HTTPS from the
#     first request rather than "we'll sort that out later"
#   * waits for the app to answer /api/health and tells you what it said
#
# Run it as root. There is no `sudo` in a stock Debian container image, and
# needing one before you can install anything is a poor first impression:
#
#   root@box:~# bash deploy-debian.sh
#
# Options — flags, or the matching environment variables:
#
#   --port N              PORT               port to listen on      (default 3000)
#   --dir PATH            INV_DIR            install location       (default /opt/inventory-management)
#   --user NAME           INV_SERVICE_USER   service account        (default invmanage)
#                                            pass "root" to skip creating one
#   --branch NAME         INV_BRANCH         branch to install      (default: repo default)
#   --slug owner/repo     INV_SLUG           source repository
#   --tls CN              INV_TLS            name on the certificate (default: this host)
#   --no-tls              INV_NO_TLS         serve plain HTTP instead
#   --hosted              INV_HOSTED         mark as an instance YOU operate
#   --support-url URL     INV_SUPPORT_URL    where a hosted customer gets help
#   --upgrade-url URL     INV_UPGRADE_URL    where the admin page links for Pro
#   --no-start            INV_NO_START       install and enable, but don't start
#
# Piping needs `-s --` before flags, because the script is bash's stdin:
#
#   curl -fsSL .../deploy-debian.sh | bash -s -- --port 8080 --tls shop.example
#
# Re-running is safe and is how you re-deploy: packages already present are
# left alone, an existing service user is reused, and install.sh updates the
# app in place. Your database, uploads and TLS material are never touched.
set -euo pipefail

# ---- configuration -------------------------------------------------------
SLUG="${INV_SLUG:-CyberNerdIT/InventoryManagement-Free}"
BRANCH="${INV_BRANCH:-}"
PORT="${PORT:-3000}"
INSTALL_DIR="${INV_DIR:-/opt/inventory-management}"
SERVICE_USER="${INV_SERVICE_USER:-invmanage}"
# HTTPS by default. A shop's admin page carries customer names, emails and
# phone numbers, and the login that guards it posts a password — none of which
# belongs on plain HTTP just because a certificate was one extra flag away. The
# cert is self-signed, so browsers will warn once; that is a worse first
# impression than nothing at all only if you think an unencrypted password
# prompt is a good one.
TLS_CN="${INV_TLS:-}"
DO_TLS=1
[ "${INV_NO_TLS:-0}" = "1" ] && DO_TLS=0
DO_START=1
[ "${INV_NO_START:-0}" = "1" ] && DO_START=0

# Where a downloaded copy of install.sh lands, if we have to fetch one. Global,
# and armed before anything can fail, because the EXIT trap runs after every
# function has returned — a `local` here is out of scope by then, and under
# `set -u` the trap would fail with "unbound variable" AFTER a successful
# deploy, printing an error for something that worked and leaving a non-zero
# exit code behind for anyone scripting this.
INSTALLER_TMP=""
cleanup() { [ -n "$INSTALLER_TMP" ] && rm -f "$INSTALLER_TMP"; return 0; }
trap cleanup EXIT

# Am I a file on disk (a clone) or a stream (curl | bash)? Resolved HERE, at
# top level, and never inside a function: within one, BASH_SOURCE[0] is the
# function's own source and reads as the literal "main" for a script arriving on
# stdin. dirname of that is ".", which quietly turns the question into "does the
# current directory happen to contain an install.sh?" — and answers yes for
# anyone who runs the one-line installer from a checkout.
SELF="${BASH_SOURCE[0]:-}"
SELF_DIR=""
[ -n "$SELF" ] && [ -f "$SELF" ] && SELF_DIR="$(cd "$(dirname "$SELF")" && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --port)         PORT="$2"; shift 2 ;;
    --dir)          INSTALL_DIR="$2"; shift 2 ;;
    --user)         SERVICE_USER="$2"; shift 2 ;;
    --branch)       BRANCH="$2"; shift 2 ;;
    --slug)         SLUG="$2"; shift 2 ;;
    # --tls takes an OPTIONAL value, so only consume the next argument when it
    # is a value rather than the next flag.
    --tls)          DO_TLS=1
                    case "${2:-}" in ''|--*) ;; *) TLS_CN="$2"; shift ;; esac
                    shift ;;
    --no-tls)       DO_TLS=0; shift ;;
    --hosted)       INV_HOSTED=1; export INV_HOSTED; shift ;;
    --support-url)  INV_SUPPORT_URL="$2"; export INV_SUPPORT_URL; shift 2 ;;
    --upgrade-url)  INV_UPGRADE_URL="$2"; export INV_UPGRADE_URL; shift 2 ;;
    --no-start)     DO_START=0; shift ;;
    -h|--help)      sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1  (try --help)" >&2; exit 1 ;;
  esac
done

# ---- pretty output -------------------------------------------------------
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  RED=$(printf '\033[31m'); BLUE=$(printf '\033[34m'); RESET=$(printf '\033[0m')
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; RESET=""; BLUE=""
fi
log()  { printf '%s==>%s %s\n' "$BLUE$BOLD" "$RESET" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s  !%s %s\n' "$YELLOW" "$RESET" "$*"; }
die()  { printf '%s  ✗ %s%s\n' "$RED$BOLD" "$*" "$RESET" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

printf '\n%sInventory Management — Debian deployment%s\n\n' "$BOLD" "$RESET"

# ---- preflight -----------------------------------------------------------
# Fail on the first line rather than halfway through a package install: a
# half-deployed box is harder to reason about than one that never started.
[ "$(id -u)" = "0" ] || die "Run this as root. On a stock Debian container there is no sudo — log in as root, or install sudo first (apt-get install -y sudo)."
have apt-get || die "No apt-get here, so this is not Debian/Ubuntu. Use install.sh instead — it works on any Linux or macOS with Node 22+."

# Is there a systemd to install a unit into? Minimal LXC images and Docker
# containers often boot without one, and `systemctl` existing is not the same
# as it working. Decided ONCE, here, so every later step agrees about it.
HAVE_SYSTEMD=0
if have systemctl && systemctl list-units >/dev/null 2>&1; then
  HAVE_SYSTEMD=1
else
  warn "systemd is not running here, so there will be no auto-starting service."
  warn "Everything else still installs; you'll get the command to run it at the end."
fi

# ---- packages ------------------------------------------------------------
# Only install what is genuinely missing. `apt-get update` is slow on a fresh
# box and pointless on one that already has everything.
install_packages() {
  local want=()
  have curl   || want+=(curl)
  have git    || want+=(git)
  have openssl|| want+=(openssl)
  # ca-certificates ships no binary; without it every HTTPS fetch fails with a
  # certificate error that reads like a network problem.
  [ -e /etc/ssl/certs/ca-certificates.crt ] || want+=(ca-certificates)

  if [ ${#want[@]} -eq 0 ]; then
    ok "All required packages are already installed"
    return 0
  fi

  log "Installing: ${want[*]}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || die "apt-get update failed — check the container's network and DNS."
  apt-get install -y -qq "${want[@]}" || die "Could not install: ${want[*]}"
  ok "Packages installed"
}

# ---- service user --------------------------------------------------------
# A system account with no shell and no home: it exists to own the install
# directory and run one process, and nothing about it should be loggable into.
ensure_user() {
  if [ "$SERVICE_USER" = "root" ] || [ -z "$SERVICE_USER" ]; then
    warn "Service will run as root — pass --user NAME to use an unprivileged account instead"
    SERVICE_USER=""
    return 0
  fi
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    ok "Service user '$SERVICE_USER' already exists"
    return 0
  fi
  log "Creating system user '$SERVICE_USER'"
  useradd --system --shell /usr/sbin/nologin --no-create-home "$SERVICE_USER" \
    || die "Could not create user '$SERVICE_USER'"
  ok "User '$SERVICE_USER' created"
}

# ---- the app ------------------------------------------------------------
# Delegate to install.sh rather than reimplementing it. It already knows how to
# fetch the source, bootstrap Node 22 when the distro's is too old, bundle that
# binary somewhere the service user can execute it, and write the systemd unit.
# A second copy of that logic here would drift from it within one release.
run_installer() {
  local installer
  # Running from a clone (./deploy-debian.sh) uses the install.sh sitting next
  # to it, so a local edit is what actually gets deployed. Streamed from curl
  # there is no such file, so fetch one.
  if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/install.sh" ]; then
    installer="$SELF_DIR/install.sh"
    log "Installing from the local checkout ($SELF_DIR)"
  else
    INSTALLER_TMP="$(mktemp "${TMPDIR:-/tmp}/inv-install.XXXXXX.sh")"
    installer="$INSTALLER_TMP"
    local ref="${BRANCH:-HEAD}"
    log "Fetching the installer from $SLUG (${BRANCH:-default branch})"
    curl -fsSL "https://raw.githubusercontent.com/$SLUG/$ref/install.sh" -o "$installer" \
      || die "Could not download install.sh from $SLUG@$ref. Check the repository and branch names."
  fi

  log "Installing the app into $INSTALL_DIR"
  # INV_NO_EXEC is what keeps this script alive. install.sh ends by exec'ing the
  # app in the foreground whenever the service did not come up — right for
  # someone installing on a laptop, fatal here, because TLS, the health check
  # and the summary below would never run.
  PORT="$PORT" \
  INV_DIR="$INSTALL_DIR" \
  INV_SERVICE_USER="$SERVICE_USER" \
  INV_BRANCH="$BRANCH" \
  INV_REPO="https://github.com/$SLUG.git" \
  INV_SERVICE=1 \
  INV_START=0 \
  INV_NO_EXEC=1 \
    bash "$installer" || die "install.sh failed — nothing above this line succeeded, so nothing is half-configured."
}

# ---- TLS ----------------------------------------------------------------
# The server picks up data/tls/{cert,key}.pem on its next start, so generating
# the pair and restarting is the whole of "turn on HTTPS".
setup_tls() {
  if [ "$DO_TLS" = "0" ]; then
    warn "Serving plain HTTP (--no-tls). Put a TLS-terminating proxy in front before this is reachable from anywhere but your LAN."
    return 0
  fi

  # Never regenerate over an existing pair. Re-running this script is the
  # documented way to update, and silently replacing a certificate — possibly a
  # real one from Let's Encrypt that somebody dropped in here — would break
  # every client that had already accepted the old one.
  if [ -f "$INSTALL_DIR/data/tls/cert.pem" ] && [ -f "$INSTALL_DIR/data/tls/key.pem" ]; then
    ok "Keeping the existing certificate in $INSTALL_DIR/data/tls"
    SCHEME="https"
    return 0
  fi

  # Default the common name to whatever this box calls itself. A certificate
  # naming the wrong host still encrypts, but it turns one dismissable browser
  # warning into a permanent one.
  local cn="${TLS_CN:-$(hostname -f 2>/dev/null || hostname)}"
  [ -x "$INSTALL_DIR/gen-cert.sh" ] || { warn "gen-cert.sh not found in $INSTALL_DIR — staying on plain HTTP"; return 0; }

  log "Generating a self-signed certificate for $cn"
  if ! "$INSTALL_DIR/gen-cert.sh" "$cn" >/dev/null 2>&1; then
    warn "Certificate generation failed — the app stays on plain HTTP"
    return 0
  fi
  # The service user has to be able to READ its own key, or the app falls back
  # to HTTP on restart and the only clue is a log line nobody reads.
  [ -n "$SERVICE_USER" ] && chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR/data/tls" 2>/dev/null || true
  ok "Certificate written to $INSTALL_DIR/data/tls (CN=$cn)"
  warn "Self-signed, so a browser will warn once and let you continue. For a"
  warn "certificate browsers trust, use Let's Encrypt and point TLS_CERT_FILE /"
  warn "TLS_KEY_FILE at the issued files, or replace the two files above."
  SCHEME="https"
}

# ---- start + verify -----------------------------------------------------
# "systemctl says active" and "the app answers" are different claims, and only
# the second one is what you actually wanted.
verify() {
  if [ "$HAVE_SYSTEMD" = "0" ]; then
    # Point at the launcher install.sh wrote rather than a node path guessed
    # from here — it already knows which interpreter this box ended up with,
    # which may be the system one or a bundled copy.
    warn "No service is running, because this host has no systemd. Start it with:"
    warn "    PORT=$PORT inventory"
    warn "A unit file was still written to /etc/systemd/system/inventory.service,"
    warn "so this box is ready if systemd is ever enabled on it."
    return 0
  fi
  [ "$DO_START" = "1" ] || { warn "Not starting (--no-start). Start it with: systemctl start inventory"; return 0; }

  log "Starting the service"
  systemctl restart inventory 2>/dev/null || true

  # Node bootstrap and first-run schema creation take a moment; poll instead of
  # sleeping a fixed guess and reporting a false failure.
  local health="" i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    health="$(curl -fsSk --max-time 3 "${SCHEME:-http}://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
    [ -n "$health" ] && break
    sleep 1
  done

  if [ -z "$health" ]; then
    warn "The service did not answer on port $PORT. Look at why with:"
    warn "    systemctl status inventory --no-pager"
    warn "    journalctl -u inventory -n 50 --no-pager"
    return 0
  fi
  ok "The app answered /api/health"
  case "$health" in
    *'"key":"free"'*) ok "Edition: free (no premium modules — see the Pro upgrade section in Admin)" ;;
  esac
  systemctl enable inventory >/dev/null 2>&1 || true
  ok "Enabled at boot"
}

# ---- main ---------------------------------------------------------------
install_packages
ensure_user
run_installer
setup_tls
verify

ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
printf '\n%s✓ Deployed.%s\n\n' "$GREEN$BOLD" "$RESET"
printf '  Open:           %s%s://%s:%s%s\n' "$BOLD" "${SCHEME:-http}" "${ADDR:-localhost}" "$PORT" "$RESET"
printf '                  The first visit creates the admin account.\n'
printf '  Installed in:   %s\n' "$INSTALL_DIR"
printf '  Runs as:        %s\n' "${SERVICE_USER:-root}"
if [ "$HAVE_SYSTEMD" = "1" ]; then
  printf '  Logs:           journalctl -u inventory -f\n'
  printf '  Restart:        systemctl restart inventory\n'
else
  printf '  Start it:       PORT=%s inventory\n' "$PORT"
fi
printf '  Update:         %s/update.sh\n' "$INSTALL_DIR"
printf '  Re-deploy:      re-run this script (safe; your data is untouched)\n\n'
