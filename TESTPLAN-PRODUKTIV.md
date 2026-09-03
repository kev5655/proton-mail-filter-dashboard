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

**Befund:** Ja es stimmt aber etwas möchte ich noch erweiten, es gibt von proton aus neu aus vordefinierte ordner wie: "Soziale Medien", "Werbung", "Newsletter", "Transaktionen", "Akutallisierungen". Ich denke dafür müssen wir kein regel erstellen den dies wird automatisch erkannt und verschoben wen initial eine mail dort hineni verschoben wurde. Können wir das irgendwie visualisieren, denke mit ein neuen reiter link neben "Regenl", "Ordner" und so. 
- Noch was zum Stand ich sehe nur das: "131 Mails im Posteingang, 88 davon in 17 Gruppen. Der Rest sind Einzelfälle und bleibt bewusst ungruppiert — dafür lohnt sich keine Regel." Man könnte noch die Zeit hinzufügen wan der letzte sync gemacht wurde und evlt auch einen manuellen sync im ui. Denke das ist noch wichtig.

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

**Befund:** Sollte stimmen

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

**Befund:** Ja die bedinungen stimmen, die mails auch. Aber siehe auch was ich dir noch am schluss geschrieben haben, bitte überarbeite das noch.

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

**Befund:** Ja das ist nicht schlecht. Ich habe mal eine regel für github mails aber diese regel wurde nicht in Proton gespeicher ist das akutell noch der fall? Ich denke wir sollten auch die Vorschläge in sectionen gruppieren. Zumbespiel vorschläge per absender oder vorschläge per Betreff oder pro contnent, aber für betreff und inhalt braucht es evlt das llm das es besser kategorisieren kann. Was ich auch ncoh wichtig finde sollte ich in den Vorschlägen sehen wen ein email schon von einer regel matcht damit ich nicht zwei regeln erstelle die auf die gleich Mail verweisen. Falls das llm nicht aktiv oder erreichbahr ist. Sage das dem user uns lasse ihn es über ein setting menu einstellen, du musst es noch verlinken.

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

**Befund:** Ich möchte die sync befehel im dashboard ausfürhe könne am bessten noch mit ein laden balken und den wichtigesten informaiton was passiert und wie vile geladen wurde. Aber das hat funktioniert: `pnpm sync --days 365 --max 5000` während dem das dashboard online war!

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

**Befund:** Ja das sollte passen.

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

**Befund:** Ja es sind kein bilder drin.

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

**Befund:** Nein das hatt sich nicht, aber das sollte der nächste schritt sein oder?

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


- Was mir noch aufgefallen ist wen ich auf Protokoll klicke dan kommt ein leherer screen und ich komme über das ui nicht zurück kannst du das noch anpassen.
- Bitte das fenster nicht scrollable machen nach rechts und links: ![alt text](image.png)
- Ich möchte auch ein update bei den Regen. 1. Die regel soll es so anzeigen wie auch bei Proton mit den verschiedenen elemente wie "Name" "Bedinung" "Aktionen" und "Vorschaue", es ist von mir aus aber okay wen wir das ime haput screen machen und nicht als overlay und es darfa auch alles direcht sichtbahr sein mit "Name" "Bedinung" "Aktionen" und "Vorschaue". Weiter ist wichtig fúr mich das ich die Regel direkt editieren kann, entweder ist es schon direkt im editir modus oder ich muss es auswählen. Dan möchte ich wen ich änderungen an der regel gemacht habe das es automatisch anzeigt welche Mails jetzt gefilter werden und welche noch nicht. Alos in zwei spalten. In den zwei spalten möchte ich auf filter könne damit ich kurz selbst nach schauen kann ob die regel jetzt alle mail auswählt die ich möchte. Der filter soll nciht nur mit den title machten sonder auch mit den inhalt, email addresse. Und der newsletter filter ist von mir aus kein Scritp-Filter sondern ein maueller den ich im ui anpassen kann. Hier noch ein bild ![alt text](image-1.png) von newsletter filter. Den script filter kannst du als advance aufbahre option anzeigen, aber das ui wie es in proton gemacht ist ist intuitiver und möchte ich auch so brauche. 
- Noch eine updte fúr dei Regel. Ich sehe ganz unten welche emali es betrifft aber ich sollte hier keine neuen regeln ableiten könne sonder die regel überarbieten in dem ich emails entferne kan aus der regle und dan kann ich sagen entferne den absender, betreff, oder den inhalt, bettref und inhalt müssen wider mit llm gmatcht werden oder ein regex oder so erstellt werden. Aber das ist schon ein advance feature.
- Noch ein änderung für die Vorschláge wen ich mir die mails ansehen will zeigt es mir nur die nächsten 5 an aber ich sollte in der lage sein alle anzusehen und auzuwählen. Evlt in dem ich nach rechts und links blättern kann. Und zeige pro seite 10 Mails an. Auch hier wáhre noch ein filter hilfreich wie schon bei den Reglen
- Noch ein UI änderungen von mir aus können die liste immer in voller breite sein also das es nach rechts nicht abschneidet / begrezt ist.
- Kann mand die mails auch zu proton verlinke damit ich auf den link clicken kann und bei mir wird da mail im proton webseite geöfftne dan könnte ich noch die bilder oder so betrachten.