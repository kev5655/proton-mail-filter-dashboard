#!/usr/bin/env bash
# Refresh vendor/proton from ProtonMail/WebClients.
#
#   ./scripts/vendor-update.sh [commit-ish]
#
# Copies the upstream files over the vendored ones and leaves the result in the working tree as a
# reviewable diff. Files we own (package.json, README.md, UPSTREAM-README.md) are not touched.
set -euo pipefail

REPO="https://github.com/ProtonMail/WebClients.git"
REF="${1:-main}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching $REPO @ $REF ..."
git clone --quiet --depth 1 --filter=blob:none --sparse --branch "$REF" "$REPO" "$WORK/upstream" 2>/dev/null ||
    git clone --quiet --filter=blob:none --sparse "$REPO" "$WORK/upstream"
git -C "$WORK/upstream" checkout --quiet "$REF" 2>/dev/null || true
git -C "$WORK/upstream" sparse-checkout set --skip-checks packages/sieve packages/utils

COMMIT="$(git -C "$WORK/upstream" rev-parse HEAD)"
echo "Upstream commit: $COMMIT"

rm -rf "$ROOT/vendor/proton/sieve/src" "$ROOT/vendor/proton/sieve/fixtures"
cp -r "$WORK/upstream/packages/sieve/src" "$ROOT/vendor/proton/sieve/src"
cp -r "$WORK/upstream/packages/sieve/fixtures" "$ROOT/vendor/proton/sieve/fixtures"
cp "$WORK/upstream/packages/sieve/README.md" "$ROOT/vendor/proton/sieve/UPSTREAM-README.md"
cp "$WORK/upstream/packages/utils/src/isTruthy.ts" "$ROOT/vendor/proton/utils/isTruthy.ts"

# Any import of a @proton/* package other than the two we vendor means the upstream code grew a new
# dependency. Fail loudly rather than leaving a module that silently fails to resolve at runtime.
UNEXPECTED="$(grep -rhoE "from '@proton/[a-z-]+" "$ROOT/vendor/proton/sieve/src" |
    sed "s/from '//" | sort -u | grep -vE '^@proton/(utils|sieve)$' || true)"
if [ -n "$UNEXPECTED" ]; then
    echo
    echo "ERROR: vendored sieve now imports @proton packages we do not vendor:"
    echo "$UNEXPECTED" | sed 's/^/  - /'
    echo "Vendor them under vendor/proton/ as workspace packages, then re-run."
    exit 1
fi

echo
echo "Done. Next:"
echo "  1. git diff vendor/proton      # review"
echo "  2. pnpm check-types && pnpm test"
echo "  3. update the commit hash ($COMMIT) in vendor/proton/README.md and NOTICE"
