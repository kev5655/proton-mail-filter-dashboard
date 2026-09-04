# Testplan — das Dashboard am echten Postfach

**Hier steht nur, was ich nicht selbst testen kann.** Das ist im Kern eine Sorte Frage: *stimmt,
was das Werkzeug über dein Postfach behauptet* — und, neu und wichtiger: *tut es am Konto wirklich
nur das, was es ankündigt*.

Der alte `TESTPLAN.md` ist weg. T-04 und T-05 sind erledigt oder abgeräumt, **T-13 hat bestanden**
(dein Lauf zeigte `cookieMode:true`, `session refreshed` und danach „Gespeicherte Sitzung
wiederverwendet" — der blind gemachte Fix stimmt), T-12 bleibt zurückgestellt.

**Was ich seit dem letzten Mal selbst geprüft habe** und deshalb nicht hier steht: 562 Tests,
nichts übersprungen; der Protokoll-Absturz (mit einem Test, der ihn wieder findet, wenn er
zurückkommt); das seitliche Scrollen; Blättern und Suchen in allen Listen; die Live-Vorschau des
Regeleditors gegen den geprüften Matcher über elf Regelformen; der Round-Trip „Regel öffnen und
unverändert speichern"; dass ein abgelehntes, abgelaufenes oder veraltetes Angebot **null**
schreibende Aufrufe erzeugt; dass Undo nur die IDs aus dem Journal bewegt; und dass ein Angebot
ohne Antwort im Terminal unbegrenzt liegen bleibt, ohne dass etwas geschrieben wird.

**So benutzen wir diese Datei.** Befund unter den Test, Ausgabe oder Screenshot reicht. Ich
antworte unter `Fix:`.

Status pro Test: `offen` · `ok` · `Fehler` · `behoben`

---

## Loslegen

```sh
pnpm install     # neue Pakete: @pms/apply
```

**Läuft `pnpm dev` noch? Einmal beenden und neu starten** — ein laufender Vite-Server kennt die
neuen Workspace-Pakete nicht.

Dann zwei Terminals:

```sh
pnpm serve       # Terminal 1 — hält die Sitzung, fragt hier nach, bevor etwas geschrieben wird
pnpm dev         # Terminal 2 — http://localhost:5173
```

`pnpm serve` meldet sich jetzt beim Start an (gespeicherte Sitzung, kein Browser). Das ist neu und
nötig, damit Sync und Schreiben aus dem Dashboard überhaupt gehen.

---

# Der Schreibweg

Das Wichtigste. Bitte in dieser Reihenfolge.

## P-01 · Ohne „ja" passiert nichts

Der Test der zentralen Zusage. **Bitte wirklich machen** — alles andere hängt daran.

1. Im Dashboard eine harmlose Regel bauen (Zielordner: ein Wegwerf-Name wie `Test-Sortierung`).
2. Auf „Bei Proton speichern" klicken.
3. Im Dashboard steht jetzt eine Prüfziffer, im Terminal die Rückfrage mit derselben.
4. **Weggehen.** Nichts tippen.

**Erwartet:** Nach zwei Minuten läuft die Rückfrage ab. In Protons Oberfläche existiert weder die
Regel noch der Ordner. Danach dasselbe mit `nein` statt `ja`.

Und einmal von aussen, ohne Dashboard:

```sh
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"requestId":"x","createdAt":1,"change":{"id":"c","kind":"create-rule","summary":"Test"},"plan":{"moves":[],"clearedFromInbox":0,"returnedToInbox":0,"takenFrom":[]},"affectedMessageIds":[],"applyToExisting":false,"baseVersion":"egal"}' \
  http://127.0.0.1:5174/api/apply
```

Das muss `202` antworten, im Terminal eine Rückfrage auslösen — und wenn du nichts tippst, darf sich
am Konto nichts ändern.

Status: `offen`

**Befund:**

**Fix:**

---

## P-02 · Ein vollständiger Umlauf auf einem Wegwerf-Ordner

Jetzt mit `ja`.

1. Regel anlegen, bestätigen.
2. **In Protons Oberfläche nachsehen:** Ist der Filter da? Heisst er richtig? Zeigt er auf den
   richtigen Ordner? Sind die Bedingungen dieselben?
3. Zurück im Dashboard: stimmt die gemeldete Zahl einsortierter Mails mit dem überein, was Proton
   zeigt? Ein Teilergebnis („17 von 20") ist ein gültiges Ergebnis und **kein Fehler** — ich will
   nur wissen, ob es ehrlich gemeldet wurde.
4. Sicherung ansehen: unter `data/backups/proton-*.json` muss eine Datei liegen, die alle Filter
   und Ordner enthält. **Bitte einmal öffnen** — eine Sicherung, die niemand lesen kann, ist keine.
5. Im Verlauf „Rückgängig".
6. **Wieder in Protons Oberfläche nachsehen:** Filter weg? Mail zurück, wo sie war?

**Der wichtigste Teil:** Leg vor Schritt 5 von Hand eine Mail in den Zielordner, die nicht von der
Regel stammt. Nach dem Rückgängig **muss sie dort liegen bleiben**. Wenn nicht, hör bitte sofort
auf und sag es mir — dann verschiebt Undo Dinge, die es nicht anfassen darf.

Status: `offen`

**Befund:**

**Fix:**

---

## P-03 · Wo landet ein neuer Filter?

Eine Frage, die ich nicht beantworten kann und von der jeder Diff abhängt.

Nach P-02: Steht der neue Filter in Protons Liste **oben oder unten**? Bei Filtern ist die
Reihenfolge das Ergebnis — der letzte, der einsortiert, gewinnt. Wenn Proton neue Filter vorne
einfügt, überschreibt jede neue Regel alle bestehenden, und meine Diff-Rechnung sagt das Gegenteil.

Status: `offen`

**Befund:**

**Fix:**

---

## P-04 · Nimmt Proton unsere Filter an, wie wir sie schicken?

Bau eine Regel mit `beginnt mit` und eine mit `passt auf das Muster`. Nach dem Speichern in Protons
Oberfläche ansehen:

- Sind sie dort noch **klickbar** (also als normaler Filter, nicht als Skript)?
- Steht dieselbe Bedingung da, die du eingegeben hast?

Hintergrund: Protons eigene Kompilierung von `beginnt mit` ist fehlerhaft — ein `*` im Wert wird so
maskiert, dass die Regel fast nichts mehr trifft. Der Editor warnt vorher, aber ich habe nie
gesehen, was Proton am Ende wirklich speichert.

Status: `offen`

**Befund:**

**Fix:**

---

# Das Dashboard

## P-05 · Stimmt, was da steht?

Abgleich mit Protons Oberfläche: dieselben Ordner in derselben Verschachtelung, dieselbe Anzahl
Regeln, plausible Mailzahlen, und der Stand im Banner passt zum letzten Sync.

**Nachrechnen:** Regeln im Dashboard **+** die im Banner genannten nicht-lesbaren Filter **=** Filter
in Protons Liste. Geht die Summe nicht auf, fehlt etwas stillschweigend.

Status: `offen`

**Befund:**

**Fix:**

---

## P-06 · Der Regeleditor an deinen echten Regeln

Neu: links die Liste, rechts der Editor mit Name, Bedingungen, Aktionen und Vorschau gleichzeitig.

- **Eine Regel öffnen und nichts ändern** — es darf kein „Nicht gespeichert" erscheinen.
- **Etwas ändern** — die zwei Spalten müssen sofort reagieren, und oben muss `+N / −N` gegenüber
  der gespeicherten Regel stehen. Stimmt das mit dem überein, was du erwartest?
- **Beide Spalten durchsuchen.** Die rechte zeigt standardmässig nur verwandte Absender; der
  Schalter „alle übrigen zeigen" macht daraus das ganze Postfach. Ist das die richtige Vorgabe?
- **Dein Newsletter-Filter** ist als Sieve geschrieben und deshalb erst schreibgeschützt. Beim
  Umwandeln: passt danach noch, was er trifft?
- **Warnungen** — „trifft nichts" und „wirkungslos" sind Behauptungen über dein Postfach. Stimmen
  sie? Eine falsche Warnung ist schlimmer als keine.

Status: `offen`

**Befund:**

**Fix:**

---

## P-07 · Kategorien

Neuer Reiter. Proton sortiert Werbung, Newsletter und so weiter selbst — der Bildschirm zeigt, was
dabei zusammenkommt, und wo eine **eigene** Regel dieselbe Arbeit ein zweites Mal macht.

- Sind die Kategorien die, die du in Proton siehst?
- Taucht eine „unbekannte ID" auf? Falls ja: wie heisst sie bei Proton? Die IDs 20–26 sind geraten,
  und deine Antwort ist die einzige Möglichkeit, sie zu korrigieren.
- Stimmt der Hinweis, wo eine eigene Regel überflüssig ist?

Status: `offen`

**Befund:**

**Fix:**

---

## P-08 · Sync aus dem Dashboard

Knopf in der Seitenleiste.

- Läuft der Balken? Nennt er die Phase und die Zahlen?
- Solange Proton keine Gesamtzahl gemeldet hat, ist der Balken **absichtlich unbestimmt** — er
  wandert, statt eine erfundene Prozentzahl zu zeigen.
- Danach: neue Zahlen ohne Neuladen?
- Rund eine Sekunde pro hundert Mails ist die Drosselung und kein Hänger.

Status: `offen`

**Befund:**

**Fix:**

---

## P-09 · Vorschläge und Sprachmodell

- Vorschläge sind jetzt in „Nach Absender", „Nach Betreff" und „Nach Organisation" gruppiert.
  **Es gibt bewusst kein „Nach Inhalt"** — dafür bräuchte es die Mailinhalte, und die gibt es noch
  nicht. Eine Überschrift ohne die Gruppierung dahinter wäre eine Lüge.
- Mails, die eine bestehende Regel schon fängt, sind markiert. Stimmt das?
- Alle Mails einer Gruppe sind sichtbar, zehn pro Seite. Vorher waren es immer fünf, auch wenn der
  Knopf „17 Mails ansehen" sagte.
- Ohne Sprachmodell steht überall, wo eines gefehlt hat, ein Hinweis mit „Einrichten". Unter
  Einstellungen lässt sich Ollama eintragen. Auf deinem Rechner läuft es gerade nicht und es ist
  kein Modell geladen — `ollama serve` und `ollama pull qwen2.5:7b`, falls du magst. **Das
  Dashboard funktioniert ohne.**

Status: `offen`

**Befund:**

**Fix:**

---

# Sicherheit

## S-01 · Eine echte Mail öffnen

**Der letzte Durchgang ist aus dem falschen Grund durchgegangen.** Der Viewer holte den Inhalt aus
dem Demo-Paket; für eine echte Mail fand er nichts und zeigte „Diese Demo-Mail hat keinen eigenen
Inhalt". Es waren keine Bilder drin, weil keine Mail drin war.

Jetzt sagt der Viewer, dass es keinen Inhalt gibt, und bietet den Link zu Proton an.

- Steht der Hinweis da, statt eines leeren Rahmens?
- Führt der Link zur richtigen Mail? **Die Adressform ist geraten** — falls er danebengeht, lässt
  sie sich unter Einstellungen korrigieren, und ich will wissen, wie sie richtig lautet.

Status: `offen`

**Befund:**

**Fix:**

---

## S-02 · Am Konto nur das, was angekündigt war

Nach allem Testen in Protons Oberfläche durchsehen:

- Nur die Filter, die du bestätigt hast — kein zusätzlicher.
- Nur die Ordner, die du bestätigt hast.
- Keine Mail an einer Stelle, die du nicht erwartest.

Status: `offen`

**Befund:**

**Fix:**

---

## Was noch nicht da ist

- **Mailinhalte.** Der Weg dafür ist Proton Mail Bridge. Sie ist auf deinem Rechner entpackt, aber
  unkonfiguriert — es fehlt eine Abhängigkeit:

  ```sh
  sudo apt-get install -f     # zieht fonts-dejavu nach
  protonmail-bridge --cli     # anmelden, dann `info` für die IMAP-Zugangsdaten
  ```

  Danach kann ich das Paket bauen, das die Inhalte holt. Am Binary habe ich schon geprüft, dass
  Bridge den Header `X-Pm-Internal-Id` setzt — damit lassen sich unsere Nachrichten-IDs ohne Raten
  zuordnen. Erst dann werden Inhaltssuche und eine echte Gruppierung „nach Inhalt" möglich, und
  erst dann ist S-01 ein Test, der etwas beweist.
- **Regel verfeinern durch Mail-Entfernen.** Die Naht ist da (die Vorschau-Zeilen haben schon einen
  Platz für Aktionen), gebaut ist es nicht.
- **Echte Drift-Erkennung.** „Änderungen" zeigt auf einem echten Konto jetzt nichts mehr statt
  erfundener Einträge. Was fehlt, ist der Vergleich mit dem, was beim letzten Sync bekannt war.
- **Reihenfolge der Regeln ändern.** Bei Filtern ist die Reihenfolge das Ergebnis — das verdient
  einen eigenen Diff und kommt separat.
