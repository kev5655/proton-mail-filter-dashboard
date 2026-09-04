# Testplan — das Dashboard am echten Postfach

**Hier steht nur, was ich nicht selbst testen kann.** Das ist im Kern eine Sorte Frage: *stimmt,
was das Werkzeug über dein Postfach behauptet* — und, neu und wichtiger: *tut es am Konto wirklich
nur das, was es ankündigt*.

Der alte `TESTPLAN.md` ist weg. T-04 und T-05 sind erledigt oder abgeräumt, **T-13 hat bestanden**
(dein Lauf zeigte `cookieMode:true`, `session refreshed` und danach „Gespeicherte Sitzung
wiederverwendet" — der blind gemachte Fix stimmt), T-12 bleibt zurückgestellt.

**Was ich seit dem letzten Mal selbst geprüft habe** und deshalb nicht hier steht: 583 Tests plus
26 E2E-Tests im echten Browser (`pnpm test:e2e`),
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
pnpm install
pnpm schreibtest # neu: prüft den Schreibweg allein, ohne Dashboard — siehe P-01
pnpm sync        # einmal nötig: die Kopie bekommt dadurch den Konto-Fingerabdruck
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

## P-01 · Der Schreibweg — jetzt zuerst ohne Dashboard

**Dein Befund war richtig und mein letzter Fix hat die Hälfte des Problems nicht berührt.**
Drei Fehler, alle drei gefunden.

**1 — Ordner anlegen schrieb nichts und meldete Erfolg.** Der schlimmste der drei. Im Schreibweg
entschied ein `switch` nach Änderungsart; er kannte nur Regeln. Ordner-Änderungen fielen durch —
und `create-folder` fiel durch die *Ausnahme* von der Fehlermeldung, also kam der Auftrag als
„erledigt" zurück, ohne dass je eine Anfrage gestellt wurde. Das Dashboard sagte „bei Proton
gespeichert", Proton wusste von nichts.

**2 — `delete-folder` gab es gar nicht.** Das war der `APPLY_PARTIAL`, den du gesehen hast. Die
Rückfrage im Terminal kam, dein `ja` kam an — und dahinter stand kein Code. Immerhin die ehrliche
Variante des Fehlers: er hat gesagt, dass er nichts kann.

**3 — Nach der ersten Änderung war jede weitere „veraltet".** Der Fingerabdruck, gegen den geprüft
wird, steht in der lokalen Kopie und wird beim Sync gesetzt. Ein Schreibvorgang ändert das Konto —
also stimmte er danach nicht mehr, und die *zweite* Änderung einer Sitzung wurde immer abgewiesen.
Das ist mit hoher Wahrscheinlichkeit das „ich kann immer noch keine Regeln anlegen": ein Versuch
vorher hatte den Abgleich schon verstellt. `pnpm serve` gleicht die Kopie jetzt sofort nach jedem
Schreibvorgang wieder ab — drei GETs, kein neuer Sync.

Angelegt, umbenannt und gelöscht wird jetzt wirklich, und **Umbenennen zieht die Regeln mit**:
Proton speichert das Ziel als *Namen*, ein umbenannter Ordner liesse sonst jede Regel ins Leere
sortieren, ohne Warnung.

### Zuerst: der Schreibtest ohne Dashboard

Genau das, worum du gebeten hast — ein Befehl, der einen Ordner anlegt, nachsieht, wieder löscht
und wieder nachsieht:

```sh
pnpm schreibtest
```

Er fragt einmal, bevor er anfängt. Dann:

1. legt er `PMS-Schreibtest <Datum>` an — leer,
2. **liest die Ordnerliste zurück** und prüft, ob Proton ihn wirklich hat,
3. löscht ihn wieder,
4. liest noch einmal zurück und prüft, ob er weg ist.

Schritt 2 und 4 sind der Punkt: eine `200` heisst, dass Proton die Anfrage angenommen hat, nicht
dass sich etwas geändert hat. Keine Mail wird angefasst; der Ordner ist leer, solange er existiert.
`pnpm schreibtest --behalten` lässt ihn stehen.

Er benutzt dieselben vier Funktionen wie das Dashboard, nicht eigene. **Wenn er durchläuft und das
Dashboard trotzdem nichts speichern kann, liegt der Fehler oberhalb des Schreibwegs** — und das ist
schon die halbe Diagnose.

### Und Logs, wie du sie wolltest

Jeder Lauf schreibt nach `data/logs/pms-<Datum>.log`. Ausführlicher als das Terminal (`debug` statt
`info`), eine Datei pro Tag, git-ignoriert. Geheimnisse werden beim Schreiben der Zeile nach
Feldnamen geschwärzt, nicht hinterher.

```sh
tail -n 200 data/logs/pms-$(date +%F).log
```

Wenn wieder etwas schiefgeht: die letzten Zeilen davon sind das Nützlichste, was du mir schicken
kannst. `PMS_LOG_FILE=` (leer) schaltet die Datei ab.

### Bitte in dieser Reihenfolge prüfen

```sh
pnpm install
pnpm schreibtest       # 1. der Schreibweg allein
pnpm sync              # 2. Kopie auffrischen
pnpm serve             # 3. Terminal 1
pnpm dev               # 4. Terminal 2 — neu starten, es gibt neue Pakete
```

1. `pnpm schreibtest` → vier Häkchen, Ordner am Ende weg.
2. Ordner anlegen im Dashboard → in Proton nachsehen. **Der Dialog muss sich von selbst schliessen.**
3. Danach *sofort* eine Regel anlegen, ohne neu zu synchronisieren → muss auch durchgehen. Das ist
   der Fehler Nr. 3 von oben.
4. Ordner löschen → fragt im Terminal. Einmal ablehnen (nichts darf passieren), einmal `ja`.
5. Ordner umbenennen, auf den eine Regel zeigt → danach in Proton prüfen, ob die Regel den *neuen*
   Namen nennt.

Status: `behoben, bitte nachprüfen`

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

## Deine weiteren Befunde vom letzten Durchgang

**Sync holt nur noch das Neue, und holt es von selbst.** „Jetzt synchronisieren" fragt jetzt nur
nach dem, was seit dem letzten Lauf dazugekommen ist — mit einer Stunde Überlappung, weil Proton
nach dem Zeitstempel der Mail sortiert und eine, die *während* des letzten Laufs ankam, sonst für
immer durchs Raster fiele. Ordner und Filter werden weiterhin jedes Mal vollständig gelesen; das
sind drei Anfragen, und alles andere wird gegen sie geprüft. Nachrichten werden ergänzt, nie
ersetzt, also wird die Kopie dadurch nie kleiner.

Damit lohnt sich auch der Timer: `pnpm serve` gleicht **alle 5 Minuten** nach. `pnpm serve
--auto-sync 0` schaltet das ab, `--auto-sync 15` streckt es.

Status: `neu, bitte prüfen` — die Zahl unter „Mails" sollte nach einem zweiten Sync gleich bleiben
oder wachsen, nie fallen.

---

**Neue Regeln aus Proton müssen jetzt bestätigt werden.** Du hattest recht: sie wurden stillschweigend
in „Regeln" aufgenommen, und „Änderungen" war deshalb dauerhaft leer.

Der Mechanismus lag halbfertig in der Datenbank — eine Spalte `adopted`, die niemand je gesetzt hat.
Jetzt gilt: **der erste Sync übernimmt alles** (eine frische Kopie hat nichts, womit sie vergleichen
könnte — dein gesamter Regelbestand als „unerwartet" zu melden wäre der schnellste Weg, dir
beizubringen, den Bildschirm wegzuklicken). Jede Regel, die **danach** bei Proton auftaucht, ohne
dass dieses Werkzeug sie geschrieben hat, landet unter „Änderungen" und zählt bis zu deiner
Entscheidung nicht zum verwalteten Bestand.

Drei Antworten, alle über den normalen Weg mit Diff:

- **Übernehmen** — schreibt nichts ans Konto, notiert nur, dass die Regel ab jetzt dazugehört. Der
  Diff kommt trotzdem zuerst: eine Regel zu übernehmen, ohne zu sehen, was sie fängt, ist keine
  Entscheidung.
- **Deaktivieren** — sie bleibt bei Proton stehen, läuft aber nicht mehr.
- **Löschen** — fragt zusätzlich im Terminal, wie jedes Löschen.

Prüfen: in Proton eine Regel anlegen → `pnpm sync` → sie muss unter „Änderungen" stehen, **nicht**
unter „Regeln".

Status: `neu, bitte prüfen`

---

**Knöpfe sehen jetzt wie Knöpfe aus.** `button-quiet` war durchsichtig und randlos — „Umbenennen"
und „Löschen" lasen sich als Text neben einem Ordnernamen, und man musste darüberfahren, um zu
merken, dass sie etwas tun. Sie haben jetzt eine eigene Fläche und einen echten Rand. Leise heisst
weniger Betonung als die Hauptaktion, nicht unsichtbar.

Status: `neu, bitte prüfen`

---

**Der Dialog schliesst sich, wenn die Änderung angekommen ist.** Er blieb auf einer Erfolgsmeldung
stehen, bis jemand „Schliessen" fand — das liest sich wie eine Arbeit, die nicht fertig ist. Was ihn
überlebt, steht jetzt oben auf dem Bildschirm: was gespeichert wurde, wo die Sicherung liegt, und ob
das Ergebnis nur teilweise war. Das bleibt, bis du es wegklickst.

Status: `neu, bitte prüfen`

---

**Einen neuen Ordner in der Regel anlegen — geht schon.** Das Feld „Verschieben nach" nimmt jeden
Namen an; ist er neu, legt der Schreibweg den Ordner an, **bevor** er den Filter schreibt. Diese
Reihenfolge ist Absicht: ein Filter, der in einen nicht existierenden Ordner sortiert, ist der
schlimmste Zustand auf der Liste. Der Editor sagt es vorher („Den Ordner gibt es noch nicht. Er wird
zusammen mit der Regel angelegt."), und im Diff steht es auch.

Wenn dir dabei etwas fehlt, sag mir was — ein Knopf „Ordner anlegen" daneben wäre derselbe Vorgang
mit einem Klick mehr.

Status: `bitte einmal prüfen, ob es sich so anfühlt`

---

## Nicht gebaut: die Kopie im Posteingang — eine Frage an dich

> *„eine regel die das mail in den ordner verschiebt aber das mail bleibt auch in meiner inbox"*

Das habe ich **nicht** gebaut, und ich sage lieber warum, als etwas zu raten und in den einen Pfad
zu schreiben, der dein Konto verändert.

Protons Filter kennen nur eine Aktion für „wohin": `fileinto "Name"`. Ob der Name ein **Ordner** oder
ein **Label** ist, entscheidet Proton beim Auflösen — und nach allem, was die Oberfläche nahelegt,
ist genau das der Unterschied, den du suchst: ein Ordner *verschiebt*, ein Label *markiert* und die
Mail bleibt im Posteingang. Ein Duplikat im eigentlichen Sinn gibt es nicht; es gibt eine Mail mit
zwei Etiketten.

Nur: das ist eine Vermutung über Protons Semantik, und ich habe keine Möglichkeit, sie ohne dein
Konto zu prüfen. Eine Minute deiner Zeit klärt es:

1. In **Protons eigener Oberfläche** einen Filter anlegen, der ein **Label** vergibt (nicht in einen
   Ordner verschiebt).
2. Dir eine Testmail schicken, die er fängt.
3. Nachsehen: liegt sie **im Posteingang und** unter dem Label? Oder ist sie aus dem Posteingang
   verschwunden?

**Befund:**

Sobald das feststeht, baue ich es als Schalter in der Regel — „verschieben" gegen „im Posteingang
lassen und markieren" — mit der richtigen Vorschau. Der Matcher müsste dafür mitlernen, dass ein
Label kein Ziel ist, sonst behauptet die Vorschau das Falsche.

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
- **Drift bei Ordnern.** Regeln werden jetzt erkannt; ein in Proton angelegter *Ordner* noch nicht.
- **Reihenfolge der Regeln ändern.** Bei Filtern ist die Reihenfolge das Ergebnis — das verdient
  einen eigenen Diff und kommt separat.

---

## Die Testsuiten

```sh
pnpm test        # 583 Tests, kein Netz, Sekunden
pnpm test:e2e    # 26 Tests im echten Browser, gut eine Minute
```

Beide sind jetzt in `README.md` beschrieben — inklusive einzelner Datei, einzelnem Test und
`PMS_E2E_HEADED=1`, wenn du zusehen willst.

Neu dazugekommen und gegengeprüft, indem ich den Fehler wieder eingebaut habe:

- **Ordner anlegen zählt die Anfragen.** Der Test scheitert, sobald `create-folder` wieder nichts
  schickt und Erfolg meldet — genau dein Befund.
- **Ordner löschen** fragt im Terminal, schreibt bei Ablehnung null Anfragen, und weist einen
  Ordner ab, den das Konto nicht hat, *bevor* jemand gefragt wird.
- **Umbenennen** schreibt den Ordner zuerst und die betroffenen Regeln danach.
- **Übernehmen** erzeugt null Anfragen an Proton und trägt trotzdem die Entscheidung ein.
- **Inkrementeller Sync** fragt nach dem richtigen Zeitpunkt, macht die Kopie nie kleiner, und
  behauptet nach einem Teillauf nicht, sie sei vollständig.
- **Adoption** überlebt den nächsten Sync, damit die Frage genau einmal gestellt wird.

---

## Kategorien: was nur du prüfen kannst

Zwei neue Bildschirme, und beide beruhen auf Annahmen, die sich hier nicht testen lassen. Der Reiter
**Auto-Regeln** zeigt, was Protons eigene Sortierung beobachtbar tut; **In Kategorie verschieben**
(in der Auswahlleiste, sobald Mails markiert sind) ist der einzige Weg im Dashboard, der Mail bewegt.

Er geht denselben Weg wie alles andere — Diff, dann Rückfrage im Terminal — und zwar **immer**, auch
bei einer einzigen Mail. Das ist Absicht: es ist die Ausnahme von der ersten Regel des Projekts.

### K-01 · Bewegt `PUT mail/v4/messages/label` die Mail wirklich?

Nimm eine Wegwerf-Mail. `pnpm serve`, im Dashboard auswählen, „In Kategorie verschieben",
„Transaktionen", im Terminal `ja`.

Danach in Proton nachsehen und drei Fragen getrennt beantworten:

1. Liegt die Mail in „Transaktionen"?
2. **Ist sie aus der alten Kategorie verschwunden**, oder trägt sie jetzt beide? Protons eigener
   Client schickt nur diese eine Anfrage und kein `unlabel` — daraus folgt, dass Kategorien sich
   serverseitig ausschliessen *dürften*. Nachgesehen hat das niemand. Wenn sie beide trägt, fehlt
   ein `unlabelMessages` davor, und das ist ein Befund, kein Schönheitsfehler.
3. **Ist der Posteingang unberührt?** Der Diff behauptet dazu nichts (`clearedFromInbox` bleibt 0),
   weil es unbekannt ist. Deine Antwort macht daraus eine Zahl.

### K-02 · Bewegt sich nur die eine Mail — oder der ganze Thread?

Der Grund, warum wir die Nachrichten- und nicht die Konversations-Variante nehmen. Nimm eine Mail
aus einem Thread mit mehreren Nachrichten und verschiebe **nur diese eine**. Danach: liegt der Rest
des Threads noch, wo er lag? Wenn nicht, ist Protons Nachrichten-Endpunkt in Wahrheit
konversationsbasiert, und das ändert, was dieses Feature überhaupt anbieten darf.

### K-03 · Stimmen die Kategorien auf dem Reiter mit Proton überein?

„Kategorien" zeigt, was jetzt worin liegt. Vergleich die Zahlen mit den Reitern über deinem
Posteingang in Proton. Eine als **„unbekannte ID"** markierte Kategorie ist der interessante Fall:
sag mir, wie sie in Protons Oberfläche heisst — die IDs stammen aus Protons eigenem Bundle, und eine
neue wäre die einzige Evidenz, die es dafür gibt.

### K-04 · Sagt der Verlauf etwas Wahres?

Eine Mail in Proton von Hand in eine andere Kategorie schieben, dann `pnpm sync`, dann „Auto-Regeln"
ansehen. Unter **„Was sich geändert hat"** muss genau diese Umsortierung stehen — mit der alten und
der neuen Kategorie.

Der Verlauf beginnt bei der Migration; vor dem ersten Sync mit den neuen Tabellen gibt es nichts.
Und ein inkrementeller Sync holt nur neue Mail: sortiert Proton eine **alte** Mail um, sehen wir das
nicht. „Unverändert" heisst dort **„nicht nachgesehen"**, und der Bildschirm sagt das auch.

### K-05 · Lernt Proton daraus? (Das ist die eigentliche Frage)

Die Prämisse des ganzen Features, und die einzige, die niemand abkürzen kann. Nach K-01: kommt in
den nächsten Tagen neue Mail **desselben Absenders** von selbst in „Transaktionen"?

Das braucht mehrere Tage und mehrere Synchronisationen. Bis dahin ist es eine Erwartung, keine
Tatsache — der Dialog sagt das, statt es zu behaupten.

### K-06 · Rückgängig

Nach einem Verschieben im Verlauf zurücknehmen. Jede Mail muss dorthin zurück, wo **sie** war — die
eine in ihre alte Kategorie, die andere in den Posteingang, wenn sie nur dort war. Nicht alle an
denselben Ort: das Protokoll hält pro Mail fest, was vorher galt, und genau das ist der Unterschied.

### Was hier schon geprüft ist

Gegengeprüft, indem der Fehler wieder eingebaut wurde:

- **Abgelehnt oder abgelaufen ⇒ null Anfragen.** Gezählt, nicht behauptet.
- **Die Terminal-Rückfrage ist bei dieser Änderungsart bedingungslos** — auch bei einer Mail. Nimmt
  man die Regel heraus, scheitert der Test.
- **Nur die genannten Kennungen.** Eine Änderung, die eine Mail nennt, die nicht im Diff stand, wird
  abgewiesen, bevor irgendwer gefragt wird.
- **Nur Kategorien.** Eine Ordner-ID oder die nicht existierende `23` werden abgewiesen, ohne dass
  eine Anfrage rausgeht.
- **Genau zwei Importeure** dürfen das Verschiebe-Modul erreichen, als exakte Menge geprüft, und
  beide Funktionen darin nehmen `messageIds: string[]`.
- **Der Scrubber** lässt `"26"` unter `LabelID` stehen und ersetzt Nachrichten-Kennungen — vorher
  war es genau umgekehrt herum falsch, weshalb keine aufgezeichnete Fixture je sagen konnte, welche
  IDs Protons Kategorien haben.

### Bekanntes Rauschen, nicht neu

`pnpm test` meldet am Ende ein paar „ReferenceError: window is not defined". Das ist ein Abbau-Rennen
zwischen happy-dom und React, es tritt auch ohne diese Änderungen auf (dort sogar häufiger), die
Anzahl schwankt von Lauf zu Lauf, und kein Test scheitert daran. Ich habe es nicht angefasst — es
gehört in einen eigenen Durchgang, nicht in diesen.
