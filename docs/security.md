# Security design

Written for somebody reviewing this, not for somebody using it. It says what is encrypted, with
what, under which parameters, and — the part most such documents leave out — what is **not**
protected and where the weak points are.

Everything here was read out of the code rather than remembered. File and line references are given
so a reviewer can disagree with the prose.

---

## 1. What this defends against, and what it does not

The asset is a local mirror of a Proton mailbox: message metadata, subjects, senders, folder and
filter structure, plus a stored Proton session that can fetch more.

**In scope.** Somebody who obtains the files — a stolen laptop, a backup that ended up somewhere
else, a copied SD card from the Raspberry Pi, a cloud sync that swept up `data/`. Against that
attacker the directory is noise without the password.

**Out of scope, and not by oversight.**

- **Anyone who can read the memory of the running process while it is unlocked.** The master key is
  a field on one object (`packages/account/src/vault.ts`); root, the same user, and a debugger all
  see it. There is no defence here and pretending otherwise would be worse than saying so.
- **Malicious code running as the same user.** It can read the process, the files, and the terminal.
- **Proton itself**, and anyone who compromises the account at Proton.
- **Traffic analysis.** Requests to Proton are paced (`ProtonHttp`, ~900 ms plus jitter) for
  politeness, not for privacy.

---

## 2. The key hierarchy

The single most important design decision: **the password does not encrypt the data. It unwraps a
key that does.**

```
password ──Argon2id(salt, t=3, m=64 MiB, p=1)──▶ KEK (32 B, never stored)
                                                   │
                        account.json: wrapped ──AES-256-GCM──▶ master secret (32 random bytes, hex)
                                                                     │
                        ├── mailbox.db      ──Argon2id(salt)──▶ 32 B ──▶ SQLCipher raw key
                        ├── session.enc.json ──scrypt(salt)───▶ 32 B ──▶ AES-256-GCM
                        └── TOTP secret      ──SHA-256────────▶ 32 B ──▶ AES-256-GCM
```

Two things that indirection buys, both stated in `vault-key.ts`:

- **Changing the password re-encrypts nothing.** Only the wrapping is redone. A direct key would
  mean rewriting a database of somebody's mail, with every way that can be interrupted halfway.
- **A second wrapping can be added** — a recovery code, a passkey with PRF — without the data
  caring. This is what makes §6 possible at all.

### Parameters, exactly

| Where | Function | Parameters | Salt | Source |
| --- | --- | --- | --- | --- |
| Password → KEK | Argon2id (`@noble/hashes`) | `t=3, m=65536 KiB, p=1`, 32 B out | 16 B random, per account | `account/src/vault-key.ts:33` |
| Master key wrapping | AES-256-GCM | 12 B IV, tag stored | — | `vault-key.ts:87` |
| Passphrase → database key | Argon2id | `t=3, m=65536 KiB, p=1`, 32 B out | 16 B random | `store/src/key.ts:29` |
| Passphrase → session key | scrypt (Node) | `N=2^17, r=8, p=1, maxmem=256 MiB` | 16 B random | `proton-api/src/session-store.ts:34` |
| Session envelope | AES-256-GCM | 12 B IV, tag stored | — | `session-store.ts:63` |

`m=65536` is KiB, so **64 MiB per derivation**, about 1.5 s on the author's machine. That cost is
the point: memory hardness is what removes a GPU farm's advantage, and it is paid once per unlock.
It is never lowered for tests — see §11.

### Why SQLCipher's own KDF never runs

SQLCipher will derive a key from a passphrase using PBKDF2. It is not allowed to. PBKDF2 is only as
expensive as its iteration count, and an attacker holding the file has unlimited attempts on
hardware we do not choose. The passphrase becomes 32 raw bytes via Argon2id and SQLCipher is handed
those bytes: `db.pragma("cipher='sqlcipher'")` then `db.pragma(\`key="x'<hex>'"\`)`
(`store/src/database.ts:43`). Order matters — both must be set before the first read.

---

## 3. What is on disk, and what of it is plaintext

Per account directory (`data/`, or `data/accounts/<slug>/` — see §7):

| File | Encrypted | Contains |
| --- | --- | --- |
| `mailbox.db` (+ `-wal`, `-shm`) | **yes**, SQLCipher | the whole mirror: subjects, senders, labels, the journal, category observations |
| `mailbox.db.kdf.json` | no, **and correctly so** | KDF name, salt, cost parameters, version |
| `account.json` | partly | see below |
| `session.enc.json` | **yes**, AES-256-GCM | Proton `uid`, access token, refresh token, cookies |
| `backups/*.json` | **no** | filter and folder snapshots taken before each change |
| `login-attempts.json` | no | failure counts and cooldowns |
| `browser-profile/` | **no** | Chrome's own cookie store, if `PMS_BROWSER_PROFILE` is set |

**`account.json` is the one worth reading carefully** (`account/src/record.ts:52`). Plaintext:
`username`, the KDF salt and parameters, `graceMinutes`, and the passkey **public** credential
records. Encrypted: the wrapped master key, and the TOTP secret if there is one. A salt is not a
secret and neither is a cost parameter — they must be readable before anything can be opened.

**Two files deserve a reviewer's attention because they are not encrypted:**

- **`backups/`** holds filter and folder structure — no message content, but it does reveal how
  somebody organises their mail. It exists so a change can be undone even if the database cannot be
  opened, which is exactly the situation in which encrypting it would defeat its purpose.
- **`browser-profile/`** is Chrome's own store, written by Chrome. This project does not encrypt it
  and cannot. It is opt-in for that reason (`.env.example` says so), and it is the single largest
  plaintext exposure on the disk when enabled: those cookies are a Proton session.

`writePrivateFile` (`core/src/private-file.ts`) writes `0600` **and then `chmod`s** — `writeFile`'s
`mode` applies only on creation, so a file that was ever loose stayed loose through every rewrite.
On Windows it attempts an ACL change and does not treat failure as fatal, which is the honest
trade: what this defends against is another user account on the same machine, and an administrator
reads it either way.

---

## 4. Two things a reviewer will flag, answered

**`sealWithMasterKey` uses a bare SHA-256 as the key derivation** (`vault-key.ts:145`). That would
be wrong for a password. It is not one: the master secret is 32 bytes from `randomBytes`, hex
encoded, so it already has 256 bits of entropy and a single hash is a length adjustment rather than
a stretch. It is used for the TOTP secret, which must not be readable from `account.json` alone —
otherwise somebody holding the file could generate valid codes and would have defeated the second
factor without touching the first.

**Argon2id runs over the master secret when opening the database**, which looks like 1.5 seconds
spent stretching something that is already random. Two reasons it stays:

1. **The input is not always high-entropy.** `register()` can *adopt* an existing passphrase — an
   installation whose mailbox predates the account layer was encrypted with whatever came from
   1Password or a terminal prompt. For those the KDF is doing real work, and the code cannot tell
   the two cases apart from the value alone.
2. It binds the database key to a per-database salt, so two accounts with the same passphrase do
   not share a key.

An HKDF fast path for the known-random case would be correct and would save a second per unlock. It
is a legitimate improvement and is not implemented; the cost is paid once per start.

---

## 5. Failure modes that are deliberate

**A wrong password fails at the unwrap, not later.** GCM's authentication tag turns it into a clean
`ACCOUNT_PASSWORD_WRONG` rather than 32 bytes of noise that would go on to fail somewhere far away —
a database refusing to open, a session file that will not parse (`vault-key.ts:105`).

**An empty password is refused rather than derived** (`vault-key.ts:57`). It derives a perfectly good
key, which is precisely the problem: it would protect nothing while looking like it did.

**There is no password recovery, and there cannot be one.** A way back would have to keep the key
somewhere a password does not protect. The registration screen says so before the password is
chosen, which is the only honest place to say it.

**The grace period is a deliberate weakening.** Locking keeps the key in memory for `graceMinutes`
(default 30) so closing a tab does not mean reconnecting to Proton a minute later. `0` turns it off.
„Abmelden" in the sidebar does **not** take it — it discards the key immediately; the grace period is
reached by choosing „Sperren" in the settings, where both are named side by side.

---

## 6. Second factors, and when a passkey becomes the key

TOTP is a second factor and nothing else. A passkey is one **by default** and can be promoted to an
unlock method, and the difference is entirely a matter of whether the authenticator supports the
WebAuthn **PRF extension**.

**Without PRF, a passkey cannot possibly be the key**, and that is structural rather than a policy
choice: WebAuthn returns a *signature*, and there is nothing in a signature to unwrap anything with.
A button labelled „Passkey" that then asks for a password reads as a bug unless the screen says why,
so it does.

**With PRF**, the authenticator returns 32 bytes that are deterministic for (credential, salt) and
that nobody can compute without it. That is key material, so it can carry a **second wrapping** of
the master key beside the password's — which is what `vault-key.ts` was shaped for from the start.

```
PRF(credential, prfSalt) ──HKDF-SHA256, info "pms-passkey-kek-v1"──▶ 32 B ──AES-256-GCM──▶ master secret
```

No Argon2id on that path, deliberately: the input is not a password but high-entropy output from a
hardware secret, so stretching it would cost a second and add nothing. What it does need is domain
separation, hence the versioned HKDF info string — the same PRF output must never serve as a key for
anything else. `kekFromPrf` refuses an output shorter than 32 bytes rather than deriving a key with
less entropy than it appears to have.

**One salt per account**, stored in the clear (`prfSalt`, `record.ts`). Not per credential:
`prf.eval.first` is supported far more widely than `evalByCredential`, and one salt suffices because
`PRF(A, salt)` and `PRF(B, salt)` are already unrelated. The salt makes the outputs specific to this
installation, so the same authenticator used elsewhere yields different bytes.

### The two rules that are enforced, not described

- **Enabling requires the vault to already be open.** The master key has to be in hand to be wrapped
  a second time, so only somebody who knows the password can promote a passkey. **A passkey cannot
  enrol itself**, and the assertion is verified before its PRF output is trusted — without that,
  „unlock with a passkey" would mean „unlock with anything that can POST".

  Registering a passkey now performs that release in the same act, which does **not** weaken this
  rule: both places it can happen hold an open vault — the settings, and the registration form,
  which has just created the account and holds the key it minted. What changed is that it no longer
  waits for a second visit to a second screen — the state it used to leave behind was a passkey that
  could not unlock, on a lock screen that offered no passkey button and gave no reason, which is
  what a broken passkey looks like from the outside.

  **An account is never created without a password.** A passkey-only account was considered and
  declined: the password is the way back when the authenticator is not at hand, and it is the secret
  `weigh()`'s second confirmation is checked against before a deletion or a change that moves mail.
  Replacing it would mean replacing that confirmation with a second passkey assertion — defensible,
  but a change to what „a second answer" means, and not one to make as a side effect of a
  convenience.
- **Unlocking requires user verification.** `finishPasskeyLogin` is passed
  `requireUserVerification: true` on that path, and `startPasskeyLogin` asks for `required` rather
  than `preferred`. While the passkey was only a second factor, preferring it was enough; now that it
  stands in for a password, possession of the authenticator alone must not open a mailbox.

Both are covered in `packages/account/test/passkey-unlock.test.ts`, and both counter-checked by
removing them.

### What this costs, stated plainly

It is a **reduction in factors** for the accounts that enable it: from *password* to *authenticator
plus user verification*. That is the point rather than a side effect, and it is a choice made per
passkey rather than for the installation — but it is now the **default** for a newly registered
passkey rather than an opt-in, and the registration form offers one with the box already ticked, so
the trade is made by accepting the offer when the account is created. An authenticator
that cannot do PRF stays a second factor, and the screen reports that as an outcome rather than as
a failure. The password wrapping is never touched, so nothing is lost
by enabling it and nothing is recovered by it either — **losing both the password and every enabled
authenticator is still unrecoverable.**

### What the lock screen tells a stranger

The page is reachable by anybody who can reach the port, so it treats the visitor as one until shown
otherwise: it greets nobody by the account's name unless this browser has completed an unlock before
(`apps/web/src/device.ts`). That flag holds no secret and grants nothing — forging it buys a
friendlier sentence, not a byte of access — which is why it is allowed to be a browser flag rather
than something the server vouches for. Recognition otherwise happens in the authenticator: pressing
„Mit Passkey aufschliessen" either produces a credential this server knows or it does not, and the
screen has asserted nothing either way.

This is the *screen's* discretion, not the API's. With a single account `/api/account` still reports
the username to anyone who asks, as it always has; with more than one it withholds everything
account-shaped until a name has been given (`serve-command.ts`, `view()`).

The PRF output is key material and travels from the browser to the local server, over the same
origin the password already uses. It is sent in a field of its own and stripped from the assertion
before that is sent, so it cannot end up inside an object that is logged or journalled
(`apps/web/src/passkey.ts`).

`@simplewebauthn/browser` 13.3.0 does not know about PRF — there is no mention of it in the package.
It does spread `optionsJSON` into the `navigator.credentials.get()` call untouched, so the salt is
converted to bytes on the client before the call, and the result is read out of the raw
`clientExtensionResults`. That is a dependency detail today and a thing to re-check on upgrade.

### The relying-party id

Derived from the `Origin` header, never from the request body (`account/src/passkey.ts`). A body
field would let a caller choose the scope their own credential is bound to, which is the one thing a
relying party must never delegate. The origin guard (§8) has already checked that header by then.

Consequence worth stating because it will look like a bug: **a passkey is bound to the host name.**
Moving the dashboard from `localhost` to a tailnet name invalidates every passkey registered under
the old one, and they must be registered again — including their unlock wrappings.

## 7. Separation between accounts

An installation may hold several Proton accounts. They are **not** separated by a column in one
database, and that is the whole point: a column is a wall made of correctness, and one wrong `WHERE`
merges two mailboxes.

Each account is a directory with its own `account.json`, `mailbox.db`, `session.enc.json` and
`login-attempts.json`, each encrypted under a key that only that account's password unwraps.
Account B is a directory of noise to anything not given B's password, this server included.

**The process holds exactly one key at a time.** Getting from A to B means dropping A's key, closing
its database and dropping its Proton session, and only then unlocking B. There is no moment at which
both are open, so no route could read across and none had to be written to prevent it.

A process per account would be *stronger* — a bug in this one could in principle open two. That was
weighed and declined; the encryption is the wall, and the difference is real and written down rather
than implied.

The lock screen asks for a name and does **not** list the accounts: enumerating them tells whoever
opened the page which mailboxes live on this machine before they have proven they can open any.
Nothing account-shaped is reported either — not the username, not whether it needs a code, not
whether it has a passkey — until the name is given and the password accepted.

---

## 8. The network boundary

The server binds `127.0.0.1`. It is reached from other devices through a Tailscale sidecar that
terminates TLS on a `*.ts.net` name; nothing is published to the local network by the app itself.

`packages/server/src/origins.ts` refuses every non-`GET` whose `Origin` is missing, is not loopback,
or is not exactly `PMS_PUBLIC_ORIGIN`. `Host` is checked the same way, which closes DNS rebinding by
comparison rather than by argument. Reads pass — a `GET` changes nothing and the two event streams
are `GET`s. Loopback is allowed in general rather than on one exact port, because the dev server
proxies from another port and a rule pinned to one port would look like a broken server.

The guard runs **before** routing, so a route added later cannot forget it by not knowing about it.

---

## 9. The write isolation

Enforced structurally rather than by discipline, and this is the part most worth verifying when
reviewing a change:

- Only `packages/proton-api/src/write/` may issue non-GET requests to Proton.
- `write/messages.ts` has **exactly two** importers, asserted as an exact set in
  `write-isolation.test.ts` rather than as a filter anyone can extend.
- Every function in that file takes `messageIds: string[]` — „only explicit ids" as a signature
  rather than as a promise — and the test checks that too.
- `packages/apply/src/steps.ts` is the only file importing `@pms/proton-api/write`.
- The routing files import neither `@pms/apply` nor the write surface; they meet through a channel
  object handed in from outside.
- There are **seven** non-`GET` HTTP routes, asserted as an exact set in `server.test.ts`.

Stopping and starting the server deliberately did **not** become an eighth route: a container would
need the Docker socket to stop itself, and that socket is root on the host.

---

## 10. Known weaknesses, ranked

1. **The key is in process memory whenever the dashboard is unlocked**, and on a machine nobody is
   sitting at it stays there for `graceMinutes` after locking. `PMS_STOP_WHEN_LOCKED` ends the
   process once it holds nothing, which is the only real mitigation and is off by default.
2. **`browser-profile/` is unencrypted** when enabled, and it contains a live Proton session.
3. **`backups/` is unencrypted** and reveals mail organisation, though no content.
4. **The session file uses scrypt, not Argon2id** — `session-store.ts:25` names this as an interim.
   The parameters are strong (`N=2^17` is ~128 MiB), but it is a second KDF to reason about.
5. **Watchtower pulls and restarts unattended**, so whoever can push to the image registry runs code
   on the machine holding the mailbox. Narrowed by pushing only on a tag and by a repo-scoped token
   behind a protected environment — narrowed, not removed.
6. **Passkeys are bound to the host name**, so a name change silently invalidates them — and with
   them any unlock wrapping they carried.
7. **A passkey enabled for unlocking reduces the factors to one**, namely the authenticator plus its
   user verification. Enabled per passkey, by somebody who already holds the key, and never silently.

---

## 11. When changing any of this

- **Never lower a KDF parameter to make a test faster.** `packages/store/test/encryption.test.ts`
  reads the raw bytes of the file to prove it is encrypted, and it pays two real derivations to do
  it. There is **no** raised timeout on it — it fits inside vitest's default five seconds at about
  1.5 s per derivation, which also means it is the first test to go flaky on a loaded machine. If it
  ever needs room, give it room; do not give the KDF less work.
- **Parameters are stored per account and per database**, so raising them is a migration rather than
  a lockout. Do not read them from a constant at unlock time.
- **`packages/core/test/logger-redaction.test.ts` is the proof that secrets do not reach the log.**
  A new secret-bearing field name belongs in `SECRET_KEYS`, and adding one without it is how a token
  ends up in a file somebody pastes into a bug report.
- **`validate.ts` describes values rather than quoting them** (`string(length 25)`), so a schema
  mismatch cannot put mail content or a token into an error.
- **Run `write-isolation.test.ts` and `server.test.ts` after touching anything that talks to Proton
  or serves HTTP.** They are the two tests that fail when the shape of this changes rather than the
  behaviour.
