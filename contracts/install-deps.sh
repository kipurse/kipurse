#!/usr/bin/env bash
# Fetch the pinned Solidity dependencies into contracts/lib (and the SpendPermissionManager sources into contracts/spm).
# Pins are the exact commits the tests were run with. Needs git + network; nothing else.
set -euo pipefail
cd "$(dirname "$0")"
dep(){ local dir=$1 url=$2 rev=$3; if [ -d "lib/$dir/.git" ] || [ -f "lib/$dir/.pinned" ]; then return; fi
  rm -rf "lib/$dir"; git init -q "lib/$dir"; git -C "lib/$dir" fetch -q --depth 1 "$url" "$rev"; git -C "lib/$dir" checkout -q FETCH_HEAD
  git -C "lib/$dir" submodule update -q --init --recursive --depth 1 2>/dev/null || true; echo "$rev" > "lib/$dir/.pinned"; }
mkdir -p lib
dep forge-std               https://github.com/foundry-rs/forge-std               58d30519826c313ce47345abedfdc07679e944d1
dep openzeppelin-contracts  https://github.com/OpenZeppelin/openzeppelin-contracts 1edc2ae004974ebf053f4eba26b45469937b9381
dep solady                  https://github.com/Vectorized/solady                  d87a6baaea980b54f6d0f2d3a3c30c45a5b1520a
dep account-abstraction     https://github.com/eth-infinitism/account-abstraction fa61290d37d079e928d92d53a122efcc63822214
dep webauthn-sol            https://github.com/base-org/webauthn-sol              619f20ab0f074fef41066ee4ab24849a913263b2
dep smart-wallet            https://github.com/coinbase/smart-wallet              1bc2d0aa3b7dc6f73bf2029c848cfb88c1104901
dep magicspend              https://github.com/coinbase/magicspend                4ce54f16c53c8031d2168a1b7c3e83648a323019
dep spend-permissions       https://github.com/coinbase/spend-permissions         e0004e63edc4e17de7aa978293800ac7a16892e5
# SPM sources come from coinbase/spend-permissions at the pin above
# oz4shim: two-file OpenZeppelin 4.x shim used by account-abstraction v0.6, shipped in shim/oz4 (see remappings.txt)
[ -e spm ] || ln -s lib/spend-permissions/src spm
echo "deps ready"
