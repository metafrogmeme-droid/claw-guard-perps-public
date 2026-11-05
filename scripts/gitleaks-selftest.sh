#!/usr/bin/env bash
# gitleaks self-test: plant fake secrets in a temp dir and require .gitleaks.toml to catch each one,
# and require clean files to pass. Fake values are generated at run time, so none live in the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="$ROOT/.gitleaks.toml"
GITLEAKS="${GITLEAKS:-gitleaks}"
command -v "$GITLEAKS" >/dev/null || { echo "gitleaks-selftest: gitleaks not found (set GITLEAKS=...)" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

hex64() { od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; }

fail=0
expect() { # expect <want-exit> <name> <content>
  local want="$1" name="$2" content="$3" got=0
  mkdir -p "$WORK/$name"
  printf '%s\n' "$content" >"$WORK/$name/file.txt"
  "$GITLEAKS" dir --no-banner --log-level error --redact --config "$CONFIG" "$WORK/$name" >/dev/null 2>&1 || got=$?
  if [[ "$got" == "$want" ]]; then
    echo "ok   $name (exit $got)"
  else
    echo "FAIL $name: want exit $want, got $got" >&2
    fail=1
  fi
}

expect 1 evm-key-env       "PRIVATE_KEY=0x$(hex64)"
expect 1 gate-key-env      "GATE_SIGNER_PRIVATE_KEY=$(hex64)"
expect 1 evm-key-json      "{\"botKey\": \"0x$(hex64)\"}"
expect 1 evm-key-in-code   "const a = privateKeyToAccount('0x$(hex64)');"
expect 0 clean-example     "$(cat "$ROOT/.env.example")"
expect 0 tx-hash-in-docs   "| place order | 0x$(hex64) |"
expect 0 receipt-hash      "receiptHash: 0x$(hex64)"

if [[ "$fail" != 0 ]]; then echo "gitleaks-selftest: FAILED" >&2; exit 1; fi
echo "gitleaks-selftest: all cases passed"
