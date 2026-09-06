#!/usr/bin/env bash
#
# Turns a fresh Raspberry Pi OS install into a machine that can run this project.
#
# Runs *on the Pi*. Needs sudo, and asks for it once. It is idempotent: running it a second
# time reports what is already in place and changes nothing, which is the property that makes
# it worth trusting after an SD card has died at an inconvenient moment.
#
#   scp -r deploy/pi pi@raspberrypi:/tmp/ && ssh pi@raspberrypi 'bash /tmp/pi/provision.sh'
#
# What it does NOT do: restore data/. Provisioning rebuilds the software; the account, the
# journal that undo works from, the category observations and the filter backups exist only
# in data/, and only backup.sh protects them. See README.md in this directory.

set -euo pipefail

NODE_VERSION="v24.20.0"
CHECKOUT="${PMS_CHECKOUT:-$HOME/github/private/proton-mail-sorter}"
NODE_HOME="$HOME/.local/node"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- sanity

if [ "$(dpkg --print-architecture)" != "arm64" ]; then
    echo "Dies ist für arm64 (Raspberry Pi OS 64-bit) geschrieben, gefunden: $(dpkg --print-architecture)" >&2
    exit 1
fi

say "Raspberry Pi: $(tr -d '\0' < /sys/firmware/devicetree/base/model 2>/dev/null || echo unbekannt)"

# ---------------------------------------------------------------- packages
#
# gcc/make/python3 are here because a native module may have to be compiled when no prebuilt
# binary matches the Node ABI. On the current versions one is downloaded and nothing compiles,
# but that is a fact about today's versions, not a guarantee.

say "Systempakete"
PACKAGES="git build-essential python3 curl rsync ca-certificates xz-utils stress-ng"
MISSING=""
for pkg in $PACKAGES; do
    dpkg -s "$pkg" >/dev/null 2>&1 || MISSING="$MISSING $pkg"
done
if [ -n "$MISSING" ]; then
    echo "  fehlen:$MISSING"
    sudo apt-get update
    # shellcheck disable=SC2086
    sudo apt-get install -y $MISSING
else
    echo "  alle vorhanden"
fi

# ---------------------------------------------------------------- node
#
# From nodejs.org rather than from apt: Debian's node is too old for this project (>=24), and a
# tarball under $HOME needs no sudo and can be replaced without touching the system.

say "Node $NODE_VERSION"
if [ "$("$NODE_HOME/bin/node" -v 2>/dev/null || true)" = "$NODE_VERSION" ]; then
    echo "  schon installiert"
else
    TARBALL="node-$NODE_VERSION-linux-arm64.tar.xz"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$TARBALL" -o "$TMP/$TARBALL"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
    # Verified before it is unpacked. An unchecked tarball fetched over the network and then run
    # is the whole supply chain of this machine.
    ( cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c - )
    tar -xJf "$TMP/$TARBALL" -C "$TMP"
    rm -rf "$NODE_HOME"
    mkdir -p "$(dirname "$NODE_HOME")"
    mv "$TMP/node-$NODE_VERSION-linux-arm64" "$NODE_HOME"
    echo "  $("$NODE_HOME/bin/node" -v)"
fi

export PATH="$NODE_HOME/bin:$PATH"
grep -q '.local/node/bin' "$HOME/.profile" 2>/dev/null \
    || echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> "$HOME/.profile"

say "pnpm über corepack"
corepack enable --install-directory "$NODE_HOME/bin"
echo "  corepack bereit (pnpm-Version kommt aus package.json)"

# ---------------------------------------------------------------- tailscale

say "Tailscale"
if have tailscale; then
    echo "  schon installiert: $(tailscale version | head -1)"
else
    CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    curl -fsSL "https://pkgs.tailscale.com/stable/debian/$CODENAME.noarmor.gpg" \
        | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
    curl -fsSL "https://pkgs.tailscale.com/stable/debian/$CODENAME.tailscale-keyring.list" \
        | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
    sudo apt-get update
    sudo apt-get install -y tailscale
    echo "  installiert. Anmelden mit: sudo tailscale up"
fi

# ---------------------------------------------------------------- service

say ".env.pi"
if [ -f "$CHECKOUT/.env.pi" ]; then
    echo "  vorhanden, bleibt unangetastet"
elif [ -d "$CHECKOUT" ]; then
    sed "s#/home/pi/github/private/proton-mail-sorter#$CHECKOUT#g" \
        "$(dirname "$0")/env.pi.example" > "$CHECKOUT/.env.pi"
    echo "  angelegt aus der Vorlage — PMS_PUBLIC_ORIGIN muss noch eingetragen werden"
fi

say "systemd-Unit"
if [ -d "$CHECKOUT" ]; then
    sed -e "s#@CHECKOUT@#$CHECKOUT#g" -e "s#@USER@#$USER#g" -e "s#@NODEHOME@#$NODE_HOME#g" \
        "$(dirname "$0")/pms.service" | sudo tee /etc/systemd/system/pms.service >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable pms.service
    echo "  installiert und aktiviert (noch nicht gestartet — erst deploy.sh)"
else
    echo "  übersprungen: $CHECKOUT gibt es noch nicht. Erst deploy.sh, dann provision.sh nochmal."
fi

say "Fertig"
cat <<'NEXT'
  Als nächstes, in dieser Reihenfolge:

    1. sudo tailscale up                      (einmalig anmelden)
    2. tailscale serve --bg 5174              (TLS-Name auf den Port legen)
    3. Vom Arbeitsrechner: deploy/pi/deploy.sh
    4. deploy/pi/stress.sh                    (prüft das Netzteil unter Last)

  data/ wird von deploy.sh nie angefasst. Es wird auch von diesem Skript nicht
  wiederhergestellt — dafür gibt es backup.sh, und ohne ein Backup ist der Verlauf
  (und damit jedes Rückgängig) nach einem SD-Kartenschaden weg.
NEXT
