# proton-mail-sorter

A local dashboard for managing Proton Mail's server-side filters and folders.

## The one rule

**This tool never moves mail.** Proton's own filters do the sorting; we only manage the rules that
tell Proton what to do. The single exception is **undo**, which may move back exactly the message
IDs a rule moved, recorded in the undo journal — never a message the journal does not name.

The rule is enforced structurally, not by discipline: only `packages/proton-api/src/write/` may
issue non-GET requests, and the message-moving calls inside it are reachable only from the undo
service. If you are about to add a write path anywhere else, that is the signal to stop.

Related: no write reaches Proton without explicit user confirmation, and every write is preceded by
a full JSON backup of all filters and folders.

## Status

M0 is mostly done: repository, vendored Proton compiler, read-only API client, login spike, session
persistence. Nothing writes to Proton yet. The spike has not yet completed a run — the test account
is under a temporary Proton lockout (see below).

**Read this before touching the login.** Proton locked the account with code 2028, "unusual activity
targeting your account", after a handful of failed logins from this project. The cause was ours: the
spike re-authenticated on every run, and one run sent an empty password because of a prompt bug. A
program that logs in on every start is indistinguishable from credential stuffing.

Consequences that are now load-bearing:

- **Never log in when a stored session would do.** `apps/spike/src/session.ts` is the order to
  follow: stored session, then refresh, then login. Proton rotates the refresh token on each use, so
  a refreshed session must be written back.
- **`LoginGuard` refuses attempts during a cooldown**, six hours after a lockout. Do not weaken it
  or work around it in a retry loop. Retrying into an active lock is what extends the lock.
- **Never retry a failed login automatically.** One attempt, then stop.

## Layout

```
vendor/proton/          Proton's own code, GPL-3.0, pinned to a commit — see vendor/proton/README.md
packages/core/          Error taxonomy and logging
packages/proton-api/    SRP login, HTTP client, response validation, read endpoints
packages/rules/         Rule model and the Sieve/tree compiler (re-exported from vendor)
apps/spike/             M0 read-only probe against a real account
```

## Working here

```sh
pnpm install
pnpm check-types        # builds vendor declarations, then tsc over everything
pnpm test               # vitest
pnpm spike              # the M0 probe — asks for credentials, reads only
```

`pnpm spike` must be run by the account owner. **Never ask for credentials and never accept a
token** — not to test something, not to save a round trip.

Credentials come from 1Password when `PMS_OP_VAULT` is set (see `.env.example`), otherwise from a
terminal prompt. The 1Password path shells out to `op`, which makes the app ask for a fingerprint;
the value goes straight into the SRP handshake and is never logged, stored, or included in an error.

`pnpm spike --describe-1password` prints the item's **field labels only**. Use it when the item is
not laid out as expected — the answer to "what is the field called" must never require revealing a
value.

Every credential passes `@pms/credentials/verify` before use. That is not ceremony: an empty
password from a broken prompt was sent to Proton once and contributed to the account lockout. Any
source can hand back nothing, and nothing must reach Proton.

## Three things that will bite you

**1. Proton's API is internal.** It has no stability guarantee. That is accepted — the requirement
is not that we never break, but that a break is *obvious*. Three layers do that:

- `vendor/proton/` is pinned to a commit, so an upstream type change becomes a compile error here.
- Every response is validated by a zod schema in `packages/proton-api/src/schemas.ts`. A mismatch
  raises `PROTON_SCHEMA_MISMATCH` naming the endpoint and the exact JSON path.
- `packages/proton-api/types/*.d.ts` hand-declares `@protontech/crypto`, which ships raw TypeScript
  that will not compile under our settings. A hand-written declaration is a promise the compiler
  cannot check, so `test/crypto-boundary.test.ts` checks it at runtime instead. Keep the two in step.

**2. Some dependencies ship TypeScript, not JavaScript.** `@protontech/crypto` and the vendored
Proton packages are raw `.ts`. Node cannot load them, so anything that runs them goes through
vite (`vite.config.ts` lists them under `ssr.noExternal`). `tsx` does *not* work for this. Also,
`packages/proton-api/src/polyfill.ts` must be imported before any SRP code: Node 24 lacks
`Uint8Array.fromBase64`, which the library assumes.

**3. Tree filters cannot match arbitrary headers.** Proton's clickable filters support only
`subject`, `sender`, `recipient` and `attachments`. Grouping by `List-Id` therefore requires a Sieve
filter, which is no longer editable in Proton's own UI. That trade-off belongs in front of the user
per rule, not hidden in a default.

## Conventions

**Errors.** Everything user-visible is an `AppError` from `@pms/core/errors` with a code from
`ERROR_CODES`, a German message, a hint, and structured context. Codes are stable and appear in the
UI so a report can be grepped back to the throw site. Never put mail content or secrets in context —
`validate.ts` describes values (`string(length 25)`) rather than quoting them, for that reason.

**Logging.** `getLogger('module')` from `@pms/core/logger`. Secrets are redacted by key name at
serialisation time; `packages/core/test/logger-redaction.test.ts` is the proof, and any new
secret-bearing field name belongs in `SECRET_KEYS`.

**Tests.** The rule compiler is tested against Proton's own fixtures — those tests are the tripwire
for the vendoring, so do not weaken them to make a refresh pass. If upstream changes behaviour, that
is a finding to surface, not a test to adjust. `packages/rules/test/sieve-compiler.test.ts` also
documents a real lossiness: version 1 filters cannot be read back as `starts`/`ends`.

**Comments.** Say what a thing is and why it is not obvious. Do not narrate change history.

**Git.** Author identity is pinned per-repo (`git config --local`) to keep a private address out of
a public history. Work on feature branches; never commit to `main` and never push without asking.
