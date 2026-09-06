# Der Raspberry Pi

Vier Skripte, damit ein Ausfall ein erneuter Lauf ist und keine Rekonstruktion aus dem Gedächtnis.

| Skript | Läuft auf | Braucht sudo | Tut |
| --- | --- | --- | --- |
| `provision.sh` | dem Pi | ja, einmal | Systempakete, Node, pnpm, Tailscale, den Dienst |
| `deploy.sh` | dem Arbeitsrechner | nein | Code übertragen, bauen, Dienst neu starten |
| `backup.sh` | dem Arbeitsrechner | nein | `data/` herunterladen — das Einzige, was nicht neu gebaut werden kann |
| `stress.sh` | dem Pi | nein | prüft unter Volllast, ob das Netzteil trägt |

## Warum Shell-Skripte und nicht Ansible

Erwogen und verworfen. Ansible wäre das richtigere Werkzeug für zehn Maschinen; hier ist es eine,
und das Einrichten sind ein Dutzend Schritte. Ansible brächte eine Python-Werkzeugkette in ein
Repository, das keine hat, und eine zweite Sprache, in der man nachsehen muss, was eigentlich
passiert. Die Eigenschaft, auf die es ankommt, ist nicht das Werkzeug, sondern dass ein zweiter
Lauf nichts kaputt macht — und die ist hier von Hand geschrieben und beim Schreiben geprüft.

Sollte je ein zweiter Pi dazukommen, ist das der Moment, das umzudrehen.

## Von Null auf laufend

```sh
# 1. Auf dem Arbeitsrechner: Code hinüber
PMS_PI_HOST=pi@192.168.1.52 deploy/pi/deploy.sh          # scheitert beim Dienst — erwartet

# 2. Auf dem Pi: System einrichten
scp -r deploy/pi pi@192.168.1.52:/tmp/
ssh pi@192.168.1.52 'bash /tmp/pi/provision.sh'

# 3. Tailscale anmelden und den Port auf einen Namen legen
ssh pi@192.168.1.52 'sudo tailscale up && tailscale serve --bg 5174'

# 4. Den Namen eintragen, den tailscale ausgibt
ssh pi@192.168.1.52 'echo PMS_PUBLIC_ORIGIN=https://<name>.ts.net >> ~/github/private/proton-mail-sorter/.env.pi'

# 5. Nochmal ausrollen, jetzt startet der Dienst
PMS_PI_HOST=pi@192.168.1.52 deploy/pi/deploy.sh
```

Danach ist jeder weitere Rollout nur noch Schritt 5.

## Nach einem SD-Kartenschaden

Genau dieselben fünf Schritte, plus einer dazwischen:

```sh
rsync -az ~/pms-backups/<datum>/ pi@192.168.1.52:~/github/private/proton-mail-sorter/data/
```

**Ohne diesen Schritt kommt der Dienst hoch und ist leer.** Er ist dann nicht kaputt — er kennt
nur kein Konto mehr, und das Postfach wird beim ersten Sync neu von Proton geholt. Was *nicht*
wiederkommt: der Verlauf, und damit jedes Rückgängig; die Kategorie-Beobachtungen, aus denen
„Auto-Regeln" über Wochen schliesst; die ausgeblendeten Vorschläge; und die Filter-Sicherungen von
vor jeder Änderung. Deshalb `backup.sh`, und deshalb regelmässig.

Die Sicherung ist verschlüsselt, wie sie auf dem Pi liegt. Sie ist ohne das App-Passwort wertlos,
und ein vergessenes Passwort ist endgültig — es gibt keine Wiederherstellung, und das ist Absicht.

### Regelmässig sichern

Auf dem **Arbeitsrechner**, nicht auf dem Pi — eine Kopie auf derselben SD-Karte schützt gegen
nichts, was diese SD-Karte trifft:

```sh
crontab -e
# taeglich um 03:30
30 3 * * * PMS_PI_HOST=pi@192.168.1.52 $HOME/github/private/proton-mail-sorter/deploy/pi/backup.sh >> $HOME/pms-backups/cron.log 2>&1
```

Es hält 14 Stände (`PMS_BACKUP_KEEP`) und hält den Dienst dafür kurz an, damit die Datenbank im
Ruhezustand kopiert wird.

## Zwei Dinge über diese Hardware, die man wissen sollte

**Die Daten liegen auf der SD-Karte.** Der ursprüngliche Plan sah eine SSD vor, weil der Sync viel
schreibt und SD-Karten daran sterben. An diesem Pi hängt keine. Solange das so ist, ist `backup.sh`
nicht Vorsicht, sondern die Voraussetzung dafür, dass der Ausfall nur Zeit kostet. Kommt eine SSD
dazu: `PMS_DATA_DIR` in `.env.pi` auf den Einhängepunkt zeigen, `data/` einmal hinüberkopieren,
und die `ReadWritePaths=`-Zeile in `pms.service` mitziehen.

**Unterspannung ist der leiseste Weg zu einer kaputten Datenbank.** Ein Netzteil, das unter Last
einbricht, schreibt keine Fehlermeldung; es bricht einen Schreibvorgang ab. Deshalb `stress.sh`,
und deshalb einmal nach jedem Wechsel von Netzteil oder Kabel.

## Der Dienst

```sh
ssh pi@192.168.1.52 systemctl status pms
ssh pi@192.168.1.52 journalctl -u pms -f
```

Er startet beim Hochfahren und kommt **gesperrt** hoch: kein Schlüssel, keine offene Datenbank,
nur der Sperrbildschirm. Das ist es, was einen unbeaufsichtigten Autostart vertretbar macht —
offen ist erst etwas, wenn jemand das Passwort getippt hat.

Nach fünf Fehlschlägen in fünf Minuten gibt systemd auf, statt endlos gegen dieselbe Wand zu
starten. Ein Neustartkarussell gegen Proton ist genau das, wogegen `LoginGuard` existiert.
