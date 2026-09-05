# proton-mail-sorter

A local dashboard for managing Proton Mail's server-side filters and folders.

## The one rule

**This tool never moves mail.** Proton's own filters do the sorting; we only manage the rules that
tell Proton what to do. There are exactly **two** exceptions, and each is narrow in the same way —
it moves only message IDs somebody named, never a folder, a sender or a query:

1. **Undo**, which moves back exactly the message IDs a rule moved, from the undo journal's
   per-message snapshot — never a message the journal does not name. Reachable from the dashboard as
   `undo-entry` (one change) and `rewind-to` (a chain, newest first, stopping at the first failure);
   both go the ordinary route and both demand the terminal unconditionally.
2. **Moving into one of Proton's categories** (`move-to-category`), which moves exactly the IDs the
   user selected and then saw listed in the diff. It exists because a category cannot be a filter's
   destination: Proton files mail into „Werbung" or „Transaktionen" itself and offers no endpoint
   that reads or sets what it has learned, so moving the mail *is* the interface. `weigh()` demands
   the terminal for it unconditionally — including for one message — because this is the exception,
   and it should cost a keystroke every time.

The rule is enforced structurally, not by discipline: only `packages/proton-api/src/write/` may
issue non-GET requests, and `write/messages.ts` has exactly two importers, asserted as an exact set
in `write-isolation.test.ts` rather than as a filter anyone can extend. Every function in that file
takes `messageIds: string[]` — "only explicit ids" as a signature, not as a promise — and the test
checks that too. `category-service.ts` has no way to obtain an id: it reads through an injected
`readCurrent`, and the test checks for the absence. If you are about to add a write path anywhere
else, that is the signal to stop.

**Proton moving mail on our behalf is not a third exception, and the distinction is load-bearing.**
`applyFiltersToExisting` (`POST mail/v4/messages/apply-filters`) hands Proton the message ids the
diff listed and asks it to apply *its own* filters to them. We do not select mail and put it
somewhere; the service runs the rules it already has. That is what lets a new rule tidy up the
backlog with the core rule intact — and it is offered as a visible checkbox rather than inferred,
because for months the terminal announced it and nothing did it.

**There are six non-GET routes, not two, and every addition is named here because each was made on
purpose.** `POST /api/login` opens a browser window at Proton's own login page and waits; it
writes nothing to Proton's data, but it is the most consequential thing the tool does. `POST
/api/logout` is the only route on the list that *only ever takes away* — it ends the session, forgets
it, and deletes the local copy of the mailbox — and a tool that makes connecting easy and
disconnecting hard has the wrong shape. Both have their own line in `handler.ts` and share one
`SessionChannel`, because being connected is one piece of state and not two.

`POST /api/account` is the fifth and the odd one out: it is the only route that **cannot reach
Proton at all**, and the only one a locked tool answers. It creates the account and unlocks the key
that everything else on this machine is encrypted with — so it *acts* where the others only offer,
and what keeps that defensible is what it cannot do. It has no Proton client, cannot open a
database, and can only hand a key to the process that does. It is one route with a named action
rather than eleven paths, because the route count is a promise about what reaches Proton, and
spending eleven lines of it on a local password form would make the promise harder to read without
making it stronger; `AccountChannel` still names each action in a branch of its own.

`POST /api/history/clear` is the sixth and the smallest: it deletes rows from the local record and
touches nothing else — no Proton client, no channel, no confirmation from another window. What it
costs is stated where it is offered, because undo works from that table and a change with no entry
can no longer be reversed. The backups are untouched: they are files, this is a table, and clearing
a history must not quietly throw away the copy of every filter as it was before each change. The
record also caps itself at `JOURNAL_LIMIT` entries on write, not on read — a record that grew for
ever on disk and was merely *displayed* short would still be a growing pile of mail metadata.

What makes it defensible is not the route count. **No password passes through this process:**
`loginByHandInBrowser` opens the page and gets out of the way, so a password manager's browser
extension fills Proton's own form exactly as it would on any other site, and a passkey works because
the credential lives in that profile's own store. `connect()`'s older path — fetch the credentials
from 1Password and type them with Playwright — still exists for the CLI, and the two are tested
apart: `write-isolation.test.ts` asserts that the browser-driven login never reads a password.

**Disconnecting removes the local copy, and the order is the feature.** `signOut`
(`apps/spike/src/session.ts`) stops the auto-sync timer, revokes at Proton *while the tokens still
exist*, clears the client, and only then deletes the file — because `reuse()` re-persists after a
refresh, so removing the file while a live token exists can bring it back. Then the database is
closed and its four files go (`-wal` and `-shm` too: a `-wal` beside a fresh database is a
corruption path), along with the filter backups. `login-attempts.json` and `data/logs/` stay — a
lockout must not be clearable by disconnecting, and the log carries no mail content by construction.
The server shuts down afterwards, because it has just deleted everything it was serving.

`ProtonHttp` refuses every non-anonymous request without a session. That had to be added for the
above to mean anything: clearing the session used to leave the client sending unauthenticated
requests that Proton answered 401 — a pointless request to a service this project is deliberately
polite to, and a weaker guarantee than "signed out" reads as.

`LoginGuard` is not weakened by any of it. It is consulted before the window opens, a failure is
recorded, and there is no retry loop — the rule that got this account back. A button in a web
interface makes a login easy to hammer, which is exactly how the lockout happened, so a refusal is
shown as a refusal with no button beside it.

**The second exception created no new HTTP route.** It travels over the existing `POST /api/apply`
like every other change. The capability itself is handed to `applyChange` as
`ApplyContext.moveToCategory`, assembled in `apps/spike/src/serve-command.ts` — the process that
holds the session and owns the terminal — so neither `@pms/apply` nor `packages/server/` can reach
the module that performs it.

`packages/server/` is the same idea one layer out, and the guarantee there has a precise shape:

> **HTTP is an offer, not a trigger. No change reaches Proton without a second answer from a
> person — a `ja` typed at the terminal where `pnpm serve` runs, or, for a deletion, the app
> password re-entered in the dashboard beside the diff.**

The server holds a Proton session — it must, so the dashboard can start a sync — but the file that
parses a request cannot reach the code that performs one. They meet through a channel object handed
in from outside, and `write-isolation.test.ts` checks that the routing files import neither
`@pms/apply` nor the write surface. Six non-GET routes exist and each is named in an `if` rather
than entered in a table: `POST /api/sync`, which only reads at Proton, and `POST /api/apply`, which
records an offer and answers `202` while nothing has happened yet.

`packages/apply/src/steps.ts` is the only file in the project that imports `@pms/proton-api/write`.
One file to read when someone asks what this tool can change.

### Where the second question is asked, and why deleting moved

`weigh()` decides both, and it now returns a *place* rather than a boolean:

- **`terminal`** for everything that moves mail — a category move, an undo, a rewind — and for any
  change that resorts a large share of the mailbox. A keystroke in the window where `pnpm serve`
  runs cannot be produced by anything speaking HTTP, and that is worth the walk.
- **`password`** for a deletion. The app password, re-entered in the dashboard next to the diff that
  says what disappears.

The exchange is real and is stated here rather than implied. A password can be produced by anything
that knows it; a terminal keystroke cannot be produced over HTTP at all. What it buys is that the
person deleting a folder sees, at that moment, what is inside it and where that mail goes — and a
confirmation performed in another window, away from the thing being confirmed, is one people learn
to perform without reading. That is the failure `apply.ts` is built against, and the terminal was
starting to cause it.

It kept its teeth by being a secret rather than a gesture: the password is checked by the same
`Vault` that holds the key to the mailbox, through the same Argon2id derivation an unlock uses, so a
wrong one is refused and guessing is slow by construction. **Where there is no account, the terminal
keeps the deletion** — an installation with no password to ask for has nothing to check an answer
against, and then the gesture is all there is.

Two placement rules follow, and both are checked:

- **The password never travels on `/api/apply`.** A `ChangeRequest` is digested, journalled and
  reported; nothing carrying a password may end up in a record. It goes to `/api/account` as
  `confirm-change`, which is where the account's secrets already live.
- **The grant is keyed by request id and expires.** „The user typed their password recently" would
  confirm whatever arrived next; five minutes of silence answers `expired`, and the change is
  refused rather than left armed for as long as the server runs.

### Shipping it: one server, one browser, no Electron

`scripts/package-app.mjs` turns the workspace into `release/` — the launcher, the bundled server, the
built dashboard, and the two dependencies that cannot be bundled. `.github/workflows/release.yml`
runs it once per platform when a release is published.

**No Electron, and the reason is the login.** It has to happen in the user's own browser, with their
password manager's extension and their passkeys; a bundled Chromium would add 150 MB and still not
be the browser that matters. So the packaged shape is the shape the app already has — a local server
plus the browser you have — and the archive ships no browser at all.

Four things about it are load-bearing:

- **Bundling is what removes vite-node.** `@protontech/crypto` and the vendored Proton packages ship
  raw TypeScript, which is why `pnpm serve` needs vite in a checkout. esbuild transpiles them once,
  at packaging time, and the result is plain JavaScript Node runs by itself. The `openpgp/lightweight`
  redirect from `vite.config.ts` has to be repeated there, or there is no SRP login.
- **Two dependencies stay external, for different reasons.** `better-sqlite3-multiple-ciphers` is a
  native module whose `.node` binary is per platform and per Node version — which is why the workflow
  is a matrix and not a cross-compile. `playwright` resolves its driver through paths relative to its
  own package directory, and bundling breaks that.
- **The server serves the dashboard.** `ServeOptions.webRoot` turns on `static.ts`, so the packaged
  app is same-origin and the browser is never asked which origins may read one account's mailbox.
  `static.ts` is where a request path meets the filesystem, and `data/` sits a short way above the
  web root — `static.test.ts` is the guard, and it asserts one thing: nothing resolves outside the
  root, ever. The `/ollama` proxy moves across for the same reason vite has one.
- **`paths.ts` has a third answer now.** It used to walk up for `pnpm-workspace.yaml` and *throw*
  when there was none, so the first packaged build died on its first line while every test stayed
  green. A downloaded copy keeps its files beside the launcher, where somebody can see and delete
  them — not in a hidden directory under the home, which would bury the one thing this tool promises
  you can remove.

`scripts/smoke-release.mjs` is what catches that class of failure: it copies `release/` somewhere
else, starts it with the Node that ships in it, and checks that the page is served, that a fresh
directory has no account, and that the mailbox answers `423` rather than empty. It never reaches
Proton — a fresh directory has no session to reach it with.

### The password is the key, not a door

`@pms/account` is not a login that guards a screen. The mailbox database and the stored Proton
session are encrypted with a master secret, and the app password is what unwraps it — so somebody
who copies `data/` and does not have the password has a directory of noise. That is why `pnpm serve`
opens **nothing** at start-up: it comes up serving `/api/account` and a lock screen, and the
database is opened when the key arrives.

Four consequences worth knowing before touching any of it:

- **There is no password recovery, and there cannot be one.** A way back would have to keep the key
  somewhere a password does not protect. The registration screen says so before the password is
  chosen, which is the only honest place to say it.
- **A passkey is a second factor, not the key.** WebAuthn returns a signature, not a secret, so
  nothing in it can unwrap a key — the password is always required as well. (The PRF extension could
  change that; `vault-key.ts` is shaped to take a second wrapping when browser support settles.) The
  interface says this, because „Passkey" that then asks for a password reads as a bug otherwise.
- **The KDF is slow on purpose.** Argon2id at 64 MiB costs about 1.5 s per derivation, which is what
  makes a stolen file useless. Tests are given room rather than the KDF being made cheap — see the
  timeout on `encryption.test.ts`'s describe.
- **`register()` adopts an existing passphrase.** An installation that already has a database was
  encrypted with whatever came from 1Password or a prompt; minting a fresh key at registration would
  orphan it. `serve-command.ts` asks for the old one once, at the terminal, and only in that case.

**Unlocking can never spend a Proton login.** `resume()` picks up a stored session and refreshes it;
if there is none it returns a client with none, which refuses every request. `connect()` — the path
that will log in as a last resort — is not reachable from the dashboard. A password field that could
cause a login attempt would put `LoginGuard`'s whole reason for existing behind a text box.

The grace period is a deliberate weakening and is described as one: locking keeps the key for a
configurable while, so closing a tab does not mean reconnecting to Proton a minute later. `0` turns
it off, and the way back in during it is its own button — „weiter ohne Passwort" — rather than an
empty password quietly being accepted.

### Where the category ids and the category endpoint come from

The ids in `CATEGORY_LABELS` (`packages/grouping/src/group.ts`) are Proton's own `MAILBOX_LABEL_IDS`,
read out of `@proton/shared` as it ships minified in the desktop client — proton-mail 1.13.3, Debian
package, binary dated 2026-06-11, read on 2026-09-04:

```sh
strings /usr/lib/proton-mail/resources/app.asar | grep -o 'CATEGORY_[A-Z]*="[0-9]*"'
```

Two things there look like mistakes and are not. **There is no 23** — the sequence has a hole, and
"completing" it would invent a category Proton does not have. And **a category is not a label type**:
`LABEL_TYPE` runs 1–4 and none of them means category. These are fixed system label ids riding along
in every message's `LabelIDs`, exactly like the inbox, so reading them costs no endpoint at all.

The endpoint was captured from Proton's own client moving a mail into „Transaktionen" —
`PUT mail/v4/conversations/label`, body `{LabelID, IDs}`, answered 200 — and then matched against
`packages/shared/lib/api/messages.ts` in ProtonMail/WebClients, which defines the message-shaped
sibling `labelMessages` = `PUT mail/v4/messages/label`. **We send the message variant, not the
conversation variant**, even though the capture shows the conversation one: labelling a conversation
moves the whole thread, which is more than the user selected. `SpamAction` is omitted — it steers
Proton's spam handling and has nothing to do with categories.

Two things remain unverified and are stated as unverified on screen: whether the previous category
falls away by itself (Proton's client sends no `unlabel`, which suggests it does — suggests), and
whether a category move takes mail out of the inbox. `clearedFromInbox` stays 0 for this change kind
until the first real run says otherwise.

### The negative finding that explains the „Auto-Regeln" tab

`applications/mail/src/app/components/categoryView/useRecategorizeElement.ts` in WebClients calls
`applyLocation({type: MOVE, elements, destinationLabelID: categoryId})` and **nothing else**. There
is no second request, no "apply to future" flag, no field. `mail/v4/settings/mail-category-view` is
only a global on/off. **Proton's per-sender learning happens server-side and is invisible from
outside** — no endpoint reads it and none sets it.

That is why „Auto-Regeln" observes instead of managing. It records which category each message
carried at each sync (`message_categories`, `category_observations`) and infers from repetition, and
every verdict on that screen is phrased as an observation — *"every time we looked"* — never as a
rule. The screen names its own blind spots: an incremental sync only fetches new mail, so
"unchanged" there means **not looked at**; a change may be the user's own, made in Proton's app, and
the two cannot be told apart.

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
  indefinitely — released only by `pnpm spike --lockout-cleared`, which the owner runs once they
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
packages/changes/       Diff, the change record, category moves and post-write verification
packages/store/         The encrypted local database
packages/sync/          Mirroring Proton into it, and reading it back
packages/account/       The app's own account: the password that is the key to the local data
packages/server/        Serving that mirror to the dashboard, and taking offers — loopback only
packages/apply/         The one path that writes to Proton, behind a second confirmation
apps/spike/             M0 read-only probe, plus `--sync` and `--serve`; the packaged entry point
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
                        # and for confirming changes that move mail — it asks in *this* terminal
pnpm dev                # the dashboard, http://localhost:5173 (demo data unless `pnpm serve` runs)
pnpm package            # build a downloadable copy into release/
pnpm smoke              # start that copy somewhere else and check it works
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

**The record of what was changed.** `journal_entries` in the encrypted local database, written by
`pnpm serve` after each apply and read back into the snapshot the dashboard already fetches. It
holds message ids and label ids and nothing else — the diff had subjects and senders and did not
need to keep them, and what is not stored cannot leak out of a bug report. `moved` is filled from
what verification *observed*, never from what the plan intended: undo works from that record, so a
record built from intentions would move back mail that never moved.

A change is named by `describeChange` and by nothing else. There is no `summary` field: there was,
written by hand at ten call sites, which produced two wordings for one act depending on which screen
staged it. The diff, the terminal question and the history have to agree, so the name is derived.

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
