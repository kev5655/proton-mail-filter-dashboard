#!/usr/bin/env bash
#
# Ships this checkout to the Pi and restarts the service. Runs *on the workstation*.
#
#   deploy/pi/deploy.sh                       # to $PMS_PI_HOST, default pi@raspberrypi
#   PMS_PI_HOST=pi@192.168.1.52 deploy/pi/deploy.sh
#
# rsync rather than `git clone`: the repository is private, and a clone on the Pi would mean a
# deploy key living on the machine that is exposed to the tailnet. This way the Pi needs no
# credential of any kind, and the workstation stays the only place that can reach GitHub.
#
# data/ is excluded in both directions and is never touched by a deploy.

set -euo pipefail

PI_HOST="${PMS_PI_HOST:-pi@raspberrypi}"
CHECKOUT="${PMS_CHECKOUT:-github/private/proton-mail-sorter}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${PMS_SERVER_PORT:-5174}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

cd "$REPO_ROOT"

if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "Hinweis: der Checkout hat uncommittete Änderungen — die gehen mit." >&2
fi

say "Übertragen nach $PI_HOST:~/$CHECKOUT"
ssh "$PI_HOST" "mkdir -p ~/$CHECKOUT"
rsync -az --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'data' \
    --exclude 'release' \
    --exclude 'test-results' \
    --exclude '*.log' \
    ./ "$PI_HOST:~/$CHECKOUT/"

say "Abhängigkeiten und Build"
# --frozen-lockfile so the Pi can never resolve a different tree than the one that was tested
# here. A deploy that quietly upgrades a dependency is a deploy nobody reviewed.
ssh "$PI_HOST" "bash -lc '
    set -euo pipefail
    export PATH=\"\$HOME/.local/node/bin:\$PATH\"
    cd ~/$CHECKOUT
    corepack pnpm install --frozen-lockfile
    corepack pnpm build:vendor
    corepack pnpm --filter @pms/web build
'"

say "Dienst neu starten"
# systemctl needs a password unless sudo is passwordless for it; when it is not, say so plainly
# instead of hanging on an invisible prompt.
if ssh "$PI_HOST" 'sudo -n systemctl restart pms.service' 2>/dev/null; then
    echo "  neu gestartet"
else
    echo "  ✗ konnte den Dienst nicht neu starten (sudo verlangt ein Passwort)."
    echo "    Auf dem Pi:  sudo systemctl restart pms.service"
    exit 1
fi

say "Erreichbarkeit"
sleep 3
# `-f` bewusst nicht: ein 404 ist eine Antwort und bedeutet etwas anderes als Stille.
CODE="$(ssh "$PI_HOST" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:$PORT/" || echo 000)"
case "$CODE" in
    200)
        echo "  ✓ Das Dashboard antwortet auf Port $PORT."
        ;;
    404)
        echo "  △ Der Server läuft, liefert die Seite aber nicht aus (404)."
        echo "    PMS_WEB_ROOT fehlt oder zeigt daneben. Ohne sie bedient dieser Prozess nur"
        echo "    die API, und die Seite käme von einem zweiten Port — zwei Origins für ein"
        echo "    Postfach, und tailscale müsste beide kennen."
        echo "    In ~/$CHECKOUT/.env.pi eintragen:"
        echo "      PMS_WEB_ROOT=\$HOME/$CHECKOUT/apps/web/dist"
        exit 1
        ;;
    000)
        echo "  ✗ Keine Antwort auf Port $PORT."
        echo "    Log:  ssh $PI_HOST journalctl -u pms -n 50 --no-pager"
        exit 1
        ;;
    *)
        echo "  ✗ Unerwartete Antwort: HTTP $CODE"
        echo "    Log:  ssh $PI_HOST journalctl -u pms -n 50 --no-pager"
        exit 1
        ;;
esac

say "Fertig"
echo "  Sperrbildschirm öffnen unter dem tailscale-Namen, oder im LAN über http://<pi>:$PORT/"
