#!/usr/bin/env bash
# ローカル安定版の OrbitStudio.app を作る（拡張を内蔵した、単体で動く .app）。
#
# 通常のビルドでは拡張が ~/.orbitstudio/extensions/ にあり、**アプリ単体では動かない**。
# このスクリプトは拡張を Contents/Resources/app/extensions/ へ built-in として
# 埋め込むので、できあがった .app はそれだけで完結する。
#
# 🔴 検証を飛ばさないことが要点。ここで守るのは「静かに壊れる」3つ:
#   1. engine のランタイム依存が npm の hoist で vsix から抜ける（#654 の `yaml`）
#      → ビルド緑・パッケージ成功・インストール成功のまま、初回評価で落ちる
#   2. 拡張の埋め込みを忘れる → 起動はするので気づきにくい
#   3. 埋め込んだのに認識されない → 空の extensions-dir で起動して確かめる
#
# Usage:
#   bash scripts/orbitstudio/make-local-release.sh [退避先]
#
#   退避先の既定: ~/Src/proj_orbitscore/orbitstudio-local-builds

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ARCHIVE_ROOT="${1:-$HOME/Src/proj_orbitscore/orbitstudio-local-builds}"
APP_SRC="${ORBITSTUDIO_APP:-$HOME/Src/proj_orbitscore/orbitstudio-build/vscodium/VSCode-darwin-arm64/OrbitStudio.app}"
VERIFY_PORT="${VERIFY_PORT:-39129}"   # 検証専用。日常使いの 39123 とぶつけない

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$APP_SRC" ] || die "OrbitStudio.app が見つからない: $APP_SRC
       ビルドしていない場合は scripts/orbitstudio/README.md を参照。"

cd "$REPO_ROOT"
COMMIT="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
DIRTY=""
git diff --quiet || DIRTY=" (working tree dirty)"
EXT_VERSION="$(node -e "console.log(require('./packages/vscode-extension/package.json').version)")"

say "1/6  ビルド"
npm run build

say "2/6  vsix を作る（ワークスペース外のステージで本番依存を入れる）"
# 🔴 ワークスペース内で npm install すると、root に既にある依存が hoist されて
#    vsix に入らない。上にワークスペース root が無い場所で入れる。
STAGE="$(mktemp -d)"
VSIX="$(mktemp -d)/orbitscore-${EXT_VERSION}.vsix"
trap 'rm -rf "$STAGE"' EXIT
rsync -a --exclude '/node_modules' "$REPO_ROOT/packages/vscode-extension/" "$STAGE/"
( cd "$STAGE" && npm install --omit=dev --ignore-scripts --no-package-lock >/dev/null )
( cd "$STAGE" && "$REPO_ROOT/node_modules/.bin/vsce" package \
    --allow-missing-repository --skip-license -o "$VSIX" >/dev/null )
echo "  $(du -h "$VSIX" | cut -f1)  $VSIX"

say "3/6  vsix の中身を検証（ここを飛ばすと壊れた配布物ができる）"
CHECK="$(mktemp -d)"
unzip -q "$VSIX" -d "$CHECK"
MISSING=""
for DEP in $(node -e 'console.log(Object.keys(require("./packages/engine/package.json").dependencies).join(" "))'); do
  [ -d "$CHECK/extension/engine/node_modules/$DEP" ] || MISSING="$MISSING engine/$DEP"
done
for DEP in $(node -e 'console.log(Object.keys(require("./packages/vscode-extension/package.json").dependencies||{}).join(" "))'); do
  [ -d "$CHECK/extension/node_modules/$DEP" ] || MISSING="$MISSING ext/$DEP"
done
for BIN in orbit-audio-daemon orbit-effect-rack-child orbit-plugin-scan; do
  [ -f "$CHECK/extension/engine/bin/darwin-arm64/$BIN" ] || MISSING="$MISSING bin/$BIN"
done
# 🔴 `.clap` は**ファイルではなくバンドル（ディレクトリ）**。`-f` で見ると必ず落ちる。
# release.yml と同じく、バンドルの存在と中の実行ファイルを 2 段階で確かめる。
for STD in Gain; do
  STD_BUNDLE="$CHECK/extension/engine/bin/darwin-arm64/std-plugins/$STD.clap"
  [ -d "$STD_BUNDLE" ] || MISSING="$MISSING std-plugins/$STD.clap"
  [ -f "$STD_BUNDLE/Contents/MacOS/$STD" ] || MISSING="$MISSING std-plugins/$STD.clap/Contents/MacOS/$STD"
done
if [ -n "$MISSING" ]; then
  rm -rf "$CHECK"
  die "vsix から抜けているものがある:$MISSING
       これは **ビルド緑・パッケージ成功のまま** 実行時に落ちる種類の欠落（#654）。"
fi
echo "  依存・バイナリともそろっている"
rm -rf "$CHECK"

say "4/6  アプリを複製し、拡張を built-in として埋め込む"
STAMP="$(date +%Y%m%d-%H%M)"
DEST="$ARCHIVE_ROOT/$STAMP-$SHORT-app"
mkdir -p "$DEST"
ditto "$APP_SRC" "$DEST/OrbitStudio.app"
cp "$VSIX" "$DEST/orbitscore-${EXT_VERSION}.vsix"

# vsix を展開して埋め込む（インストール済みの拡張に依存しない = 手元の状態に左右されない）
EMBED="$(mktemp -d)"
unzip -q "$VSIX" -d "$EMBED"
BUILTIN="$DEST/OrbitStudio.app/Contents/Resources/app/extensions/orbitscore"
rm -rf "$BUILTIN"
ditto "$EMBED/extension" "$BUILTIN"
rm -rf "$EMBED"
[ -f "$BUILTIN/package.json" ] || die "拡張の埋め込みに失敗した"
echo "  built-in 拡張: $(ls "$DEST/OrbitStudio.app/Contents/Resources/app/extensions" | wc -l | tr -d ' ') 個"
echo "  $(du -sh "$DEST/OrbitStudio.app" | cut -f1)  $DEST/OrbitStudio.app"

say "5/6  内蔵拡張だけで起動するか検証（extensions-dir を空にする）"
# ~/.orbitstudio を一切見ない状態で MCP が上がれば、アプリ単体で完結している。
VUD="$(mktemp -d)"; VXD="$(mktemp -d)"
ORBITSCORE_MCP_PORT="$VERIFY_PORT" nohup \
  "$DEST/OrbitStudio.app/Contents/Resources/app/bin/orbs" --new-window \
  "--user-data-dir=$VUD" "--extensions-dir=$VXD" >/dev/null 2>&1 &
VERIFY_PID=$!
UP=0
for _ in $(seq 1 90); do
  if nc -z 127.0.0.1 "$VERIFY_PORT" 2>/dev/null; then UP=1; break; fi
  sleep 1
done
kill "$VERIFY_PID" 2>/dev/null || true
sleep 2
pkill -f "user-data-dir=$VUD" 2>/dev/null || true
rm -rf "$VUD" "$VXD"
[ "$UP" = 1 ] || die "内蔵拡張だけでは起動しなかった（MCP が :$VERIFY_PORT に上がらない）。
       埋め込み先のパスか拡張の中身を疑う。"
echo "  MCP が応答 — アプリ単体で完結している"

say "6/6  MANIFEST を書いて latest を張り替える"
cat > "$DEST/MANIFEST.md" <<EOF
# OrbitStudio — ローカル安定版（拡張を内蔵した .app）

| | |
|---|---|
| 作成 | $(date '+%Y-%m-%d %H:%M:%S') |
| main の commit | \`$COMMIT\`$DIRTY |
| 直近のコミット | $(git log --oneline -1) |
| 拡張バージョン | $EXT_VERSION |
| サイズ | $(du -sh "$DEST/OrbitStudio.app" | cut -f1) |

## 🔴 これは「拡張を内蔵した」アプリ

通常のビルドでは拡張が \`~/.orbitstudio/extensions/\` にあり、**アプリ単体では動かない**。
このコピーは拡張を \`Contents/Resources/app/extensions/orbitscore/\` へ埋め込んであるので、
**アプリだけで完結する**（配布形態としてはこれが必要）。

## 自動で確認したこと

- vsix に engine / 拡張のランタイム依存と同梱バイナリがすべて入っている
- **extensions-dir を空にして起動し、内蔵拡張だけで MCP が応答した**

## 使い方

\`\`\`bash
open "$DEST/OrbitStudio.app"

# MCP を使う場合
ORBITSCORE_MCP_PORT=39123 \\
  "$DEST/OrbitStudio.app/Contents/Resources/app/bin/orbs" --new-window <曲のフォルダ>
\`\`\`

🔴 **未署名。** 他マシンへ配ると quarantine で開けない（#656）。
このマシンで動かすぶんには問題ない。

## 作り直し

\`\`\`bash
bash scripts/orbitstudio/make-local-release.sh
\`\`\`
EOF
ln -sfn "$DEST" "$ARCHIVE_ROOT/latest"

say "完了"
echo "  $DEST"
echo "  latest → $(readlink "$ARCHIVE_ROOT/latest")"
echo
echo "  🔴 未署名なので他マシンでは開けない（#656）。"
