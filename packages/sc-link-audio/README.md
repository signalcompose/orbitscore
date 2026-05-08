# `@orbitscore/sc-link-audio`

OrbitScore 用 SuperCollider plugin (`OrbitLinkAudio.scx`)。 scsynth プロセス内で Ableton Link Audio (`<ableton/LinkAudio.hpp>`) に直接 commit する `OrbitLinkAudioOut` UGen を提供する。

> **Step 2.2 実装完了 — `OrbitLinkAudioOut` UGen + `/cmd /orbit/registerLinkAudioChannel` ハンドラ + LinkAudio singleton ライフサイクルが揃った状態。 sum-by-name (Step 2.3) と TS dispatch / boot pipeline 統合 (Step 4) は別 PR。**

## 目的

- DSL `seq.output("channel-name")` で指定された sequence の出力を、 仮想ループバックデバイス無しで Live トラックに直結する
- macOS arm64 only (v1.x release target)
- 加算合成 (sum-by-name) は plugin 内で実装、 同名 channel への複数 commit を 1 channel に集約

## ディレクトリ構造

```
packages/sc-link-audio/
├── README.md                    # 本ファイル
├── CMakeLists.txt               # SC Plugin SDK + LinkAudio.hpp との結線 + 自動 ad-hoc codesign
├── .gitignore                   # build/ 成果物
├── src/
│   ├── orbit_link_audio_out.cpp # OrbitLinkAudioOut UGen + /cmd registerChannel ハンドラ + PluginLoad/Unload
│   ├── link_audio_facade.hpp    # alpha API 変更を吸収する 1 ファイル wrapper
│   ├── channel_registry.hpp     # channelId → LinkAudioSink* lookup + LinkAudio singleton ownership
│   └── channel_registry.cpp
├── sc-classes/
│   └── OrbitLinkAudio.sc        # sclang クラス stub (SynthDef ビルダー用)
└── external_libraries/          # submodule mount point
    ├── supercollider-sdk/       # github.com/supercollider/supercollider tag Version-3.14.0 に pin
    └── link/                    # github.com/Ableton/link master (LinkAudio.hpp を含む)
```

## ライセンス

`OrbitLinkAudio.scx` は **GPL-2.0-or-later** で配布される独立 artifact。 OrbitScore 本体 (`LicenseRef-Signal-compose-FairTrade-1.0`) とは mere aggregation で同梱され、 GPL の影響を本体側に及ぼさない。 詳細は [`docs/research/LINK_AUDIO_API.md`](../../docs/research/LINK_AUDIO_API.md) §0.4 / §3。

商用配布フェーズに移行する場合は Ableton (`link-devs@ableton.com`) への proprietary license 申請を判断する。

## ビルド (macOS arm64)

```bash
# 1. submodule 初期化 (clone 直後の clean state に対する初回のみ)
git submodule update --init --recursive packages/sc-link-audio

# 2. CMake configure + build
#    macOS arm64 (Apple Silicon) only。 absolute path で SC_PATH と
#    LINK_AUDIO_PATH を渡すこと (CMake の relative-path 評価は build dir
#    起点になるためトラブルになりやすい)。
cd packages/sc-link-audio
mkdir -p build && cd build
cmake .. \
  -DSC_PATH=$(pwd)/../external_libraries/supercollider-sdk \
  -DLINK_AUDIO_PATH=$(pwd)/../external_libraries/link
make

# 3. SC Extensions に install (.scx + sclang クラス stub の両方)
EXT_DIR="$HOME/Library/Application Support/SuperCollider/Extensions"
mkdir -p "$EXT_DIR"
cp OrbitLinkAudio.scx "$EXT_DIR/"
cp ../sc-classes/OrbitLinkAudio.sc "$EXT_DIR/"
```

CMake が build 完了後に自動で ad-hoc codesign を実施する (詳細は `CMakeLists.txt` 末尾の note 参照)。 macOS は signed parent process (SuperCollider.app `scsynth` は Ableton ではなく SuperCollider team で署名済) からの unsigned bundle dlopen を `signal: SIGKILL (Code Signature Invalid)` で殺すため、 ad-hoc 署名 (`codesign --force --sign -`) が必須。

`.vsix` bundle に同梱される配布版はリリースパイプライン (Step 4) が `scripts/extract-scsynth-bundle.sh` 経由で `Resources/plugins/OrbitLinkAudio.scx` を組み込み、 同時に Developer ID で再署名する想定。

## 動作確認 (sclang)

build + install 後、 sclang スクリプトで plugin が SC スタックの全レイヤーで機能していることを確認できる:

```bash
/Applications/SuperCollider.app/Contents/MacOS/sclang \
  packages/sc-link-audio/scripts/verify-plugin.scd
```

期待出力 (抜粋):
```
=== OrbitLinkAudio plugin verification ===
  [OK] OrbitLinkAudioOut class loaded
  [OK] scsynth booted with plugin loaded (no crash on dlopen)
  [OK] /cmd /orbit/registerLinkAudioChannel sent
  [OK] SynthDef instantiated — UGen Ctor + next() are running
  [OK] held for 2 s — no crash, no errors above => plugin is functional
=== verification complete ===
```

Live 12.4+ 受信を含む完全な E2E (`docs/LINK_AUDIO_E2E_CHECKLIST.md` §B-G) は Step 4 (boot pipeline + TS dispatch wiring) 完了後に実施可能。

## 関連 Issue / PR

- Epic: signalcompose/orbitscore#187
- Step 1 research: signalcompose/orbitscore#188 / `docs/research/LINK_AUDIO_API.md`
- Step 3 (TS 側 contract): signalcompose/orbitscore#190 + #192 (consolidated PR)
- Step 2.1 skeleton: signalcompose/orbitscore#194
- 本 sub-step (Step 2.2 UGen 実装): signalcompose/orbitscore#198
- Step 4 (build pipeline 統合): TBD

## ステータス

| Sub-step | 内容 | 状態 |
|---|---|---|
| 2.1 | skeleton (本パッケージ作成) | ✅ |
| 2.2 | `OrbitLinkAudioOut` UGen の単一 channel commit 実装 | ✅ in this PR |
| 2.3 | channelId → sink 動的 add/remove (sum-by-name) | ⏳ TBD |
| 2.4 | 同名 sum 動作の検収 | ⏳ TBD |
| 2.5 | tempo / phase / transport sync (LinkAudio 内蔵 Link) | ⏳ TBD (実装は本 PR で完了、 検収は Step 4 と統合 E2E で) |
