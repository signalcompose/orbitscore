#!/usr/bin/env bash
#
# copy-user-site.sh
#
# Bundles the end-user learning site (sites/user — DSL usage docs for
# beginners) into the VS Code extension's own sites/user/ directory so a
# packaged .vsix ships it (#954). Before this, `resolveUserDocsRoot` always
# pointed at the monorepo checkout (`__dirname/../../..`), which does not
# exist inside an installed extension — the Docs panel and get_user_doc /
# search_user_docs were dead on a cold install.
#
# Mirrors copy-daemon-bin.sh's shape: build first, then copy into the
# extension package, right before `vsce package` (npm run build:copy-user-site,
# wired into pretest:e2e:cold-install and the release workflow).
#
# Two things are copied, both required:
#   - Markdown source (*.md, excluding .vitepress/) — what get_user_doc /
#     search_user_docs read. This mirrors resolveDevDocsLocation's dev-site
#     Markdown reading, which never requires a dist build.
#   - The built VitePress dist (sites/user/.vitepress/dist/) — what the Docs
#     panel WebView serves over HTTP. It's .gitignore'd (`sites/*/.vitepress/dist/`)
#     so it must be built (`npm run docs:build:user`) before this script runs;
#     the caller (build:copy-user-site) does that first.
#
# Unlike copy-daemon-bin.sh this is NOT best-effort: a missing dist means the
# .vsix would ship with the same silent breakage this script exists to fix,
# so it fails loud instead of bundling a partial/stale site.
#
# Usage:
#   npm run docs:build:user && bash scripts/copy-user-site.sh
#   (or just: npm run build:copy-user-site)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

SRC="$PROJECT_ROOT/sites/user"
DEST="$PROJECT_ROOT/packages/vscode-extension/sites/user"
DIST_SRC="$SRC/.vitepress/dist"

if [ ! -d "$DIST_SRC" ]; then
  echo "ERROR: $DIST_SRC missing -- run 'npm run docs:build:user' before this script." >&2
  exit 1
fi

# Rebuilt from scratch every time: stale leftovers (a since-deleted Markdown
# file, an old dist) must not survive into the packaged .vsix.
rm -rf "$DEST"
mkdir -p "$DEST"

# Markdown source, preserving directory structure, excluding .vitepress/
# (config/cache -- not documents; readDevDoc's own walk skips it too).
while IFS= read -r -d '' md; do
  rel="${md#"$SRC"/}"
  mkdir -p "$DEST/$(dirname "$rel")"
  cp "$md" "$DEST/$rel"
done < <(find "$SRC" -name '*.md' -not -path '*/.vitepress/*' -print0)

md_count=$(find "$DEST" -name '*.md' | wc -l | tr -d ' ')
echo "Bundled $md_count Markdown file(s) -> $DEST"

# Built dist, wholesale.
mkdir -p "$DEST/.vitepress"
rm -rf "$DEST/.vitepress/dist"
cp -R "$DIST_SRC" "$DEST/.vitepress/dist"
echo "Bundled built dist -> $DEST/.vitepress/dist"
