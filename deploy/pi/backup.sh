#!/usr/bin/env bash
#
# Holt data/ vom Pi auf den Arbeitsrechner. Läuft *auf dem Arbeitsrechner*.
#
#   deploy/pi/backup.sh                    # nach ~/pms-backups/<datum>/
#   PMS_BACKUP_DIR=/mnt/nas/pms deploy/pi/backup.sh
#
# Dies ist der einzige Teil, den provision.sh nicht wiederherstellen kann.
#
# Was in data/ steckt und sonst nirgends existiert:
#
#   mailbox.db  journal_entries      — Rückgängig arbeitet daraus. Ohne die Tabelle lässt sich
#                                      keine Änderung mehr zurücknehmen, auch eine von gestern.
#               category_observations — „Auto-Regeln" schliesst aus Wiederholung über Wochen.
#                                      Neu aufgebaut heisst: wochenlang wieder blind.
#               hidden_suggestions    — jeder ausgeblendete Vorschlag kommt sonst zurück.
#   account.json                      — der gewickelte Schlüssel. Ohne ihn ist mailbox.db Rauschen,
#                                      selbst mit dem richtigen Passwort.
#   backups/                          — jeder Filterstand vor jeder Änderung.
#
# Die eigentliche Mail lässt sich von Proton neu spiegeln. Die vier Zeilen oben nicht.
#
# Die Kopie ist verschlüsselt, wie sie auf dem Pi liegt — dieses Skript entschlüsselt nichts und
# braucht kein Passwort. Das heisst aber auch: ohne das App-Passwort ist das Backup wertlos.
# Es gibt keine Wiederherstellung des Passworts, und das ist Absicht (siehe CLAUDE.md).

set -euo pipefail

PI_HOST="${PMS_PI_HOST:-pi@raspberrypi}"
CHECKOUT="${PMS_CHECKOUT:-github/private/proton-mail-sorter}"
BACKUP_DIR="${PMS_BACKUP_DIR:-$HOME/pms-backups}"
KEEP="${PMS_BACKUP_KEEP:-14}"
STAMP="$(date +%Y-%m-%d_%H%M%S)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# SQLite muss im Ruhezustand kopiert werden. Eine laufende Datenbank mit offenem -wal ergibt
# sonst eine Kopie, die beim Öffnen repariert werden muss — und ein -wal neben einer frischen
# Datenbank ist laut CLAUDE.md ein Weg in die Korruption.
say "Dienst anhalten"
if ssh "$PI_HOST" 'sudo -n systemctl stop pms.service' 2>/dev/null; then
    STOPPED=yes
else
    STOPPED=no
    echo "  konnte nicht anhalten (sudo verlangt ein Passwort)."
    echo "  Die Kopie wird trotzdem gemacht — aber halte den Dienst vorher besser selbst an:"
    echo "    ssh $PI_HOST sudo systemctl stop pms.service"
fi

say "Kopieren nach $BACKUP_DIR/$STAMP"
mkdir -p "$BACKUP_DIR/$STAMP"
rsync -az --info=stats1 "$PI_HOST:~/$CHECKOUT/data/" "$BACKUP_DIR/$STAMP/"

if [ "$STOPPED" = yes ]; then
    say "Dienst wieder starten"
    ssh "$PI_HOST" 'sudo -n systemctl start pms.service'
fi

# Nur schreibgeschützt lesbar: es ist zwar verschlüsselt, aber es ist trotzdem das ganze Postfach.
chmod -R go-rwx "$BACKUP_DIR/$STAMP"

say "Alte Sicherungen aufräumen (behalte $KEEP)"
# shellcheck disable=SC2012
ls -1d "$BACKUP_DIR"/*/ 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do
    echo "  entferne $old"
    rm -rf "$old"
done

say "Fertig"
du -sh "$BACKUP_DIR/$STAMP"
echo
echo "  Zurückspielen nach einem SD-Kartenschaden:"
echo "    1. Karte neu bespielen, ssh einrichten"
echo "    2. deploy/pi/deploy.sh          (Code)"
echo "    3. bash /tmp/pi/provision.sh    (System, Dienst)"
echo "    4. rsync -az $BACKUP_DIR/$STAMP/ $PI_HOST:~/$CHECKOUT/data/"
echo "    5. ssh $PI_HOST sudo systemctl restart pms.service"
