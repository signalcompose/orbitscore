# OrbitStudio（アプリ本体）のビルド

`build_orbitstudio.sh` は VSCodium の `dev/build.sh` を OrbitStudio 名でリブランドして
呼び出すラッパー。**このファイルは正本を失わないために repo へ置いてあり、
ここから直接は実行しない。**

## 使い方

VSCodium のチェックアウトの隣にコピーして実行する。

```
<作業場>/
  ├── build_orbitstudio.sh   ← このファイルのコピー
  └── vscodium/              ← VSCodium のチェックアウト
```

```bash
bash build_orbitstudio.sh          # フルビルド
```

実際の作業場（2026-08-30 時点）: `~/Src/proj_orbitscore/orbitstudio-build/`
🔴 **作業場そのものは git 管理されていない。**

## スコープ

- 名前だけのリブランド（**アイコンは未着手**）
- gallery は open-vsx.org のまま（VSCodium の既定）
- `prepare_vscode.sh` / `utils.sh` は編集しない（env と product.json の上書きだけ）

## 🔴 拡張は同梱されない

ビルドしたアプリに OrbitScore 拡張は入らない。別途インストールが必要。

```bash
# 拡張を焼き込む（ワークスペース外にステージを作るのは npm の hoist 対策）
rsync -a --exclude '/node_modules' packages/vscode-extension/ /tmp/ext-stage/
cd /tmp/ext-stage && npm install --omit=dev --ignore-scripts --no-package-lock
npx vsce package -o /tmp/orbitscore.vsix
<app>/Contents/Resources/app/bin/orbs --install-extension /tmp/orbitscore.vsix --force
```

🔴 **焼く前に vsix の中身を `grep` で検証する。** ビルド緑・パッケージ成功・
インストール成功のまま、エンジンの初回評価で落ちる欠落が起きる（#654 で `yaml` が抜けた）。

## リリース

**アプリのリリース経路はまだ無い。** 署名・公証・配布物の形・CI を含めて **#656** で追跡。
未署名の `.app` は quarantine で開けないため、署名は配布の前提条件。
