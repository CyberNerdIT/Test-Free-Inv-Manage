#!/usr/bin/env bash
# Generate a self-signed TLS certificate so the app serves HTTPS.
# The server auto-detects data/tls/{cert,key}.pem on the next restart.
#
#   ./gen-cert.sh                 # CN=localhost (local / LAN use)
#   ./gen-cert.sh your.domain     # CN=your.domain
#
# For a public domain with a browser-trusted certificate, use Let's Encrypt
# instead (see the HTTPS section of the README) and point TLS_CERT_FILE /
# TLS_KEY_FILE at the issued files.
set -euo pipefail

DIR="${INV_DIR:-$(cd "$(dirname "$0")" && pwd)}"
TLS="$DIR/data/tls"
CN="${1:-localhost}"

command -v openssl >/dev/null 2>&1 || { echo "openssl is required. On Debian: sudo apt-get install -y openssl" >&2; exit 1; }

mkdir -p "$TLS"
# Build a Subject Alternative Name list. If the CN looks like an IPv4 address
# (e.g. a LAN IP like 172.16.1.47) put it in an IP: SAN, not DNS:.
if [[ "$CN" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SAN="IP:$CN,IP:127.0.0.1,DNS:localhost"
else
  SAN="DNS:$CN,DNS:localhost,IP:127.0.0.1"
fi
echo "Generating a self-signed certificate for $CN (SAN: $SAN) …"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$TLS/key.pem" -out "$TLS/cert.pem" -days 825 \
  -subj "/CN=$CN" \
  -addext "subjectAltName=$SAN"
chmod 600 "$TLS/key.pem"
chmod 644 "$TLS/cert.pem"

# If run as root, hand the cert to whoever owns the install dir (the service
# user) so the running service can read the key.
if [ "$(id -u)" = "0" ]; then
  owner="$(stat -c '%U' "$DIR" 2>/dev/null || echo root)"
  chown -R "$owner":"$owner" "$TLS" 2>/dev/null || true
fi

echo "Wrote:"
echo "  $TLS/cert.pem"
echo "  $TLS/key.pem"
echo
echo "Now restart the app to serve HTTPS:"
echo "  systemctl restart inventory   # or: systemctl --user restart inventory"
echo
echo "Then open https://<host>:${PORT:-3000}  (self-signed → your browser will"
echo "warn once; click through, or import cert.pem as trusted)."
