# proton-mail-sorter

A local dashboard for Proton Mail's filters and folders.

Proton can sort incoming mail into folders automatically, but building and maintaining those filters
is tedious: every rule is assembled by hand, nothing shows you which rule affects which messages,
and nothing suggests the rules you would actually benefit from.

This tool reads your mailbox, groups the messages, and proposes rules — new ones, or extensions to
rules you already have. You confirm; it writes the filter to Proton. **Proton still does the
sorting.** The tool never moves your mail.

> **Status: early.** M0 is complete — repository scaffolding, the vendored Proton rule compiler, a
> read-only API client, and a login probe. Nothing writes to your account yet.

## What it will do

- Show every Proton filter in execution order, and for each one, **the messages it actually catches**
- Flag rules that can never fire because an earlier rule already caught everything
- Group inbox mail by sender, domain, mailing list and subject pattern, and suggest a destination
- Create folders, including nested ones, and keep the tree in sync with Proton
- Pick up rules and folders you created by hand in Proton's web UI and ask whether to adopt them
- Verify after every change that Proton really moved what it promised, and say so when it did not
- Undo any change, including moving the affected messages back

## Requirements

- A **paid** Proton Mail plan
- Node 24 or newer, and pnpm
- Optional: [Ollama](https://ollama.com) for folder-name suggestions — local, remote, or none

## Getting started

```sh
pnpm install
pnpm test
pnpm spike        # read-only probe against your account
```

`pnpm spike` asks for your Proton password and 2FA code in the terminal. They are used for the SRP
handshake and nothing else — not stored, not logged, not written to disk. It performs no writes.

## How this talks to Proton

Proton publishes no API. This tool uses the same endpoints as their web client, whose source is
open at [ProtonMail/WebClients](https://github.com/ProtonMail/WebClients), and identifies itself
honestly through the `x-pm-appversion` header in the form Proton documents for third-party clients:
`external-mail-proton-mail-sorter@<version>-<channel>`. It does not impersonate a first-party app.

That API carries **no stability guarantee** and may change without notice. The project is built so
that a change breaks loudly and specifically rather than silently doing the wrong thing — see
[CLAUDE.md](CLAUDE.md).

## Licence

GPL-3.0. The project incorporates GPL-3.0 code from Proton's web client — their Sieve filter
compiler (vendored, see [vendor/proton](vendor/proton/README.md)) and their `@protontech/crypto`
library for the SRP login. Details in [NOTICE](NOTICE).

Not affiliated with, endorsed by, or supported by Proton Technologies AG.
