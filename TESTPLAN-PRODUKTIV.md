# Was nur du prüfen kannst

Alles, was ohne dein Konto prüfbar ist, prüft die Testsuite: **1004 Tests ohne Netz** und **34 im
echten Browser**. Was hier steht, kann sie nicht — es braucht ein echtes Proton-Konto, echte Mail
oder ein echtes Gerät.

Der alte Plan hatte 1045 Zeilen und war überwiegend Protokoll. Der steht in der Git-Historie
(`git log -- TESTPLAN-PRODUKTIV.md`); hier steht nur noch, was offen ist.

**Reihenfolge einhalten.** T-1 bis T-3 bauen aufeinander auf. Danach ist es egal.

**Melde immer:** was du erwartet hast, was passiert ist, und den Fehlercode, falls einer kam
(`APPLY_…`, `PROTON_…`, `SERVER_…` — die stehen auf dem Bildschirm und sind im Log auffindbar).

---

## Vorher

```sh
pnpm install
pnpm serve       # Terminal 1 — hält die Sitzung
pnpm dev         # Terminal 2 — http://localhost:5173
```

Leg dir in Proton **einen Wegwerf-Ordner** an, z. B. `Test-1234`, und schick dir 3–5 Mails von einer
Adresse, die sonst nichts trifft. Alles unten passiert an diesem Ordner.

---

## T-1 · Schreibt es überhaupt, und schreibt es das Richtige?

Der Kern. Bis das einmal sauber durchgelaufen ist, ist alles andere Theorie.

1. Auf **Ordner** den Wegwerf-Ordner anlegen.
2. Auf **Regeln** eine Regel bauen, die nur deine Testadresse trifft, Ziel: der Wegwerf-Ordner.
3. **Bestätigen.** Lies den Diff, bevor du klickst: Er soll genau deine 3–5 Mails nennen.
4. In Proton nachsehen.

**Erwartet:** Der Ordner existiert. Der Filter steht in Protons eigener Oberfläche und ist dort
lesbar. Nach dem Häkchen „Bestand einbeziehen" liegen die alten Mails im Ordner.

**Melde:** ob die Zahl im Diff der Zahl im Ordner entspricht. Weicht sie ab, ist das der wichtigste
Befund, den es gibt.

---

## T-2 · Die zweite Frage kommt jetzt woanders

**Das ist neu und hat sich geändert.** Früher fragte das Terminal, in dem `pnpm serve` läuft. Jetzt
fragt das Dashboard nach deinem App-Passwort — direkt neben dem Diff.

1. Auf **Vorschläge** oder **Kategorien** eine Verschiebung in eine Proton-Kategorie vormerken.
2. Der Dialog verlangt das App-Passwort.

**Erwartet:** Ein falsches Passwort wird abgelehnt und schreibt nichts. **Abbrechen** bricht sofort
ab, ohne fünf Minuten zu warten. Im Terminal steht **keine** Frage mehr.

**Melde:** ob irgendwo noch „Bestätigung im Terminal" steht. Das wäre ein Rest, den ich übersehen
habe.

---

## T-3 · Rückgängig

1. Nimm T-1 zurück: **Verlauf → Rückgängig**.
2. In Proton nachsehen.

**Erwartet:** Die Regel ist weg **und** die Mails liegen wieder dort, wo sie vorher waren — nicht
alles aus dem Ordner, sondern genau die, die die Regel bewegt hat. Was du zwischendurch von Hand
verschoben hast, bleibt liegen und wird namentlich gemeldet.

3. Danach **Bis hierhin zurück** über zwei Änderungen ausprobieren.

**Melde:** ob eine Mail an einem Ort landet, an dem sie vorher nicht war.

---

## T-4 · Das Datum im Verlauf

Kurz, aber bitte hinsehen: Der Verlauf zeigte Änderungen im **Jahr 58647**. Das ist repariert, und
beim ersten Start nach diesem Update rechnet eine Migration deine vorhandenen Einträge um.

**Erwartet:** Jeder Eintrag im Verlauf trägt ein plausibles Datum — auch die alten von vor dem
Update.

---

## T-5 · Kategorien — die vier offenen Fragen

Hier weiss das Projekt Dinge **nicht**, und der Bildschirm sagt das auch. Nur du kannst sie
beantworten. Nimm dafür **eine einzelne Mail**.

Verschiebe sie über **Kategorien** nach „Transaktionen" und sieh in Protons App nach:

| # | Frage | Erwartung |
| --- | --- | --- |
| 1 | Liegt sie wirklich in der neuen Kategorie? | ja |
| 2 | Ist die **alte** Kategorie weg, ohne dass wir sie entfernt haben? | vermutlich ja, ungeprüft |
| 3 | Bewegt sich nur **diese eine Mail** oder der ganze Thread? | nur diese |
| 4 | Ist sie aus dem **Posteingang** verschwunden? | unbekannt |

Frage 3 ist die wichtigste: Wir schicken absichtlich die Mail-Variante und nicht die
Konversations-Variante. Wenn sich der ganze Thread bewegt, ist das ein Fehler in unserer Annahme und
muss sofort gemeldet werden.

**Und die eigentliche Frage:** Lernt Proton daraus? Schieb über ein paar Tage mehrere Mails desselben
Absenders um und sieh nach, ob neue Mail dieses Absenders von selbst dort landet. Der Reiter
„Auto-Regeln" **beobachtet** nur — er kann das nicht wissen, und behauptet es auch nicht.

---

## T-6 · Auf dem Handy

**Neu.** Die Oberfläche war auf dem Handy unbrauchbar; das ist der Punkt dieses Durchgangs.

1. Öffne das Dashboard auf dem Handy (siehe T-7, sonst im WLAN über die IP).
2. Durchgehen: **Vorschläge**, **Regeln**, **Ordner**, **Verlauf**, **Einstellungen**.

**Erwartet:**

- **Nichts lässt sich seitwärts schieben.** Kein Bildschirm, keine Liste, kein Menü.
- Die Navigation **bricht um** statt zu scrollen — alle acht Einträge sind ohne Wischen sichtbar.
- **Synchronisieren und Abmelden stehen ganz unten**, nach dem Inhalt. Der Hinweis, welches Postfach
  du siehst, steht weiterhin **oben** — der muss vor der Liste kommen.
- Auf **Ordner** sind Umbenennen und Löschen **Icons**, und der Ordnername ist lesbar.
- **Wischen** über eine Ordnerzeile — links oder rechts — öffnet den Diff. **Es löscht nicht.** Wenn
  eine Wischgeste je etwas ohne Diff löscht, sofort melden.
- Beim Scrollen durch eine Liste löst das Wischen **nicht** versehentlich aus.

**Melde:** jede Stelle, an der du seitwärts schieben kannst, und jede, an der ein Knopf den Text
verdrängt.

---

## T-7 · Von überall erreichbar

**Neu.** Eine Instanz, von allen Geräten aus — keine zweite Installation, die sich selbst anmeldet.

Der Aufbau steht jetzt im Repo `homelab`: der Dienst läuft als Container, und ein
Tailscale-Sidecar daneben gibt ihm einen eigenen Namen mit eigenem Zertifikat. Auf dem Pi also
nicht mehr `pnpm serve`, sondern:

```sh
cd homelab/stacks/proton-mail-sorter
docker compose up -d
# Den Namen, den der Sidecar bekommt, in .env als PMS_PUBLIC_ORIGIN eintragen
# — und in hosts/pi/starter.env, sonst lehnt der Starter jede Anfrage ab.
```

**Erwartet:**

1. Die Adresse öffnet sich auf dem Handy, mit gültigem Zertifikat.
2. **Zum Startbildschirm hinzufügen** gibt ein eigenes Icon (violett, drei Striche und ein Ring) und
   öffnet ohne Browserleiste.
3. Ein **Passkey muss neu registriert werden** — er hängt am Namen. Das Passwort geht wie vorher.
4. Ändern (Regel anlegen, bestätigen) funktioniert vom Handy aus vollständig.

**Melde:** wenn eine Änderung mit **403** und `SERVER_ORIGIN_REFUSED` abgelehnt wird. Dann stimmt
`PMS_PUBLIC_ORIGIN` nicht mit der Adresse überein, unter der du die Seite offen hast.

---

## T-8 · Ausblenden

**Neu.** „Nicht vorschlagen" hiess früher so und vergass alles beim Neuladen.

1. Auf **Vorschläge** zwei Vorschläge **Ausblenden**.
2. Seite neu laden.
3. Reiter **Ausgeblendet** aufklappen, einen **Wieder einblenden**.

**Erwartet:** Nach dem Neuladen sind beide noch ausgeblendet. Der Reiter ist zugeklappt und zählt
richtig. Auf einem **zweiten Gerät** ist dieselbe Liste zu sehen — das ist der Grund, warum es in
der Datenbank steht und nicht im Browser.

---

## T-9 · Anmelden über die Website

1. In der Seitenleiste **Bei Proton anmelden**.
2. Ein Browserfenster öffnet Protons eigene Seite.

**Erwartet:** Dein Passwortmanager füllt dort aus wie auf jeder anderen Seite. **Kein Passwort geht
durch dieses Programm.** Direkt nach der Anmeldung läuft **von selbst ein Sync** — das ist neu.

**Wichtig:** Bei einer Ablehnung **nicht noch einmal drücken.** Ein Versuch, dann Schluss. Das Konto
hatte schon einmal eine 2028-Sperre, und die kam vom Hämmern. Freigeben nur mit
`pnpm spike --lockout-cleared`, nachdem du dich bei mail.proton.me eingeloggt und gesehen hast, dass
das Konto erreichbar ist.

---

## T-10 · Das heruntergeladene Paket

Nur wenn du es ausliefern willst.

1. Auf GitHub **Actions → Release → Run workflow**.
2. Archiv für dein System herunterladen, **auf einem Rechner ohne Node** entpacken, Starter
   ausführen.

**Erwartet:** Es startet, `data/` liegt **neben** dem Starter (sichtbar und löschbar), und ohne
Konto zeigt es den Sperrbildschirm. macOS und Windows warnen vor unsignierter Software — das ist
erwartet. Für Intel-Macs gibt es kein Paket.

---

## Was ich seit dem letzten Durchgang selbst geprüft habe

Damit du es nicht doppelt tust:

- **1004 Unit-Tests, 34 E2E**, Typen und Build sauber.
- Der Zeitstempel-Fehler und seine Migration, gegengeprüft durch Wiedereinbau.
- Dass eine Bestätigung ohne Terminal **sofort ablehnt** statt zwei Minuten zu warten.
- Dass kein Bildschirm bei acht Breiten von 1440 bis 390 seitwärts scrollt — die Navigation hat
  dabei keine Ausnahme mehr.
- Dass die Wischgeste stellt und nicht löscht, und dass ein senkrechter Zug sie nicht auslöst.
- Dass ein POST von fremder Herkunft mit 403 abgelehnt wird und der Entwicklungsmodus trotzdem geht.
- Dass der Service Worker **niemals** eine `/api`-Antwort zwischenspeichert.
- Dass es genau **sieben** Nicht-GET-Routen sind — unverändert. Anhalten und Starten laufen über
  den Starter auf dem Host, nicht über eine achte Route.
- Dass ein offener Dashboard-Tab den Server **nicht mehr am Beenden hindert**. Das tat er, und unter
  `docker stop` hätte es nach zehn Sekunden ein SIGKILL mitten in einem Datenbankschreibvorgang
  gegeben.

## T-11 · Ein zweites Konto

**Neu**, und nur wenn du es brauchst. Bitte an einem **zweiten** Proton-Konto ausprobieren, nicht am
produktiven.

1. Im Dashboard abschliessen (Schloss), dann auf dem Sperrbildschirm ein neues Konto anlegen.
2. Wieder abschliessen und mit **Name und Passwort des ersten** aufschliessen.

**Erwartet:**

- Der Sperrbildschirm fragt ab jetzt nach dem **Namen** — und listet die Konten **nicht** auf.
- Das Passwort von Konto A schliesst Konto B **nicht** auf, und umgekehrt.
- Jedes Konto hat seinen eigenen Verlauf, seine eigenen Ordner und seine eigene Proton-Verbindung.
  Konto B ist **nicht** bei Proton angemeldet, nur weil A es war.
- Die Dateien von Konto A liegen weiterhin genau dort, wo sie vorher lagen — es wurde nichts
  verschoben.

**Melde sofort**, wenn du in einem Konto irgendetwas vom anderen siehst.

## T-12 · Anhalten und wieder starten

**Neu**, und der Teil, den ich am wenigsten prüfen konnte: das Image ist hier nie gebaut worden,
weil diese Umgebung keine Verbindung zur npm-Registry hat. Der erste echte Build ist deiner.

1. In der Seitenleiste **Server anhalten**, den Dialog lesen, bestätigen.
2. Die Seite lädt neu und zeigt **„Der Server ist angehalten"** mit einem Startknopf.
3. **Server starten** drücken, warten, **Nachsehen**.

**Erwartet:**

- Der Weck-Bildschirm erscheint auch **vom Handy aus** und **von unterwegs** — der Sidecar läuft
  weiter, deshalb bleibt der Name erreichbar, obwohl der Dienst steht.
- Nach dem Start kommt der **Sperrbildschirm**, nicht das Postfach. Starten gibt nichts frei.
- Es wurde **nichts gelöscht**: Verlauf, Ordner und Proton-Verbindung sind nach dem Start dieselben.
- Auf einem Rechner **ohne** Pi (also `pnpm dev` allein) erscheint der Knopf **nicht** — dort gibt
  es keine Maschine zu starten.

**Melde:** wie lange der Start auf dem Pi wirklich dauert. Wenn das unzumutbar lang ist, ist das ein
Befund und kein Detail — dann muss der Container anders geschnitten werden.

**Und melde**, ob `tailscale serve --set-path /starter` den Pfad beim Weiterleiten abschneidet. Der
Starter nimmt vorerst beide Formen an; sobald es einmal gelaufen ist, fliegt die falsche raus.

---

## Was noch nicht gebaut ist

- **Ein Umschalt-Knopf** zwischen Konten. Abschliessen und als jemand anderes aufschliessen ist
  derselbe Vorgang, und den gibt es.
- **Ein Knopf, der den Pi herunterfährt.** Ohne Taster an GPIO3 gäbe es keinen Weg zurück — das
  wäre keine Funktion, sondern eine Falle. Deshalb hält der Knopf nur den Dienst an, und das
  spart bewusst **keinen Strom**: der Rechner läuft weiter.
- **Wake-on-LAN aus der App.** Geht nicht, und zwar doppelt: ein Browser hat keinen UDP-Socket, und
  ein Pi 4 hat überhaupt keinen Weckpfad übers Netz (`/sys/power/state` ist leer).
