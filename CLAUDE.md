# proton-mail-sorter

A local dashboard for managing Proton Mail's server-side filters and folders.

## The one rule

**This tool never moves mail.** Proton's own filters do the sorting; we only manage the rules that
tell Proton what to do. The single exception is **undo**, which may move back exactly the message
IDs a rule moved, recorded in the undo journal — never a message the journal does not name.

The rule is enforced structurally, not by discipline: only `packages/proton-api/src/write/` may
issue non-GET requests, and the message-moving calls inside it are reachable only from the undo
service. If you are about to add a write path anywhere else, that is the signal to stop.

`packages/server/` is the same idea one layer out, and the guarantee there has a precise shape:

> **HTTP is an offer, not a trigger. No change reaches Proton without a `ja` typed at the terminal
> where `pnpm serve` runs.**

The server holds a Proton session — it must, so the dashboard can start a sync — but the file that
parses a request cannot reach the code that performs one. They meet through a channel object handed
in from outside, and `write-isolation.test.ts` checks that the routing files import neither
`@pms/apply` nor the write surface. Two non-GET routes exist and both are named in an `if` rather
than entered in a table: `POST /api/sync`, which only reads at Proton, and `POST /api/apply`, which
records an offer and answers `202` while nothing has happened yet.

`packages/apply/src/steps.ts` is the only file in the project that imports `@pms/proton-api/write`.
One file to read when someone asks what this tool can change.

Related: no write reaches Proton without explicit user confirmation, and every write is preceded by
a full JSON backup of all filters and folders.

## Every change takes the same route

**stage → diff → confirm → apply → verify → journal.** No step is skipped, including for changes the
tool itself proposed: a dialog that appears for a hand-written rule and not for a suggested one
teaches people to click through it.

The diff shows consequences, not intentions — which messages move, from where, and which *other*
rule was quietly handling them until now. Verification looks afterwards, because a write returning
success means Proton accepted the filter, not that any mail moved; a partial result is raised, never
rounded up. Undo removes the rule *and* moves back exactly the messages that change moved, from the
journal's per-message snapshot — never everything currently in a folder, which would swallow mail
filed there by hand.

## Status

M0 is mostly done: repository, vendored Proton compiler, read-only API client, login spike, session
persistence. Nothing writes to Proton yet. The spike has not yet completed a run — the test account
is under a temporary Proton lockout (see below).

**Read this before touching the login.** Proton answered code 2028, "unusual activity targeting your
account", to every login from this project. It was never an account lock: the same account signed in
through a browser at the same moment. Proton was rejecting the *shape* of our handshake.

Two things were missing, and only the second was decisive.

The handshake has three steps, not two: `POST auth/v4/sessions` opens an unauthenticated session
first, and `auth/info` and `auth` run inside it carrying its `x-pm-uid`. That is now done, and
Proton accepts it — but it was not the cause. `packages/proton-api/test/login-handshake.test.ts`
pins the sequence, so it can be checked without spending an attempt.

The cause is the **`Payload`** on `core/v4/auth`: an anti-abuse challenge of device and behaviour
telemetry that Proton's own script collects in the page. Without it, 2028, whatever the credentials
are. It has no specification, a fabricated one is a worse signal than none, and forging an anti-abuse
control is not something this project does — so **the login runs in a real browser**
(`@pms/browser-auth`), where Proton's script produces a genuine challenge and nothing is imitated.
It is also the only way a passkey works at all: WebAuthn needs an authenticator, which no Node HTTP
client has — and for a passkey that means `PMS_BROWSER_CHANNEL=chrome` and a visible window, since
the credential lives in the real browser's store, not in Playwright's Chromium. `PMS_BROWSER_PROFILE`
keeps that profile between runs so Proton recognises the device; it is opt-in because those cookies
sit in Chrome's store rather than in our encrypted session file. The browser exists for the login and closes straight afterwards; everything else is the
ordinary API client. `write-isolation.test.ts` checks that it is only ever pointed at the login page,
because a browser driven to a mailbox could move mail with every HTTP-level guard intact.

`packages/proton-api/src/auth.ts` keeps the pure-API SRP login. It is correct and currently refused;
it stays because the browser is a cost, not a preference.

Two of our own bugs made it worse before that was understood: the spike re-authenticated on every
run, and one run sent an empty password because of a prompt bug.

Consequences that are now load-bearing:

- **Never log in when a stored session would do.** `apps/spike/src/session.ts` is the order to
  follow: stored session, then refresh, then login. Proton rotates the refresh token on each use, so
  a refreshed session must be written back.
- **`LoginGuard` refuses attempts during an escalating cooldown**, and after a 2028 it refuses
  indefinitely — released only by `pnpm spike --sperre-geklaert`, which the owner runs once they
  have signed in at mail.proton.me and seen the account is reachable. No timer, deliberately: a
  clock would schedule the next blind attempt. Do not weaken it or wrap it in a retry loop.
- **Diagnose a rejected login offline.** The last one was a missing request, findable in
  `vendor/proton/` and in the WebClients source, and every live attempt spent guessing at it cost
  the account owner something.
- **Never retry a failed login automatically.** One attempt, then stop.

## Layout

```
vendor/proton/          Proton's own code, GPL-3.0, pinned to a commit — see vendor/proton/README.md
packages/core/          Error taxonomy and logging
packages/credentials/   1Password and prompt sources, plus the verification every one passes
packages/browser-auth/  Signing in through a real browser, because the login carries a challenge
packages/proton-api/    SRP login, HTTP client, response validation, read endpoints, session store
packages/rules/         Rule model, the vendored compiler, the local matcher, suggestions, conflicts
packages/grouping/      Subject templates, grouping, and the triage ranking
packages/demo/          A synthetic mailbox, so the interface can be built without an account
packages/llm/           Provider interface, an Ollama adapter, and a deterministic stand-in
packages/mail-view/     Sanitising a mail body so it is safe to display
packages/changes/       Diff, undo journal and post-write verification
packages/store/         The encrypted local database
packages/sync/          Mirroring Proton into it, and reading it back
packages/server/        Serving that mirror to the dashboard, and taking offers — loopback only
packages/apply/         The one path that writes to Proton, behind a terminal confirmation
apps/spike/             M0 read-only probe, plus `--sync` and `--serve`
apps/web/               The dashboard. Reads the real mirror when the server runs, else the demo.
```

The rule engine has three parts that must agree: the **compiler** (vendored, produces what Proton
runs), the **matcher** (predicts what that will catch), and the **analysis** on top of the matcher.
`matcher-agrees-with-compiler.test.ts` is what keeps the first two aligned — treat a failure there
as a real finding, not a test to adjust.

## Working here

```sh
pnpm install
pnpm check-types        # builds vendor declarations, then tsc over everything
pnpm test               # vitest
pnpm spike              # the M0 probe — asks for credentials, reads only
pnpm sync               # mirror the account into the local encrypted database
pnpm serve              # serve the mirror on 127.0.0.1:5174, and hold the session for syncs
                        # and for confirming changes — it asks in *this* terminal
pnpm dev                # the dashboard, http://localhost:5173 (demo data unless `pnpm serve` runs)
```

The dashboard renders whichever mailbox it is given — the demo, or the real mirror when
`pnpm serve` is running — through the same screens and the same engine. It says which one it is
showing, on every screen, along with how old the copy is and whether it is complete. That the two
sources are interchangeable is the point: a dashboard that only works on the demo has been testing
itself.

The web app is wired to the real engine, not to mock screens: what it shows is genuinely what the
matcher, the grouping and the conflict analysis produce from its source. A preview that looks wrong
on screen is a bug in the logic, not in a fixture someone typed to look convincing. Its demo
mailbox is deliberately awkward — a sender whose mail splits in two, a rule that never fires, one
that is always overridden, folders shadowing Proton's own — because a tidy demo makes every screen
look good and teaches nothing.

`pnpm spike` must be run by the account owner. **Never ask for credentials and never accept a
token** — not to test something, not to save a round trip.

Credentials come from 1Password when `PMS_OP_VAULT` is set (see `.env.example`), otherwise from a
terminal prompt. The session passphrase can live in the same item under `session-passphrase`, which
reduces the whole login to one fingerprint; it is a separate value from the Proton password because
it protects a different thing — the tokens on this machine, not the account. The 1Password path shells out to `op`, which makes the app ask for a fingerprint;
the value goes straight into the SRP handshake and is never logged, stored, or included in an error.

`pnpm spike --scrub <file.json>` runs a hand-captured API response through the same pseudonymiser
the spike uses and writes it to `fixtures/recorded/`. Use it when a response is needed as a fixture
but the spike cannot fetch it: the raw file stays on the machine, only the scrubbed result is shared
or committed.

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

**3. Proton's escaping for `starts`/`ends` is broken, and the matcher copies the bug.**
`escapeCharacters` in the vendored compiler escapes wildcards first and backslashes second, so the
backslash it adds to neutralise a `*` gets escaped in turn: `a*b` compiles to `a\\*b`, which Sieve
reads as "a, literal backslash, anything, b". A Proton filter "begins with a*b" therefore matches
almost nothing, silently — in Proton, not just here. `matchesRule` reproduces it on purpose, because
its job is to predict Proton rather than to be right; `protonEscapingIsBroken` flags such values so
the UI can warn before the rule is written.

**4. Tree filters cannot match arbitrary headers.** Proton's clickable filters support only
`subject`, `sender`, `recipient` and `attachments`. Grouping by `List-Id` therefore requires a Sieve
filter, which is no longer editable in Proton's own UI. That trade-off belongs in front of the user
per rule, not hidden in a default.

## Conventions

**Pace.** `ProtonHttp` leaves a gap between requests — `minIntervalMs`, ~900 ms plus jitter — and
queues them so a burst becomes a sequence. Proton runs this service for its users and gets nothing
from us for it, and nothing this tool asks is urgent by the second. Only tests may set it to 0. The
jitter is not decoration: a request exactly every 900 ms is a machine signature.

**The write path, in order.** `apply.ts` does freshness → refuse → confirm → read the before-picture
→ back up → write (folder before filter) → journal → verify → report, and every position was chosen
against a specific failure. The journal records what verification *observed*, never what the plan
intended: undo works from that record, so a journal built from intentions would move back mail that
never moved. Nothing is rolled back automatically — deleting a folder moves the mail inside it, and
an error path is the worst place to do that unwatched.

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

**Displaying mail.** Bodies are hostile input. `@pms/mail-view` sanitises, the viewer renders into
an `iframe sandbox=""`, and that frame carries a CSP forbidding every outbound request — three
layers, each written assuming the other two failed. Remote images stay off until the user turns them
on for one message: a tracking pixel hands the sender the reader's IP and the time they opened it,
which is exactly what a Proton account exists to withhold. Do not add a global "always load images"
setting.

**What the model may decide.** It names and explains. It does not decide what a rule matches. A
proposal comes back as *criteria*, is validated against the fields Proton can actually filter on,
compiled by our compiler, and run through the matcher before the user sees anything — so what is
shown is the real list of affected mail, not the model's claim about it. A wrong folder name costs a
rename; a wrongly trusted filter costs mail nobody finds again. Generated prose is always labelled
and always sits below the derived structure, never instead of it.

**Comments.** Say what a thing is and why it is not obvious. Do not narrate change history.

**Processes.** Only kill a PID you recorded when you started it. A command line does not say whose
process it is: `vite-node ... src/main.ts` is the spike whether the assistant launched it or the
user is sitting at its password prompt, and one was killed that way. When a dev server needs
restarting after a new workspace package is linked, say so and let the user do it, or note the PID
at launch and kill only that.

**Git.** Check `git status` before `git add -A` — three empty files once made it into a commit
that way, created by stray shell redirection and swept up without anyone looking. Author identity is
pinned per-repo (`git config --local`) to keep a private address out of
a public history. Work on feature branches; never commit to `main` and never push without asking.
