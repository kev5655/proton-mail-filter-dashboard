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

**Befund:**

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

## Offene Punkte ausserhalb der Tests

- **Git-History.** `fixtures/recorded/filters.json` mit echten Werten liegt in Commit `0057c6c` auf
  dem öffentlichen Remote. Lokal ist die History bereinigt; der Remote braucht einen Force-Push, den
  du selbst ausführen musst — die Befehle stehen in meiner Nachricht dazu.
- **Fixture kommt zurück.** Nach `T-01` liegt eine frisch pseudonymisierte `filters.json` wieder da.
  Erst nach `T-02` committen. `fixture-safety.test.ts` prüft sie zusätzlich bei jedem `pnpm test`.
- **Passkey.** Funktioniert im eigenen Browser-Profil nicht, weil dort 1Password fehlt. TOTP ist der
  bequemere Weg, weil der Code automatisch eingetragen wird.

---

## Was du hier sonst noch hinschreiben kannst

Alles, was dir beim Benutzen auffällt und keinem Test zuzuordnen ist — Formulierungen, die
irreführen, Ausgaben, die zu viel oder zu wenig sagen, Abläufe, die sich falsch anfühlen. Das ist
genauso nützlich wie ein Absturz.

**Sonstiges:**
