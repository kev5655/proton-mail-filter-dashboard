# Testplan M0/M1 — offene Punkte

Stand: die meisten Tests sind durch und wurden aus dieser Datei entfernt. Was hier steht, ist noch
offen oder wurde repariert und braucht einen zweiten Durchgang.

Abgeschlossen und gelöscht: Vorbereitung (Dateirechte), `T-01` (gespeicherte Sitzung), `T-02`
(Fixtures ohne echte Daten), `T-03` (Drosselung), `T-06` (1Password gibt nichts preis), `T-10`
(Datenbank verschlüsselt), `T-11` (zweiter Sync verdoppelt nicht).

Das produktive Testen der Oberfläche steht in **`TESTPLAN-PRODUKTIV.md`**.

**So benutzen wir diese Datei.** Du trägst unter `Befund:` ein, was passiert ist — Ausgabe
hineinkopieren reicht. Ich antworte unter `Fix:` und setze den Status.

Status pro Test: `offen` · `ok` · `Fehler` · `behoben` · `zu prüfen`

---

## T-04 · `PMS_BROWSER_HEADLESS` aus der `.env`

Du hattest notiert: *„das HEADLESS im .env hat nicht gewirkt"*. Nachvollziehen liess sich das nicht —
der Code liest die Variable korrekt (`apps/spike/src/session.ts`), und deine `.env` enthält
`PMS_BROWSER_HEADLESS=false` ohne Tippfehler und ohne Windows-Zeilenenden.

Wahrscheinlichste Erklärung: zum Zeitpunkt des Laufs waren die drei Zeilen noch auskommentiert, weil
`T-05` genau das verlangt. Das lässt sich aber nicht beweisen, und darum ging die Ausgabe nicht.

**Fix:** Der Spike sagt jetzt, welche Einstellung *tatsächlich* gilt und woran sie hängt:

```
Anmeldung über den installierten chrome (PMS_BROWSER_CHANNEL), mit sichtbarem Fenster (PMS_BROWSER_HEADLESS=false).
  Profil bleibt in /home/.../data/browser-profile (PMS_BROWSER_PROFILE).
```

Und falls gar keine `.env` gefunden wurde, steht das als erste Zeile da — vorher war „nicht gelesen"
von „gelesen und ignoriert" nicht zu unterscheiden.

**Erneut prüfen:** einmal `pnpm spike` starten und die drei Zeilen mit deiner `.env` vergleichen.
Stimmen sie überein, ist der Punkt erledigt.

Status: `zu prüfen`

**Befund:**

---

## T-05 · Anmeldung unsichtbar, mit TOTP

Dein Befund war „Funktioniert nicht", und der Abbruch war:

```
[BROWSER_LOGIN_2FA_UNSUPPORTED] Protons 2FA-Seite zeigt den Passkey, und das Code-Feld liess sich nicht öffnen.
Kontext: {"tried":[...]}
```

**Fix:** Zwei Sachen, und die zweite ist die wichtigere.

**1 — Der Umschalter wurde zu eng gesucht.** `revealTotpField` hat nur nach `<button>` mit passendem
Text gesucht. Proton rendert solche Bedienelemente auch als Link oder als `div` mit Klick-Handler —
beides hat die Suche nicht gefunden. Jetzt werden Button, Link und reiner Text durchprobiert.

**2 — Der Fehler hat nichts verraten.** Im Kontext stand nur, wonach *wir* gesucht haben. Was die
Seite anbietet, wurde nur im sichtbaren Fall ausgegeben. Der Versuch hat dich also etwas gekostet und
uns nichts gebracht. Jetzt hängen `inputs` und `buttons` auch am unsichtbaren Fehler — Attribute und
Beschriftungen, keine Werte. Damit lässt sich `selectors.ts` anpassen, ohne noch einen Versuch zu
verbrauchen.

**Erneut prüfen:** die drei `PMS_BROWSER_*`-Zeilen auskommentieren, Sitzung beiseitelegen, `pnpm
spike`. Beide Ausgänge sind gültig — ich will nur wissen, welcher:

- Es klappt mit TOTP aus 1Password.
- Es bricht wieder ab. **Dann bitte den ganzen Kontext hierher kopieren**, besonders `inputs` und
  `buttons`. Das ist die Information, mit der ich es ohne weiteren Versuch reparieren kann.

Status: `zu prüfen`

**Befund:**

---

## T-13 · Die Sitzung lässt sich erneuern (neu)

Der Grund, warum du dich überhaupt neu anmelden musstest. Im letzten Lauf stand:

```
(Erneuern fehlgeschlagen: PROTON_SCHEMA_MISMATCH)
Die gespeicherte Sitzung ist abgelaufen und liess sich nicht erneuern.
```

**Fix, blind gemacht — deshalb dieser Test.** Zwei Fehler, beide im Cookie-Modus, in dem eine über
den Browser erzeugte Sitzung läuft:

1. `refreshResponseSchema` verlangte `AccessToken` und `RefreshToken` als Pflichtfelder. Im
   Cookie-Modus antwortet Proton mit `{"Code":1000}` und legt die neue Sitzung in `Set-Cookie` —
   also genau der Fehler, der in `@pms/browser-auth` schon einmal dokumentiert wurde, einen Endpunkt
   weiter.
2. `ProtonHttp` hat `Set-Cookie` nirgends gelesen. Selbst mit passendem Schema hätte die erneuerte
   Sitzung die alten Cookies behalten, während Proton rotiert hat.

Beides ist repariert, aber **gegen die echte API ungeprüft** — ich habe keinen Zugang und will keinen.

**Erwartet:** Beim nächsten Lauf mit abgelaufener Sitzung erscheint kein Browser, sondern:

```
✓ Gespeicherte Sitzung wiederverwendet — keine Anmeldung nötig.
```

**Wenn es wieder scheitert**, steht jetzt die ganze Meldung da statt nur des Codes — inklusive des
JSON-Pfads, an dem das Schema nicht passt. Bitte die drei Zeilen hierher kopieren; damit ist es ohne
weiteren Anmeldeversuch zu reparieren.

Status: `zu prüfen`

**Befund:**

---

## T-12 · Falsche Passphrase, abgebrochener Sync — erledigt bzw. abgeräumt

Du hattest geschrieben: *„Ist mir nicht so wichtig"*. Die Hälfte davon musst du auch nicht testen:

- **Falsche Passphrase** ist durch `packages/store/test/encryption.test.ts` abgedeckt —
  `VAULT_KEY_REJECTED` samt Hinweis, dass die Datei nur eine Kopie ist. Gilt jetzt auch für
  `pnpm serve`, das dieselbe Passphrase verlangt.
- **Abbruch mitten im Lauf** ist weiterhin ungetestet. Ich lasse es offen liegen statt es dir
  aufzuschreiben; wenn es dir mal passiert, ist der Befund interessanter als ein gestellter Versuch.

Status: `abgeräumt`

---

## Offene Punkte ausserhalb der Tests

- **Git-History.** `fixtures/recorded/filters.json` mit echten Werten liegt in Commit `0057c6c` auf
  dem öffentlichen Remote. Lokal ist die History bereinigt; der Remote braucht einen Force-Push, den
  du selbst ausführen musst.
- **`fixtures/` steht in deiner `.gitignore`.** Damit wird auch die pseudonymisierte
  `fixtures/recorded/filters.json` nicht mehr committet — und `real-filter.test.ts` überspringt sich
  bei jedem anderen Klon still. Absicht? Wenn ja, lassen wir es so; wenn nicht, gehört der Eintrag
  auf `fixtures/raw/` eingeschränkt.
- **`real-filter.test.ts` lief bis heute nie.** Er las `data.Filters`, der Rekorder schreibt `data`
  direkt als Array — aufgefallen ist es nie, weil ohne Fixture übersprungen wurde. Repariert; die
  fünf Tests laufen jetzt mit und bestätigen `T-02` am echten Material.
- **Passkey.** Funktioniert im eigenen Browser-Profil nicht, weil dort 1Password fehlt. TOTP ist der
  bequemere Weg, weil der Code automatisch eingetragen wird.
- **Eine Passphrase für alles Lokale.** Sitzungstokens und Postfachkopie teilen sie sich; beides ist
  ersetzbarer lokaler Zustand. Vom Proton-Passwort ist sie getrennt, weil das etwas anderes schützt.

---

## Was du hier sonst noch hinschreiben kannst

Alles, was dir beim Benutzen auffällt und keinem Test zuzuordnen ist — Formulierungen, die
irreführen, Ausgaben, die zu viel oder zu wenig sagen, Abläufe, die sich falsch anfühlen.

**Sonstiges:**
