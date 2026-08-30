# Testplan M0

Stand: M0 abgeschlossen — der Spike hat einmal erfolgreich gegen das echte Konto gelesen.

**So benutzen wir diese Datei.** Du trägst gefundene Fehler unter dem jeweiligen Test bei
`Befund:` ein — Ausgabe hineinkopieren reicht, ich brauche keine Analyse. Ich antworte in derselben
Datei unter `Fix:` und setze den Status. Du musst mir nichts erklären, was hier schon steht.

Status pro Test: `offen` · `ok` · `Fehler` · `behoben`

Fixes zu Fehlern aus dieser Datei gehen direkt auf `main`. Alles andere läuft über Feature-Branches.

---

## Vorbereitung

Die zuletzt aufgenommenen Fixtures wurden verworfen — sie stammten aus einem fehlerhaften
Pseudonymisierer (siehe `T-02`). Test `T-01` nimmt sie sauber neu auf.

```sh
pnpm install
pnpm check-types
pnpm test
```

Erwartet: beides ohne Fehler. Aktuell **352 bestanden, 5 übersprungen** — übersprungen wird
`real-filter.test.ts`, weil die dazugehörige Fixture nicht im Repository liegt. Nach `T-01` ist sie
da und die fünf laufen mit.

**Befund:** Ein test ist gefailed:  
```
FAIL  packages/proton-api/test/session-store.test.ts > session store > keeps the file readable only by its owner
AssertionError: expected 438 to be 384 // Object.is equality

- Expected
+ Received

- 384
+ 438

 ❯ packages/proton-api/test/session-store.test.ts:76:22
     74|         const mode = (await stat(path)).mode & 0o777;
     75|
     76|         expect(mode).toBe(0o600);
       |                      ^
     77|     });
     78|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 28 passed | 1 skipped (30)
      Tests  1 failed | 394 passed | 5 skipped (400)
   Start at  15:23:59
   Duration  16.61s (transform 4.41s, setup 0ms, import 13.34s, tests 39.93s, environment 10.64s)

 ELIFECYCLE  Test failed. See above for more details. 
```

**Fix:**

---

## T-01 · Gespeicherte Sitzung wird wiederverwendet

Der wichtigste Test überhaupt. Ein Programm, das sich bei jedem Start neu anmeldet, ist von
Credential Stuffing nicht zu unterscheiden — genau das hat zur Kontosperre geführt.

```sh
pnpm spike
```

**Erwartet**

- **Kein Browser-Fenster.**
- Zeile: `✓ Gespeicherte Sitzung wiederverwendet — keine Anmeldung nötig.`
- Danach Ordner-, Label-, Filter- und Mailzahlen wie beim ersten Lauf.
- Am Ende: `✓ 5 Fixtures geschrieben nach fixtures/recorded/`

**Fehlschlag heisst:** Öffnet sich ein Browser, ist die Sitzungsspeicherung defekt. Bitte dann
**nicht** wiederholt starten, sondern nur die Ausgabe hier eintragen.

Status: `offen`

**Befund:**
- op cli sollte requierd sein. 
- Fehler: 
```
PS C:\Users\Kevin Zahn\github\private\proton-mail-filter-dashboard> pnpm spike
[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides". See https://pnpm.io/settings for the new home of each setting.

> proton-mail-sorter@0.1.0 spike C:\Users\Kevin Zahn\github\private\proton-mail-filter-dashboard
> pnpm --filter @pms/spike start


> @pms/spike@0.1.0 start C:\Users\Kevin Zahn\github\private\proton-mail-filter-dashboard\apps\spike
> vite-node --config ../../vite.config.ts src/main.ts


Proton Mail Sorter — M0 Spike (nur lesend)

Es werden ausschliesslich Daten gelesen. Am Konto wird nichts verändert.
Proton-Passwort und 2FA-Code werden nirgends gespeichert.

Zugangsdaten aus: 1Password (Private/Proton @my.1password.eu)
Sitzungs-Passphrase aus 1Password übernommen.
Anmeldung über das mitgelieferte Chromium, unsichtbar. Profil wird nach der Anmeldung verworfen.

✗ Abgebrochen.

  [BROWSER_NOT_INSTALLED] Der Browser für die Anmeldung liess sich nicht starten.
  → Einmalig `pnpm exec playwright install chromium` ausführen.
  Kontext: {"headless":true}

C:\Users\Kevin Zahn\github\private\proton-mail-filter-dashboard\apps\spike:
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @pms/spike@0.1.0 start: `vite-node --config ../../vite.config.ts src/main.ts`
Exit status 1
 ELIFECYCLE  Command failed with exit code 1.
```
Hat auch nicht funktioniert:
```
PS C:\Users\Kevin Zahn\github\private\proton-mail-filter-dashboard> pnpm exec playwright install chromium
[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were ignored: "pnpm.overrides". See https://pnpm.io/settings for the new home of each setting.
'playwright' is not recognized as an internal or external command,
operable program or batch file.
 ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "playwright" not found
```


**Fix:**

---

## T-02 · Fixtures enthalten keine echten Daten

Hintergrund: Ein Teilstring-Test hat ganze Sieve-Skripte als „Protons eigene Maschinerie"
durchgewunken, samt Absenderfragmenten und Ordnernamen. Das ist behoben; dieser Test prüft es am
Ergebnis.

Nach `T-01`:

Keine Mailadresse darf übrig sein:

```sh
grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' fixtures/recorded/*.json
```

Und alle Zeichenketten im Sieve-Skript auflisten, um sie einmal anzusehen:

```sh
python3 -c "import json,re; \
print('\n'.join(re.findall(r'\"[^\"]*\"', json.load(open('fixtures/recorded/filters.json'))[0]['Sieve'])))"
```

Stehen bleiben dürfen nur Sieve-Vokabeln (`fileinto`, `From`, `i;unicode-casemap`,
`vnd.proton.spam-threshold` und dergleichen). **Jeder Wert, den du selbst eingetragen hast — die
Absenderfragmente deiner Regel und der Zielordner — muss als `s:xxxxxxxx` dastehen.**

**Wenn hier irgendetwas Echtes auftaucht: nicht committen und hier eintragen.**

Status: `offen`

**Befund:**

**Fix:**

---

## T-03 · Der Spike schont Protons API

Zwischen den Ausgabeblöcken (Ordner → Labels → Filter → Zeiträume) soll jeweils rund eine Sekunde
vergehen. Der gesamte Lauf dauert dadurch spürbar länger als die Leitung hergäbe — das ist Absicht.

Wenn alles in einem Rutsch durchrauscht, greift die Drosselung nicht.

Status: `offen`

**Befund:**

**Fix:**

---

## T-04 · Frische Anmeldung mit sichtbarem Chrome

Sitzung beiseitelegen, damit wirklich neu angemeldet wird:

```sh
mv data/session.enc.json data/session.enc.json.bak
PMS_BROWSER_CHANNEL=chrome PMS_BROWSER_HEADLESS=false PMS_BROWSER_PROFILE=data/browser-profile pnpm spike
```

**Interessant ist hier vor allem:** Fragt Proton diesmal noch nach dem zweiten Faktor? Das Profil ist
inzwischen bekannt, es könnte durchlaufen.

Falls 2FA kommt: im Fenster auf den Authentifizierungscode umschalten und dann **stehen lassen** —
den Code trägt der Spike selbst ein.

Zurück zur alten Sitzung, falls etwas schiefgeht:

```sh
mv data/session.enc.json.bak data/session.enc.json
```

Status: `offen`

**Befund:**

**Fix:**

---

## T-05 · Anmeldung ohne Chrome, unsichtbar

Nur sinnvoll, wenn `T-04` gelaufen ist.

```sh
mv data/session.enc.json data/session.enc.json.bak
pnpm spike
```

Ohne die `PMS_BROWSER_*`-Variablen, also mitgeliefertes Chromium ohne Fenster.

**Beide Ausgänge sind gültige Ergebnisse** — ich möchte nur wissen, welcher:

- Es klappt mit TOTP aus 1Password.
- Klarer Abbruch mit `BROWSER_LOGIN_2FA_UNSUPPORTED`, weil unsichtbar niemand umschalten kann.

Was **nicht** passieren darf: ein Hängen ohne Meldung oder ein Fehler, der auf einen CSS-Selektor
zeigt statt zu sagen, was fehlt.

Status: `offen`

**Befund:**

**Fix:**

---

## T-06 · 1Password gibt nie einen Wert preis

```sh
pnpm spike --describe-1password
```

Erwartet: nur Feldnamen und Typen. Taucht irgendwo ein Wert auf, ist das ein Sicherheitsfehler und
hat Vorrang vor allem anderen in dieser Datei.

Status: `offen`

**Befund:**

**Fix:**

---

## T-07 · Das Dashboard

```sh
pnpm dev        # http://localhost:5173
```

Läuft auf **Demo-Daten**, nicht auf deinem Postfach. Der Hinweis dazu muss auf jedem Bildschirm in
der Seitenleiste stehen.

Durchzugehen:

- **Regeln** — eine Regel aufklappen: Bedingungen, getroffene Mails, und bei den Demo-Regeln je eine
  Warnung „trifft nichts" und „wirkungslos".
- **Eine Mail öffnen** — Bilder müssen blockiert sein, mit Schalter zum einmaligen Laden. Nichts darf
  automatisch nachgeladen werden.
- **Auswahl** — mehrere Mails anhaken, unten erscheint „Regel daraus bauen".
- **Ordner** — pro Ordner die Regeln, die dorthin verweisen; Klick springt zur Regel.
- **Vorschläge / Änderungen / Verlauf / Protokoll** — je einmal öffnen, nichts darf leer oder kaputt
  aussehen.

Status: `offen`

**Befund:**

**Fix:**

---

## T-08 · Es wird nichts geschrieben

Gilt für **alle** Läufe oben. Nach dem Testen in Protons Weboberfläche nachsehen:

- Unverändert **ein** Filter, mit demselben Namen und Inhalt.
- Keine neuen, umbenannten oder gelöschten Ordner.
- Keine verschobene Mail.

Der Spike ist rein lesend; die einzige Ausnahme im gesamten Projekt ist Undo, und das gibt es gegen
das echte Konto noch gar nicht.

Status: `offen`

**Befund:**

**Fix:**

---

# Testplan M1 (erster Teil)

Neu dazugekommen: eine **verschlüsselte lokale Datenbank** und ein **Sync**, der dein Postfach
hineinspiegelt. Gelesen wird weiterhin nur; geschrieben wird ausschliesslich auf deine Platte.

Dafür brauchst du den Branch:

```sh
git switch m1-durchstich
pnpm install
```

`T-01` bis `T-08` gelten unverändert auch hier.

---

## T-09 · Der erste Sync

```sh
pnpm sync
```

Standard sind **30 Tage** und höchstens **2000 Mails** — bewusst klein, damit ein erster Lauf nicht
zwanzig Minuten dauert.

**Erwartet**

- Kein Browser (die gespeicherte Sitzung wird wiederverwendet).
- Fortschrittszeilen: erst Ordner und Labels, dann Filter, dann `Mails: 100`, `200`, …
- Danach eine Zusammenfassung, **aus der Datenbank gelesen**, plus dein Ordnerbaum.
- Die Zahlen sollten zu dem passen, was `pnpm spike` gemeldet hat: 15 Ordner, 10 Labels, 1 Filter.

Andere Zeiträume:

```sh
pnpm sync --days 90
pnpm sync --days 365 --max 5000
pnpm sync --days all --max 20000     # dauert lange, ~1 Sekunde pro 100 Mails
```

Status: `offen`

**Befund:**

**Fix:**

---

## T-10 · Die Datenbank ist wirklich verschlüsselt

Das ist der Test, für den das ganze Paket existiert. Nach `T-09`:

```sh
file data/mailbox.db
head -c 16 data/mailbox.db | xxd | head -1
grep -c "Rechnung" data/mailbox.db        # oder ein Wort aus einem echten Betreff
```

**Erwartet**

- `file` sagt **nicht** „SQLite 3.x database", sondern „data".
- Die ersten 16 Bytes sind **nicht** `SQLite format 3`.
- Kein Betreff, kein Absender, kein Tabellenname ist im Klartext zu finden.

Zum Gegencheck, dass es wirklich Daten enthält und nicht nur leer ist: die Zusammenfassung aus
`T-09` kommt aus genau dieser Datei.

Falls du `sqlite3` installiert hast:

```sh
sqlite3 data/mailbox.db ".tables"      # muss scheitern
```

Status: `offen`

**Befund:**

**Fix:**

---

## T-11 · Ein zweiter Sync ersetzt, statt zu verdoppeln

```sh
pnpm sync
```

Zweimal denselben Befehl. Die Zahlen in der Zusammenfassung müssen **gleich bleiben** — nicht
doppelt so hoch werden.

Interessanter Nebentest, wenn du magst: in Proton einen Ordner umbenennen oder einen neuen anlegen,
dann `pnpm sync`. Der Ordnerbaum in der Ausgabe muss das übernehmen, und ein gelöschter Ordner muss
**verschwinden**, nicht stehen bleiben.

Status: `offen`

**Befund:**

**Fix:**

---

## T-12 · Falsche Passphrase, abgebrochener Sync

Zwei Fälle, die im Alltag vorkommen.

**Falsche Passphrase.** Wenn du die Sitzungs-Passphrase in 1Password änderst (oder das Feld
entfernst und beim Prompt etwas anderes eingibst), muss `pnpm sync` mit `VAULT_KEY_REJECTED`
abbrechen und erklären, dass die Datei nur eine Kopie ist und gelöscht werden darf. Danach die
Passphrase zurückstellen.

**Abbruch mitten im Lauf.** Einen längeren Sync starten (`pnpm sync --days 365 --max 5000`) und nach
ein paar Fortschrittszeilen mit `Ctrl+C` abbrechen. Danach nochmal `pnpm sync` — es muss normal
durchlaufen, nicht mit einer beschädigten Datenbank scheitern.

Status: `offen`

**Befund:**

**Fix:**

---

## Offene Punkte ausserhalb der Tests

- **Git-History.** `fixtures/recorded/filters.json` mit echten Werten liegt in Commit `0057c6c` auf
  dem öffentlichen Remote. Lokal ist die History bereinigt; der Remote braucht einen Force-Push, den
  du selbst ausführen musst — die Befehle stehen in meiner Nachricht dazu.
- **Fixture kommt zurück.** Nach `T-01` liegt eine frisch pseudonymisierte `filters.json` wieder da.
  Erst nach `T-02` committen. `fixture-safety.test.ts` prüft sie zusätzlich bei jedem `pnpm test`.
- **Passkey.** Funktioniert im eigenen Browser-Profil nicht, weil dort 1Password fehlt. TOTP ist der
  bequemere Weg, weil der Code automatisch eingetragen wird.
- **Das Dashboard läuft noch auf Demo-Daten.** Der Sync füllt die Datenbank, aber die Oberfläche
  liest sie noch nicht — das ist der nächste Schritt (tRPC-Durchstich). `T-07` prüft weiterhin die
  Demo.
- **Eine Passphrase für alles Lokale.** Sitzungstokens und Postfachkopie teilen sie sich; beides ist
  ersetzbarer lokaler Zustand. Vom Proton-Passwort ist sie weiterhin getrennt, weil das etwas
  anderes schützt.

---

## Was du hier sonst noch hinschreiben kannst

Alles, was dir beim Benutzen auffällt und keinem Test zuzuordnen ist — Formulierungen, die
irreführen, Ausgaben, die zu viel oder zu wenig sagen, Abläufe, die sich falsch anfühlen. Das ist
genauso nützlich wie ein Absturz.

**Sonstiges:**
