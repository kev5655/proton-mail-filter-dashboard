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

Right now this runs entirely on a **synthetic mailbox** — no account, no network, nothing read and
nothing changed. Every screen says so. The logic behind it is the real thing: the same matcher,
grouping and conflict analysis that will run against your mail, so a preview that looks wrong on
screen is a real bug rather than a fixture someone typed to look convincing.

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
```

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

Files under `data/` are restricted to your account — `chmod` on Unix, `icacls` on Windows, where
POSIX modes do not exist and `chmod` would only toggle a read-only flag. Check them with
`ls -l data/` or `icacls data\session.enc.json`.

Both the window and the limit default small on purpose: a page of a hundred messages costs about a
second, so a year of mail takes minutes. Ask for more only when you need it.

### Useful flags

```sh
pnpm spike --describe-1password    # print the vault item's field names, never their values
pnpm spike --scrub response.json   # pseudonymise a hand-captured response into a fixture
pnpm spike --sperre-geklaert       # clear a login block after signing in at mail.proton.me
```

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
