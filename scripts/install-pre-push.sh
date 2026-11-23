#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Installs a git pre-push hook that runs the same guards as CI (scripts/guard.mjs + gitleaks) and refuses the push on any hit.
#   sh scripts/install-pre-push.sh
# Operators can also point KIPURSE_PRIVATE_DENYLIST at their own plain denylist (kept OUTSIDE the repository) to check it locally.
set -eu
ROOT=$(git rev-parse --show-toplevel); HOOK="$ROOT/.git/hooks/pre-push"
cat > "$HOOK" <<'HOOK'
#!/bin/sh
# installed by scripts/install-pre-push.sh
set -eu
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
node scripts/guard.mjs || { echo "pre-push: repository guard failed; push refused"; exit 1; }
if command -v gitleaks >/dev/null 2>&1; then
  gitleaks detect --no-git --source . -c .gitleaks.toml --redact --no-banner || { echo "pre-push: gitleaks found a possible secret; push refused"; exit 1; }
else
  echo "pre-push: gitleaks not installed; CI will still run it (https://github.com/gitleaks/gitleaks)"
fi
HOOK
chmod +x "$HOOK"; echo "installed $HOOK"
