# proton-mail-sorter

A local dashboard for Proton Mail's filters and folders.

Proton can sort incoming mail into folders automatically, but building and maintaining those filters
is tedious: every rule is assembled by hand, nothing shows you which rule affects which messages,
and nothing suggests the rules you would actually benefit from.

This tool reads your mailbox, groups the messages, and proposes rules — new ones, or extensions to
rules you already have. You confirm; it writes the filter to Proton. **Proton still does the
sorting.** The tool never moves your mail.

> **Status: early.** M0 is complete — repository scaffolding, the vendored Proton rule compiler, a
> read-only API client, and a login that works against a real account. Nothing writes to your
> account yet, and the dashboard still runs on synthetic data.

## What it will do

- Show every Proton filter in execution order, and for each one, **the messages it actually catches**
- Flag rules that can never fire because an earlier rule already caught everything
- Group inbox mail by sender, domain, mailing list and subject pattern, and suggest a destination
- Create folders, including nested ones, and keep the tree in sync with Proton
- Pick up rules and folders you created by hand in Proton's web UI and ask whether to adopt them
- Verify after every change that Proton really moved what it promised, and say so when it did not
- Undo any change, including moving the affected messages back

## Requirements

Same on Windows and Linux unless noted.

- A **paid** Proton Mail plan
- **Node 24 or newer** and **pnpm** — `node --version`, `corepack enable pnpm` if pnpm is missing
- **Google Chrome**, for signing in (see [Signing in](#signing-in) for why)
- The [1Password CLI](https://developer.1password.com/docs/cli/) if you set `PMS_OP_VAULT` —
  **required** in that case, since credentials then come from the vault rather than a prompt. Enable
  *Integrate with 1Password CLI* in the desktop app. Leave `PMS_OP_VAULT` unset to be asked in the
  terminal instead and skip the CLI entirely.
- Optional: [Ollama](https://ollama.com) for folder-name suggestions — local, remote, or none

## Install

```sh
pnpm install
pnpm install:browser     # required before the first sign-in — downloads Chromium
pnpm check-types
pnpm test
```

**`pnpm install:browser` is not optional.** Signing in needs a browser (see
[Signing in](#signing-in)), and without this the first run stops with `BROWSER_NOT_INSTALLED`.
Note the script name: `pnpm exec playwright install` does *not* work from the repository root,
because Playwright is a dependency of one workspace package rather than of the root.

On Windows use **PowerShell** or **Git Bash**; both work. There is nothing to compile and no
platform-specific dependency.

## Run the dashboard

```sh
pnpm dev
```

Then open <http://localhost:5173>. It binds to localhost only.

On its own this runs entirely on a **synthetic mailbox** — no account, no network, nothing read and
nothing changed. Every screen says so. The logic behind it is the real thing: the same matcher,
grouping and conflict analysis that run against your mail, so a preview that looks wrong on screen is
a real bug rather than a fixture someone typed to look convincing.

To point it at your own mailbox instead, mirror the account once and then serve the mirror — see
[Show your own mailbox](#show-your-own-mailbox) below.

## Read your real mailbox

```sh
pnpm spike
```

A read-only probe: it signs in, then reports your folders, labels, filters and message counts, and
writes pseudonymised fixtures to `fixtures/recorded/`. It performs **no writes** — see
[the one rule](CLAUDE.md).

Configure it through a `.env` file in the repository root. Copy [.env.example](.env.example) and
edit it. A file rather than environment variables on purpose: `VAR=value command` is shell syntax
that does not exist in PowerShell, so a `.env` keeps the instructions identical on both systems.

```ini
PMS_OP_VAULT=Private          # omit to be prompted in the terminal instead
PMS_OP_ITEM=Proton
PMS_OP_ACCOUNT=my.1password.eu             # only if several accounts are signed in
PMS_BROWSER_CHANNEL=chrome    # use installed Chrome rather than the bundled Chromium
PMS_BROWSER_HEADLESS=false    # show the window; needed to switch to the 2FA code
PMS_BROWSER_PROFILE=data/browser-profile   # remember the device between runs
PMS_PUBLIC_ORIGIN=https://pi.tailnet.ts.net  # only if you reach it under a name, not loopback
```

`PMS_PUBLIC_ORIGIN` is the one to know about if you ever put this behind something. The server
binds to `127.0.0.1` and refuses any non-`GET` whose `Origin` is neither loopback nor exactly this
value — so a page on the internet cannot make your dashboard do anything, and a name that merely
resolves to your machine cannot either. Leave it unset for the ordinary case, where the only way in
is from this machine.

Two consequences worth knowing before you set it. A passkey is scoped to the name it was registered
under, so one registered on `localhost` will not be offered on a `ts.net` address and has to be
registered again. And the password is still required either way — a passkey has always been the
second factor here, never the key.

### Signing in

Proton's login carries an anti-abuse challenge that only their own page can produce. Without it
Proton refuses the login with code 2028, no matter how correct the credentials are. So the sign-in
happens **in a real browser**, where their script runs and nothing is imitated. The browser closes
as soon as the session is captured; everything after that is an ordinary HTTP client.

The session is then stored encrypted in `data/`, and **later runs reuse it without opening a
browser at all**. That is not a convenience — a program that signs in on every start looks exactly
like credential stuffing, and getting that wrong is what earned the 2028 in the first place.

If your account uses a passkey, run with a visible window and confirm it there. A passkey stored in
a password manager will not be offered in the dedicated browser profile, because your extensions
are not installed in it; a TOTP code is the easier route and is filled in for you when it comes from
1Password.

Your Proton password is typed into Proton's own page. It is never stored, logged, or included in an
error message.

## Mirror it locally

```sh
pnpm sync                            # last 30 days, at most 2000 messages
pnpm sync --days 90
pnpm sync --days 365 --max 5000
pnpm sync --days all --max 20000
```

Writes an encrypted SQLite database to `data/mailbox.db` — folders, labels, filters and message
metadata. The whole file is encrypted with a key derived by Argon2id; without the passphrase it has
no SQLite header and no table names, so nothing about it says "mailbox".

It is a copy, and nothing in it is authoritative. Losing it costs a resync, not data.

## Show your own mailbox

Two terminals. The first serves the local copy:

```sh
pnpm serve                           # http://127.0.0.1:5174, loopback only
```

The second is the dashboard as before:

```sh
pnpm dev                             # http://localhost:5173
```

### Signing in from the dashboard

There is a **Bei Proton anmelden** button in the sidebar, and what it opens is a browser window at
Proton's own login page. **No password passes through the dashboard, the local server, or the
process behind it** — you type in that window, or your password manager's browser extension fills
the form the way it would on any other site.

That is also why the extension only exists in one of the three modes: it lives in *your* browser
profile, not in a fresh one Playwright made. For 1Password, and for a passkey, use your own Chrome:

```sh
PMS_BROWSER_CHANNEL=chrome
PMS_BROWSER_PROFILE=~/.config/pms-chrome    # or your everyday profile, see the warning below
```

Those two are read by `pnpm serve` at startup, before the dashboard exists, so they belong in `.env`
rather than in the settings page — which lists them with their current values instead of offering a
field that would do nothing. The trade-off is stated there too: with a persistent profile the Proton
cookies end up in Chrome's own store as well as in our encrypted file.

A failed login is **not** retried. This account was locked out once by repeated attempts, so
`LoginGuard` rations them and a refusal is shown as a refusal — `pnpm spike --lockout-cleared`
releases a block, and only after you have signed in at mail.proton.me and seen the account is fine.

The dashboard now reads your mirror instead of the demo, and says so — including how old the copy is
and whether the last sync was cut short. Stop the server and reload, and it falls back to the demo
without an error: no server running is the ordinary case, not a failure.

The dashboard can now start a sync itself — there is a button and a progress bar — and it can offer
a change to your filters. Both need the serving process to hold a Proton session, and the guarantee
that replaces "the server never talks to Proton" is a sharper one:

> **HTTP is an offer, not a trigger. Nothing reaches your account without a `ja` typed in the
> terminal where `pnpm serve` is running.**

Clicking "Bei Proton speichern" sends the change and gets back a reference and six characters.
Nothing has been written at that point. The terminal prints what was asked for — derived from the
request itself, not from a label the browser chose — shows the same six characters, and waits. If
you walk away, nothing happens. If you type anything but `ja`, nothing happens.

A sync needs no confirmation because it changes nothing at the account: it reads, and writes only
into the local copy.

Before any write, a complete backup of every filter and folder is saved to `data/backups/`. After
it, the affected messages are read back from Proton — a write returning success means Proton
accepted the filter, not that any mail moved — and a partial result is reported as one. Every change
can be undone from the history, and undo moves back exactly the messages the journal recorded,
never everything in a folder.

There is no authentication on that port, deliberately. The database is open in the process, so
anything that can reach the port can read the mailbox; the answer to that is that nothing remote can
reach it, not a token that would make exposing it look safe.

Files under `data/` are restricted to your account — `chmod` on Unix, `icacls` on Windows, where
POSIX modes do not exist and `chmod` would only toggle a read-only flag. Check them with
`ls -l data/` or `icacls data\session.enc.json`.

Both the window and the limit default small on purpose: a page of a hundred messages costs about a
second, so a year of mail takes minutes. Ask for more only when you need it.

### Useful flags

```sh
pnpm spike --describe-1password    # print the vault item's field names, never their values
pnpm spike --scrub response.json   # pseudonymise a hand-captured response into a fixture
pnpm spike --lockout-cleared       # clear a login block after signing in at mail.proton.me
pnpm serve --auto-sync 0           # serve without the five-minute background refresh
pnpm serve --port 5175             # serve somewhere else
```

## From your phone and your other machines

The dashboard is a web page, so the way to use it away from this machine is to reach this machine —
not to install a second copy that logs in on its own. Two copies mean two Proton sessions, two
`LoginGuard`s that know nothing about each other, and two local journals that disagree about what
has already been undone. One instance, reached from everywhere, is the shape that keeps those
honest.

[Tailscale](https://tailscale.com) is what makes that reasonable: your devices get a private
network of their own, and `tailscale serve` puts a real certificate in front of the server without
opening anything to the internet.

```sh
# on the machine that runs it — a Raspberry Pi is plenty
tailscale serve --bg 5174

# it prints the name; put that into .env so the server knows what to expect
echo 'PMS_PUBLIC_ORIGIN=https://pi.tailnet-name.ts.net' >> .env
pnpm serve
```

Open that address on the phone and use *Add to Home Screen*. It gets its own icon and opens without
the browser's chrome — the same page, the same single database, nothing installed.

Four things worth knowing before you do it:

- **Confirmations happen in the dashboard now**, against the app password. That is why: on a machine
  nobody is sitting at, a question at the terminal is not a question. See „Where the second question
  is asked" in `CLAUDE.md` for what that trades away.
- **A passkey has to be registered again** under the new name. WebAuthn scopes credentials to the
  host, strictly and on purpose. The password is required either way.
- **Signing in at Proton needs a visible browser**, which a headless box does not have. Do that part
  where there is a screen, or set `PMS_OP_VAULT` and let the 1Password path run without one.
- **The key stays in memory for as long as the grace period**, on a machine you are not watching.
  Shorten it in the settings, or set it to `0` and type the password each time.

## Tests

```sh
pnpm test        # 976 unit and component tests — no network, no account, seconds
pnpm test:e2e    # 34 end-to-end tests in a real browser — about a minute
```

`pnpm test:e2e` needs Chromium, which `pnpm install:browser` puts in place. Without it the suite
stops with a message from Playwright naming the missing browser; it is the same download the sign-in
needs, so if you have signed in once you already have it.

### What the two suites are for

`pnpm test` is the one to run before every commit. It touches no network and opens no browser.

`pnpm test:e2e` starts, per file, a real SQLCipher database, the real local server, the real Vite
dev proxy and a headless Chromium, then drives the dashboard by clicking it. It exists for the three
questions the fast suite cannot answer, each of which has already been wrong here:

- **Does anything scroll sideways?** A stylesheet test checks a rule; only a viewport can measure a
  page. The reported bug was a scrollbar *inside a dialog*, which a check on the document would have
  missed entirely.
- **Does the browser reach the server?** Every earlier check used `curl` against the port. Whether
  the request survives the dev proxy — including the progress stream, which proxies love to buffer
  into one lump at the end — is a different question.
- **Do the mail-body defences hold?** `sandbox=""` and a Content-Security-Policy are enforced by a
  browser and by nothing else. The suite asserts that opening a hostile mail body produces zero
  outbound requests.

They are kept apart from `pnpm test` because they are slower by two orders of magnitude and can fail
for reasons outside the code — a missing browser, a loaded machine. Mixing that into the suite
everyone runs before committing teaches people to ignore a red result.

```sh
pnpm test:e2e apps/web/e2e/layout.e2e.ts    # one file
pnpm test:e2e -t "scrolls sideways"         # one test by name
```

To watch it work, set `PMS_E2E_HEADED=1` — the browser opens visibly and the clicking slows down:

```sh
PMS_E2E_HEADED=1 pnpm test:e2e apps/web/e2e/flow.e2e.ts
```

The suite never touches a real account. It seeds its own encrypted database in a temporary
directory, and its Proton is a stand-in that records what it was asked to write — which is how the
tests can assert that a refused change produced *no* requests.

## Testing against the real account

Two things need a real Proton account, and both are the account owner's to run.

```sh
pnpm write-test      # one deliberate round trip: create a folder, check it, delete it, check again
```

This is the smallest thing that exercises the write path end to end. It creates one empty folder
named `PMS-Schreibtest <date>`, reads the folder list back to confirm Proton really has it, deletes
it, and reads back again — because a write returning `200` means Proton accepted the request, not
that anything changed. It asks before it starts, touches no mail, and takes the same backup every
other write is preceded by. `--keep` leaves the folder in place.

The other is [TESTPLAN-PRODUKTIV.md](TESTPLAN-PRODUKTIV.md), which lists what only somebody with the
account can check.

### When something goes wrong

Every run writes a JSON log to `data/logs/pms-<date>.log` — one file per day, more detailed than
what the terminal shows, and git-ignored along with everything else under `data/`. It is the right
thing to attach to a bug report:

```sh
tail -n 200 data/logs/pms-$(date +%F).log
```

Secrets are redacted by key name when the line is written, not afterwards, so a password or token
cannot reach the file. `PMS_LOG_FILE=` (empty) turns the file off entirely.

## How this talks to Proton

Proton publishes no API. This tool uses the same endpoints as their web client, whose source is
open at [ProtonMail/WebClients](https://github.com/ProtonMail/WebClients), and identifies itself
honestly: `x-pm-appversion: Other`, the value third-party Proton clients have used for years. It
does not impersonate a first-party app, and it does not fabricate the anti-abuse challenge that
guards the login — it runs a real browser instead.

It also deliberately goes slowly. There is roughly a second between requests, plus jitter, and
requests queue rather than burst. Proton runs this service for its users and gets nothing from us
for it, and nothing this tool asks is urgent by the second.

That API carries **no stability guarantee** and may change without notice. The project is built so
that a change breaks loudly and specifically rather than silently doing the wrong thing — see
[CLAUDE.md](CLAUDE.md).

## Licence

GPL-3.0. The project incorporates GPL-3.0 code from Proton's web client — their Sieve filter
compiler (vendored, see [vendor/proton](vendor/proton/README.md)) and their `@protontech/crypto`
library for the SRP login. Details in [NOTICE](NOTICE).

Not affiliated with, endorsed by, or supported by Proton Technologies AG.
