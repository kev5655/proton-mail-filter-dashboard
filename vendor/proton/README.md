# vendor/proton

Code copied from [ProtonMail/WebClients](https://github.com/ProtonMail/WebClients), GPL-3.0.

**Pinned upstream commit:** `67e20e4f558c6a990444759bc6ebd10f47cab445`

## Why this exists

Proton has no public API. Two pieces of their open-source web client do work we must not
reimplement, because getting them subtly wrong would corrupt real mail filters:

- **`sieve/`** — converts between Proton's structured filter model (`SimpleObject`) and the Sieve
  AST (`Tree`) that `POST mail/v4/filters` actually stores. Copied from `packages/sieve`, together
  with its **fixtures**, which are the strongest correctness signal available to us: our compiler is
  tested against Proton's own expected outputs.
- **`utils/`** — only `isTruthy`, the single helper `sieve/` imports.

`@proton/sieve` is not published to npm, so it has to be vendored. `@protontech/crypto` (SRP) *is*
on npm and is a normal dependency instead.

## Rules

**Never edit `sieve/src`, `sieve/fixtures`, or `utils/isTruthy.ts`.** They are byte-identical to
upstream so that refreshing produces a clean, reviewable diff. The only files we own here are the
`package.json`s, this README, and `sieve/UPSTREAM-README.md`.

Both directories are workspace packages published under their upstream names (`@proton/sieve`,
`@proton/utils`), so the vendored sources resolve their own imports without any path aliases or
bundler configuration.

## Refreshing

```sh
pnpm vendor:update            # fetches the latest upstream and shows the diff
pnpm vendor:update <commit>   # pin a specific commit
```

The script copies the files, then leaves the diff in your working tree. Review it, run
`pnpm check-types` and `pnpm test`, and update the commit hash in this file and in `NOTICE`.

A type change upstream should surface as a **compile error** in our code — that is the intended
early-warning system, not a nuisance. See `packages/core/src/errors.ts` for the runtime counterpart.
