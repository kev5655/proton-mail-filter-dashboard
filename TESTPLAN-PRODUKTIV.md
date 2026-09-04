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
pnpm write-test # neu: prüft den Schreibweg allein, ohne Dashboard — siehe P-01
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
pnpm write-test
```

Er fragt einmal, bevor er anfängt. Dann:

1. legt er `PMS-Schreibtest <Datum>` an — leer,
2. **liest die Ordnerliste zurück** und prüft, ob Proton ihn wirklich hat,
3. löscht ihn wieder,
4. liest noch einmal zurück und prüft, ob er weg ist.

Schritt 2 und 4 sind der Punkt: eine `200` heisst, dass Proton die Anfrage angenommen hat, nicht
dass sich etwas geändert hat. Keine Mail wird angefasst; der Ordner ist leer, solange er existiert.
`pnpm write-test --keep` lässt ihn stehen.

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
pnpm write-test       # 1. der Schreibweg allein
pnpm sync              # 2. Kopie auffrischen
pnpm serve             # 3. Terminal 1
pnpm dev               # 4. Terminal 2 — neu starten, es gibt neue Pakete
```

1. `pnpm write-test` → vier Häkchen, Ordner am Ende weg.
2. Ordner anlegen im Dashboard → in Proton nachsehen. **Der Dialog muss sich von selbst schliessen.**
3. Danach *sofort* eine Regel anlegen, ohne neu zu synchronisieren → muss auch durchgehen. Das ist
   der Fehler Nr. 3 von oben.
4. Ordner löschen → fragt im Terminal. Einmal ablehnen (nichts darf passieren), einmal `ja`.
5. Ordner umbenennen, auf den eine Regel zeigt → danach in Proton prüfen, ob die Regel den *neuen*
   Namen nennt.

Status: `behoben, bitte nachprüfen`

**Befund:** 
1. Funktioniert
2. Der ordner wir nach den anlegen nicht direkt in ui von mein tool angezeit. Kein Sync machen nur auch odner lokal hinzufügen. Ausser wir müssen ein id oder so wissen das brauchen wir die daten von Proton und wir müssen ein sync machen. Und ja es wird geschlossen der dialog.
3. Hat funktioneirt
4. Hat funktioneirt
5. Hat funktioniert



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

**Befund:** Ich denke der Veraluf funktioniet nicht richtig und ich habe dir noch weiter features in auftrag gebene sieh ganz unten. Desshabl habe ich das noch nicht getestet.

**Fix:**

---

## P-03 · Wo landet ein neuer Filter?

Eine Frage, die ich nicht beantworten kann und von der jeder Diff abhängt.

Nach P-02: Steht der neue Filter in Protons Liste **oben oder unten**? Bei Filtern ist die
Reihenfolge das Ergebnis — der letzte, der einsortiert, gewinnt. Wenn Proton neue Filter vorne
einfügt, überschreibt jede neue Regel alle bestehenden, und meine Diff-Rechnung sagt das Gegenteil.

Status: `offen`

**Befund:** Der filter wurde unter dem bestehenden filter hinzugefügt.

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

**Befund:** Ja das passt.

**Fix:**

---

# Das Dashboard

## P-05 · Stimmt, was da steht?

Abgleich mit Protons Oberfläche: dieselben Ordner in derselben Verschachtelung, dieselbe Anzahl
Regeln, plausible Mailzahlen, und der Stand im Banner passt zum letzten Sync.

**Nachrechnen:** Regeln im Dashboard **+** die im Banner genannten nicht-lesbaren Filter **=** Filter
in Protons Liste. Geht die Summe nicht auf, fehlt etwas stillschweigend.

Status: `offen`

**Befund:** Ja das habe ich kein aufälligkeiten geshen.

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
- Wen ich die seite weiter bläter und am ende ankomme spring der weiter und zurück element nach oben bitte fixiere es unten.
- Wen ich auf nur verwante zeigen oder alle übrigen zeige klicke spring das ui auch.
- Wen ich die regel in proton inaktiv mache wird sie in unseren ui immer noch als aktiv angezeit.
- Es zeig mir bie jeder regel folgendes an:
Diese Regel ist als Sieve-Skript geschrieben. Protons eigene Oberfläche kann sie deshalb nicht mehr bearbeiten, und dieser Editor standardmässig auch nicht. Sie liesse sich aber vollständig als klickbarer Filter ausdrücken. Beim Umwandeln siehst du vorher, was sich dadurch an den getroffenen Mails ändert.
wen ich das jedoch bestätige / umwandel zeigte es es mir trozdem noch an.

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

**Befund:** Da machen wir aktive gerade was dran teste ich noch nicht.

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

**Befund:** Ist okay passt alles

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

**Befund:** Bitte die Vorschläge einklapbar machen wie  Nach Absender oder die anderen. Es sind relative viele vorschläge. Bitte auch noch ein such filter damit ich die vorschläge besser filter kann. 

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

**Befund:** Ja das funktioniert aber ich möchte auch die wahl haben das die email per bridge geladen wird fals das möglich ist. Also zwei buttons einer der verlinkt auf das mail und der ander der das mail lädt in ein ui in unsre tool.

**Fix:**

---

## S-02 · Am Konto nur das, was angekündigt war

Nach allem Testen in Protons Oberfläche durchsehen:

- Nur die Filter, die du bestätigt hast — kein zusätzlicher.
- Nur die Ordner, die du bestätigt hast.
- Keine Mail an einer Stelle, die du nicht erwartest.

Status: `offen`

**Befund:** Das sollte okay sein.

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

**Befund:** Ist alles okey, noch ein weter feature zum label sie ganz unten.

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

Weiter änderungen: 
- bitte alle commands in english und nicht in detusch: pnpm write-test
- Wen ich ordner umbennenen will bitte kein alert promt. Direkt über das ui das wir gebaut haben.
- Das Protokoll ist mir unklare bitte besser meldungen wie Ordner von xy auf xzy umbennant oder Ordner gelöscht. Ich denka auch Protokoll und Verlauf könne kombiniert werden den akteull funktioniert Verlauf nicht! Ich möchte eigentlich bein Protokoll / Verlauf auf ein ststand zurück gehen könne also alle angewnaten commands rückgängig machen wie ein Umbennen eins ordners, oder noch vile wichtiger wen wir eine neue Regel machen und es dan automatisch alle mails verschiben auch die vergangen das wir das rückgängig machen könne den im Proton ui ist das schon realtiv schwirikg
- Wen es möglich ist füge noch ein passendes log zur webstie hinzu generier ein Proton like logo.
- Wen ich bei den einstellungen Ollama aktiviern möchte warum ist es augeschaltet? Auschallten sollte ich über die einstllungen machen könne und nicht über eine variable oder env. Und wen es noch witer wichtige einstllunge gibt die hard codiert sind bitte auch in die einstellung hizufügen.
- In vilelen fällen wen ich was anlegen will zeig es mir an das ich mit ja noch bestätigen muss das stimmt aber meisten nicht. Zeige da nur an wen ich auch wirklich ja sagen muss im terminal.
- bin mir nicht sicher aber in Proton kann man bei den regeln auf "Filter auf vorhandene E-Mails anwenden" klicken so müssten wir nicht selbst die vergangen emails verschiben verwende dies feature um vergangen emails zu verschiben, evlt müssen wir das in regel ui anpassen.
- Wen ich eine neue regel in Proton erstelle kommt sie zu änderunge hinzu das ist supper aber sie ist auch schon in den Regeln aktiv alos bearbiet bahr ich denke wir sollten sie dort noch deaktiviern also das wir wirlick zu erste sie bestätigen gehen müssen im änderungs section und dan könnten wir sie auch bearbeiten wen das nötig ist. Bitte gib dir das label nicht bestätig oder so.
- Wen ich ein änderung an Proton sende bitte loading kreis andzeigen im button, damit ich sehe das was passiert.
- Wen ich mauell einsync gemcht habe resete die 5min zurück. Ich denke die 5min sollte man auch einstellen sollen über die einstellungen.
- Es soll auch möglich sein wen wir regelnd definiere das wir labels dazufügen könne. Entweder manuell das ich sie auswählen kann oder mit ein llm button der labels für die regel vorschlägt. Ich denke wir sollte auch die Regen aufteilen in Regen die gebauen wurde für emails in odener zu verschiben und regeln die dafür das sind labels auf mails zu packen. Ich denke wir machen mal ein erste einfach version und dan scahuen wir weiter. Was mein Problme ist ist. Es fählt mir schwer labels zu bestimmen für mails desshabl llm hilfe mit lokalem model. Bitte zeige auch and das es das feature gibt und mit tool tip wo man es aktivieren kann mit link dazu. Das kannst du bei allen sachen machen die irgende welche llm umterstützung haben sollten.
- Noch ein änderungen zu den vorschlägen: Ich denke ich habe das schon erwäht mit den filter das ich so emails schneller suchen kann. Fals nicht hier: Ich möchte ein globaler filter. Der alle unterkategorien filtert wie: "Nach Absender", "Nach Betreff" oder "Nach Organisation" dan aber auch noch spezifischer filte die direkt die kategorien filter also kann ich global nach post filte und dan auf der kategorie noch mals nach finace oder so und beide werden angewant.

---

# Zweiter Durchgang: deine Befunde, abgearbeitet

Alles aus deiner Liste ist gebaut, ausser dem Login über die Website — der kommt als eigener Schritt
danach. Was du prüfen musst, steht hier; was ich selbst geprüft habe, steht darunter.

**Achtung, zwei Namen haben sich geändert:** `pnpm schreibtest` heisst jetzt `pnpm write-test`,
`--behalten` heisst `--keep`, `--sperre-geklaert` heisst `--lockout-cleared`. Alte Namen gibt es
nicht mehr — zwei Namen für dasselbe ist die Sorte Freundlichkeit, die später jemanden verwirrt.

## V-01 · Der Verlauf, der vorher keiner war

Er war nicht kaputt, er war nie angeschlossen: der Schreibweg hat jedes Mal einen korrekten Eintrag
gebaut, und der Prozess, der ihn aufrief, hat ihn weggeworfen. Es gab keine Tabelle dafür, und
`undoChange` hatte im ganzen Projekt keinen einzigen Aufrufer.

1. Eine Regel anlegen und bestätigen. **Unter „Verlauf" muss sie jetzt stehen** — mit Datum,
   Mailzahl und dem Pfad der Sicherung.
2. `pnpm serve` beenden und neu starten, Dashboard neu laden. **Der Eintrag muss noch da sein.**
   (Er liegt in der verschlüsselten lokalen Datenbank, nicht im Browser-Tab.)
3. „Protokoll" ist kein eigener Reiter mehr — es ist die untere Hälfte von „Verlauf". Oben, was am
   Konto geändert wurde; unten, was das Werkzeug in diesem Tab getan hat. Das ist die einzige Spur,
   wenn eine Änderung den Server gar nicht erst erreicht.

**Wichtig:** Änderungen von *vor* dieser Version wurden nicht aufgezeichnet und lassen sich deshalb
auch nicht zurücknehmen. Die Sicherungen unter `data/backups/` liegen alle noch.

## V-02 · Rückgängig — der eigentliche Test

Der gefährlichste Test in dieser Datei. Bitte auf einem Wegwerf-Ordner.

1. Regel anlegen, die Mail verschiebt, bestätigen.
2. **Vorher von Hand** eine fremde Mail in den Zielordner legen.
3. Im Verlauf „Rückgängig". Diff ansehen: es müssen **genau die Mails** drinstehen, die die Regel
   bewegt hat — jede mit ihrem eigenen Vorher-Ort, nicht alle mit demselben.
4. Im Terminal `ja`.
5. In Proton nachsehen: Filter weg, die bewegten Mails zurück — **und die von Hand eingelegte liegt
   noch dort.** Wenn nicht, sofort aufhören und mir Bescheid geben.

Der Diff kommt aus dem Protokoll, nicht aus einer Simulation. Das ist der ganze Unterschied zwischen
„diese zwanzig Mails zurücklegen" und „diesen Ordner leeren".

## V-03 · Bis hierhin zurück

Drei Änderungen hintereinander machen, dann bei der ältesten „Bis hierhin zurück (3)".

- Ein Diff, eine Rückfrage — nicht drei.
- Danach im Verlauf: **drei einzelne Undo-Einträge**, nicht einer. Das ist Absicht: ein Rücklauf,
  der auf halbem Weg stehenbleibt, muss trotzdem ablesbar sein.
- Bricht ein Schritt ab, hört es dort auf und sagt wo. **Es wird nichts wieder vorgespult** — das
  wäre eine zweite unbeaufsichtigte Schreibserie im Fehlerpfad.

Ein Undo lässt sich nicht rückgängig machen. Ein Redo ist eine andere Handlung, braucht einen
eigenen Diff, und zwei Einträge, die sich über den Kontostand uneinig sind, will niemand.

## V-04 · Bestand einsortieren — macht Proton, nicht wir

`applyFiltersToExisting` gab es seit Monaten, exportiert und von niemandem aufgerufen — während das
Terminal „Bestehende Mail wird mit einbezogen" versprach. Danach wartete die Nachkontrolle dreimal
auf Bewegungen, die nicht kommen konnten, und meldete ein Teilergebnis.

Im Diff steht jetzt ein Häkchen **„Auch die N vorhandenen Mails einsortieren lassen"**.

- Mit Haken: liegen die alten Mails danach im Ordner?
- Ohne Haken: bleiben sie liegen, und die Regel gilt nur für Neues?
- Kommt der `VERIFY_PARTIAL_MOVE` von früher noch?

## V-05 · Labels statt Ordner

Im Regeleditor gibt es jetzt zwei Knöpfe: **„In einen Ordner verschieben"** und **„Mit einem Label
markieren"**.

1. Eine Regel mit Label-Ziel bauen. Die Vorschau darf **nicht** behaupten, die Mail verlasse den
   Posteingang.
2. Speichern, in Proton nachsehen: ist es ein Label geworden und kein Ordner?
3. Eine Testmail schicken, die die Regel fängt. **Liegt sie im Posteingang und trägt das Label?**
4. Ein Label und einen Ordner mit demselben Namen anlegen (Proton erlaubt das) und eine Regel auf
   den Namen bauen. Der Editor warnt. Was macht Proton?

**Nebenbefund, den du sehen wirst:** echte Labels wurden bisher als „unbekannte Kategorie" gemeldet,
weil eine Label-ID genauso aussieht wie eine Kategorie-ID und wir die Label-Liste weggeworfen haben.
Unter „Kategorien" sollten deine Labels jetzt verschwunden sein.

## V-06 · Ollama

Der Schalter war nie per env abgeschaltet — es gibt im Browser überhaupt keine env-Variable. Es war
die Voreinstellung, plus vermutlich Ollamas Origin-Prüfung: eine Seite auf `localhost:5173` darf
`127.0.0.1:11434` von Haus aus nicht fragen, und der Browser meldet das als denselben Netzwerkfehler
wie einen toten Port. Das Dashboard sagte dir also „nicht erreichbar" über ein laufendes Modell.

Die Adresse steht jetzt auf `/ollama` und geht über den Dev-Server. In den Einstellungen:
Ollama wählen → **Speichern** (es steht jetzt auch dran, dass noch nichts gespeichert ist) →
„Verbindung prüfen".

Danach: im Regeleditor mit Label-Ziel „Label vorschlagen lassen". Es darf **nur aus deinen
vorhandenen Labels wählen**. Ein neues erfindet es nur, wenn du das Häkchen setzt, höchstens eines,
und es steht getrennt mit „gibt es noch nicht".

## V-07 · Die kleinen Sachen

- **Ordner anlegen** → erscheint er sofort in der Liste, ohne Sync?
- **Umbenennen** → kein Browser-Prompt mehr, sondern ein Dialog, der sagt, wie viele Regeln mitgezogen
  werden.
- **Blättern** → springt der „Weiter"-Knopf auf der letzten Seite noch?
- **Umschalter „nur verwandte / alle übrigen"** → springt das UI noch?
- **Eine Regel in Proton deaktivieren**, syncen → steht hier „deaktiviert" statt „aktiv"?
- **Sieve-Regel umwandeln** → verschwindet der Hinweis, und steht danach, dass es erst nach
  *Vormerken* bei Proton ankommt?
- **Eine Regel in Proton anlegen**, syncen → sie steht in „Regeln" als **„nicht bestätigt"**, ist
  nicht bearbeitbar, und ein Klick führt nach „Änderungen".
- **Änderung senden** → dreht sich ein Ladekreis im Knopf?
- **Kleine Änderung** → steht jetzt **nicht** mehr „die Rückfrage kommt im Terminal", wenn keine kommt?
- **Vorschläge** → einklappbar, und der Filter oben filtert alle drei Abschnitte gleichzeitig?
- **Auto-Sync** → Intervall in den Einstellungen setzen, dann einmal von Hand syncen. Ab da gilt es.
  Es steht auch dran, dass es nur bis zum nächsten `pnpm serve` hält.
- **Logo** → eigenes, keins von Proton. Wenn es dir nicht gefällt, sag es, das ist billig zu ändern.

## Was ich diesmal selbst geprüft habe

765 Tests plus 26 im echten Browser, alles grün, nichts übersprungen. Jede neue Zusicherung
gegengeprüft, indem ich den Fehler wieder eingebaut habe — darunter:

- Ohne die bedingungslose Terminal-Rückfrage für Undo und Zurückspulen scheitern drei Tests.
- Ohne die Kategorie-Zeile in `previousFolderOf` landet eine Mail im Posteingang statt in ihrer
  alten Kategorie.
- Wird die Label-Liste wieder weggelassen, meldet der Test das Label als unbekannte Kategorie.
- Sucht `ensureFolder` wieder in der falschen Liste, entsteht ein zweites Label neben dem
  vorhandenen — und ein gleichnamiger Ordner wird für das Label gehalten.
- Ohne die Füllzeilen springt der Pager auf der letzten Seite.
- Ohne die Seiten-Rückstellung bleibt die Seitenzahl beim Umschalten stehen. Der erste Test dafür
  war wertlos — er mountete neu und fing dadurch ohnehin bei Seite eins an; er tauscht jetzt die
  Mails unter einer stehenden Liste.

---

## V-08 · Anmelden über die Website

Das letzte Stück deiner Liste. **Ein Punkt davon geht nicht, und ich sage es lieber, bevor du dich
darauf verlässt:** „den Browser verwenden, in dem meine App schon läuft" ist nicht machbar. Die
Sitzung besteht aus Cookies und Tokens auf `proton.me`; eine Seite auf `localhost` darf sie nicht
lesen (Same-Origin), und Proton lässt sich auch nicht in ein `iframe` einbetten. Der einzige Weg
dorthin wäre eine eigene Browser-Erweiterung — ein zweites Produkt, kein Häkchen.

Was gebaut ist: in der Seitenleiste steht **„Bei Proton anmelden"**. Das öffnet ein echtes
Browser-Fenster auf Protons eigener Anmeldeseite und wartet. **Durch dieses Werkzeug läuft dabei
kein Passwort** — weder durch das Dashboard, noch durch den lokalen Server, noch durch den Prozess
dahinter. Genau deshalb kann die 1Password-Erweiterung überhaupt mitmachen: sie füllt Protons
Formular aus wie auf jeder anderen Seite.

### Vorbereitung

Die Erweiterung steckt in **deinem** Chrome-Profil, nicht in einem frisch angelegten. Also:

```sh
PMS_BROWSER_CHANNEL=chrome
PMS_BROWSER_PROFILE=~/.config/pms-chrome
```

Beides liest `pnpm serve` beim Start, also in die `.env` und danach neu starten. Die
Einstellungsseite zeigt die Werte an, statt ein Feld anzubieten, das nichts bewirken würde.

Beim ersten Mal ist das Profil leer — melde dich dort einmal bei 1Password an und installiere die
Erweiterung. Danach kennt Proton auch das Gerät wieder, was die Anmeldungen ruhiger macht.

### Zu prüfen

1. `pnpm serve`, `pnpm dev`, „Bei Proton anmelden". **Geht ein Fenster auf?**
2. **Ist die 1Password-Erweiterung darin?** Wenn nicht, stimmt das Profil nicht.
3. Füllt sie Protons Formular aus? Funktioniert dein Passkey?
4. Nach dem Abschluss: schliesst sich das Fenster, und sagt das Dashboard „Angemeldet"?
5. `pnpm serve` neu starten: wird die Sitzung wiederverwendet, ohne dass ein Fenster aufgeht?

### Was ich absichtlich nicht aufgeweicht habe

- **`LoginGuard` gilt weiter.** Er wird gefragt, *bevor* ein Fenster aufgeht, ein Fehlschlag wird
  gezählt, und es gibt **keine Wiederholung**. Ein Knopf in einer Weboberfläche macht es leicht, den
  Login zu hämmern — genau so kam dieses Konto zu seiner Sperre. Eine Abweisung steht als Abweisung
  da, ohne Knopf daneben.
- **Die Freigabe nach einer Sperre bleibt im Terminal:** `pnpm spike --lockout-cleared`, und erst
  nachdem du dich bei mail.proton.me angemeldet und gesehen hast, dass das Konto erreichbar ist. Ein
  Ein-Klick-Knopf dafür wäre der ursprüngliche Fehler in bequem.
- **Der Browser zeigt weiterhin nur auf die Login-Seite**, und der Test dafür ist jetzt wichtiger
  als vorher: das Fenster wird neu von einer HTTP-Anfrage gestartet statt von jemandem am Terminal,
  und es läuft in einem echten Profil, das schon bei anderen Diensten angemeldet ist.
- **Unsichtbar geht für die erste Anmeldung nicht** — es gibt niemanden, der tippt, und ein Passkey
  hat nichts zum Bestätigen. Das Auffrischen einer bestehenden Sitzung braucht sowieso keinen
  Browser.

### Der Preis, den du kennen sollst

Mit einem dauerhaften Profil liegen die Proton-Cookies danach auch in Chromes eigenem Speicher,
nicht nur in unserer verschlüsselten Datei. Das war schon immer so und stand bisher nur in
`.env.example`; es steht jetzt auch auf der Einstellungsseite. Wenn dir das zu viel ist: ohne Profil
funktioniert die Anmeldung weiterhin, nur ohne Erweiterung und ohne Passkey.
