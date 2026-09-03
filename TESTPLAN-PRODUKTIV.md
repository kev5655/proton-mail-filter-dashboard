# Testplan — das Dashboard auf dem echten Postfach

Die Oberfläche liest jetzt deine lokale, verschlüsselte Kopie statt der Demo.

**Hier steht nur, was ich nicht selbst testen kann.** Das ist im Wesentlichen eine Sorte Frage:
*stimmt, was das Werkzeug über dein Postfach behauptet?* Ich kann prüfen, dass die Maschinerie
konsistent ist — dass der Server nur liest, dass der Banner sagt was er soll, dass ohne Server auf
die Demo zurückgefallen wird. Ob die Ordner dort wirklich deine sind und ob eine Warnung „trifft
nichts" bei *deiner* Regel zutrifft, kann nur jemand mit dem Konto beurteilen.

Was ich schon geprüft habe und deshalb nicht hier steht: `pnpm install`/`check-types`/`test` (432
Tests, nichts übersprungen), Server startet und liefert, Rückfall auf die Demo ohne Server, Vite-Proxy,
`POST` wird mit `405` abgewiesen, Banner-Texte in allen Zuständen, Bild-Blockierung und CSP im
Mail-Viewer, und dass die Datenbank samt WAL-Dateien auch im geöffneten Zustand nichts preisgibt.

**So benutzen wir diese Datei.** Befund unter den Test, Ausgabe oder Screenshot reicht. Ich antworte
unter `Fix:`.

Status pro Test: `offen` · `ok` · `Fehler` · `behoben`

---

## Loslegen

```sh
pnpm install     # das Paket @pms/server ist neu
```

**Läuft `pnpm dev` bei dir noch? Einmal beenden und neu starten** — ein laufender Vite-Server kennt
das neue Workspace-Paket nicht.

Dann zwei Terminals:

```sh
pnpm serve       # Terminal 1 — liest die lokale Kopie, spricht nicht mit Proton
pnpm dev         # Terminal 2 — http://localhost:5173
```

---

## P-01 · Stimmt, was da steht?

Der eigentliche Test. Das Dashboard zeigt jetzt Namen aus deinem Konto — und ich habe keine
Möglichkeit zu prüfen, ob sie richtig sind.

Abgleich mit Protons eigener Oberfläche:

- **Ordner** — dieselben, in derselben Verschachtelung? Fehlt einer, ist einer zu viel?
- **Regeln** — dieselbe Anzahl wie in Protons Filterliste?
- **Mailzahlen pro Ordner** — plausibel?
- **Stand** im Banner — passt er zu dem Zeitpunkt, an dem du `pnpm sync` laufen liessest?

Status: `offen`

**Befund:**

**Fix:**

---

## P-02 · Die Summe muss aufgehen

Der gefährlichste denkbare Fehler: ein Filter, den wir nicht lesen können und stillschweigend
weglassen. Er läuft bei Proton weiter und verschiebt Mail — eine Oberfläche, die ihn verschweigt,
zeigt ein Postfach, das es nicht gibt, und jede Konfliktanalyse darauf ist in der beruhigenden
Richtung falsch.

Deshalb werden solche Filter im Banner genannt:

> **1 Filter nicht lesbar:** *Name*. Sie laufen bei Proton weiter, tauchen hier aber nicht auf.

**Nachrechnen:** Regeln im Dashboard **+** genannte nicht-lesbare Filter **=** Filter in Protons
eigener Liste.

Geht die Summe nicht auf, ist das der wichtigste Befund in dieser Datei.

Status: `offen`

**Befund:**

**Fix:**

---

## P-03 · Sagt die Regelseite die Wahrheit über deine Regeln?

Bisher hast du sie nur an der Demo gesehen, wo ich die Antworten kenne. An deinen Regeln kenne ich
sie nicht.

Pro Regel aufklappen:

- **Bedingungen** — deckungsgleich mit dem, was in Protons Oberfläche steht?
- **Getroffene Mails** — fängt die Regel diese Mails wirklich? Stichprobe genügt.
- **Warnungen** — „trifft nichts" und „wirkungslos" sind Behauptungen über dein Postfach. Wenn eine
  erscheint: stimmt sie? **Eine falsche Warnung ist schlimmer als gar keine**, weil sie dich dazu
  bringt, eine funktionierende Regel zu löschen.

Status: `offen`

**Befund:**

**Fix:**

---

## P-04 · Taugen die Vorschläge an echter Mail?

„Vorschläge" gruppiert deinen Posteingang. Ob das an einem synthetischen Postfach funktioniert, weiss
ich; ob es an deinem etwas Brauchbares findet, nicht.

- Gehört zusammen, was zusammen steht?
- Steht bei jedem Vorschlag nachvollziehbar, *warum* die Gruppe existiert?
- Ist der vorgeschlagene Ordner brauchbar? Die Ordnerwahl ist bewusst noch dumm — Stichwortabgleich,
  kein Modell. Ein schlechter Vorschlag ist erwartet und trotzdem interessant.

Status: `offen`

**Befund:**

**Fix:**

---

## P-05 · Grössere Zeiträume

Bisher nur `--days 15` gelaufen. Braucht dein Konto.

```sh
pnpm sync --days 90
pnpm sync --days 365 --max 5000
```

Rund eine Sekunde pro 100 Mails — ein Jahr dauert Minuten. Das ist die Drosselung und kein Hänger.

- Kein Browser: die gespeicherte Sitzung wird wiederverwendet.
- Danach `pnpm serve` neu starten, Seite neu laden: mehr Mail, neuer Stand.
- Mit `--max 50` absichtlich in die Obergrenze laufen — das Banner muss dann sagen, dass die Kopie
  unvollständig ist.

Status: `offen`

**Befund:**

**Fix:**

---

## P-06 · Fühlt sich die Auswahl richtig an?

Dein gemeldeter Fehler: eine Auswahl aus „Regeln" war in „Ordner" noch da. Das bleibt absichtlich so
— Mail, die zusammengehört, liegt selten an einem Ort. Was gefehlt hat, war die Erklärung:

> **3 Mails ausgewählt** · 2 verschiedene Absender · *aus Regeln*

Der Zusatz erscheint nur für Seiten, auf denen du gerade nicht bist. Das ist eine
Geschmacksentscheidung, keine technische — wenn es sich weiterhin falsch anfühlt, verwerfen wir die
Auswahl beim Wechsel.

Status: `offen`

**Befund:**

**Fix:**

---

# Sicherheit — kurz, aber bitte wirklich

Das Übrige ist durch Tests abgedeckt. Diese zwei sind es nicht, weil sie einen echten Browser oder
Protons Oberfläche brauchen.

Nachgetragen statt aufgeschrieben: dass die Datenbank auch **während** der Server sie offen hält
nichts preisgibt — die `-wal`- und `-shm`-Dateien daneben sind die klassische Leckstelle. SQLCipher
verschlüsselt sie mit; `packages/store/test/encryption.test.ts` prüft es jetzt, statt es anzunehmen.

## S-01 · Eine echte Mail öffnen, mit offenem Netzwerk-Tab

Bilder blockieren und die CSP sind per Unit-Test geprüft — aber nicht in einem echten Browser an
echter Werbemail.

Netzwerk-Tab öffnen (F12), eine Mail mit Bildern öffnen:

- **Keine einzige ausgehende Anfrage**, solange du die Bilder nicht freigibst.
- Nach dem Freigeben für *eine* Mail: die nächste blockiert wieder.

Ein Zählpixel verrät dem Absender deine IP und den Zeitpunkt, an dem du die Mail geöffnet hast —
genau das, wofür ein Proton-Konto existiert. Lädt hier etwas von allein nach, hat das Vorrang vor
allem anderen in dieser Datei.

Status: `offen`

**Befund:**

**Fix:**

---

## S-02 · Bei Proton hat sich nichts geändert

Nach allem Testen in Protons Weboberfläche nachsehen:

- Unveränderte Filter, gleicher Name und Inhalt.
- Keine neuen, umbenannten oder gelöschten Ordner.
- Keine verschobene Mail.

Der Server hat keinen Proton-Client und weist alles ausser `GET` mit `405` ab, geprüft in
`packages/server/test/server.test.ts` und `write-isolation.test.ts`. Aber ein Test prüft, was ich
gebaut habe — dein Konto ist die einzige Instanz, die sagen kann, was tatsächlich passiert ist.

Status: `offen`

**Befund:**

**Fix:**

---

## Was noch nicht da ist

- **Schreiben.** Kein Weg führt vom Dashboard zu Proton. „Annehmen" und „Bestätigen" wirken lokal.
- **Änderungen / Verlauf / Protokoll** zeigen weiterhin Demo-Inhalte — sie hängen am Schreibpfad.
- **Empfänger (`ToList`)** wird nicht synchronisiert, steht in der Kopie also leer. Regeln, die auf
  den Empfänger filtern, treffen hier deshalb nichts — bei Proton schon. Lücke im Sync, nicht im
  Matcher.
- **Automatische Aktualisierung.** Der Server wird einmal beim Laden gefragt; nach einem Sync die
  Seite neu laden.
