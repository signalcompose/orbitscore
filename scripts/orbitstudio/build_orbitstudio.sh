#!/usr/bin/env bash
# OrbitStudio rebrand wrapper for VSCodium's dev/build.sh
#
# Scope (confirmed / do-not-redesign, see Issue #378 B1):
#   - name-only rebrand: no icon swap (no artwork yet, intentionally deferred)
#   - gallery stays open-vsx.org (VSCodium default, not overridden)
#   - minimal-diff approach: env exports here + product.json override keys
#     in the vscodium repo root. prepare_vscode.sh / utils.sh are NOT edited.
#
# Usage: bash build_orbitstudio.sh [dev/build.sh flags, e.g. none for full rebuild]
#
# 🔴 このスクリプトは **VSCodium のチェックアウトの隣** に置いて実行する。
#    最終行で `<スクリプトのあるディレクトリ>/vscodium` へ cd するため。
#    実際の作業場（2026-08-30 時点）: `~/Src/proj_orbitscore/orbitstudio-build/`
#      orbitstudio-build/
#        ├── build_orbitstudio.sh   ← これのコピー
#        └── vscodium/              ← VSCodium のチェックアウト
#
#    repo に置いてあるのは**正本を失わないため**であり、ここから直接は実行しない
#    （作業場へコピーして使う）。作業場自体は git 管理されていない。

set -euo pipefail

# --- Node: must match vscodium/.nvmrc (22.22.1) exactly; TS is run directly ---
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"

# --- OrbitStudio rebrand identity (confirmed values, do not change) ---
export APP_NAME="OrbitStudio"
export APP_NAME_LC="orbitstudio"          # utils.sh would derive this automatically
                                           # from APP_NAME via tolower(); set explicitly
                                           # for clarity/consistency with BINARY_NAME.
export BINARY_NAME="orbitstudio"
export GLOBAL_DIRNAME="orbitstudio"       # utils.sh default = APP_NAME_LC; explicit for clarity
export TUNNEL_APP_NAME="orbitstudio-tunnel"  # utils.sh default = "${BINARY_NAME}-tunnel"
                                              # NOTE: prepare_vscode.sh hardcodes
                                              # product.tunnelApplicationName = "codium-tunnel"
                                              # regardless of this var (see B1 report) -
                                              # kept here for consistency/patch placeholders
                                              # even though it will not reach the CLI tunnel
                                              # binary name without an additional product.json
                                              # override (out of scope for this rebrand pass).

# ASSETS_REPOSITORY / GH_REPO_PATH / ORG_NAME intentionally NOT overridden:
# gallery/update infra stays VSCodium's (per confirmed scope - no release pipeline change).

cd "$(dirname "${BASH_SOURCE[0]}")/vscodium"
exec ./dev/build.sh "$@"
