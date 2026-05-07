# `@orbitscore/sc-link-audio`

OrbitScore 用 SuperCollider plugin (`OrbitLinkAudio.scx`)。 scsynth プロセス内で Ableton Link Audio (`<ableton/LinkAudio.hpp>`) に直接 commit する `OrbitLinkAudioOut` UGen を提供する。

> **本パッケージは現状 skeleton（Step 2.1 deliverable）。 実装は Step 2.2 以降で着手する。**

## 目的

- DSL `seq.output("channel-name")` で指定された sequence の出力を、 仮想ループバックデバイス無しで Live トラックに直結する
- macOS arm64 only (v1.x release target)
- 加算合成 (sum-by-name) は plugin 内で実装、 同名 channel への複数 commit を 1 channel に集約

## ディレクトリ構造

```
packages/sc-link-audio/
├── README.md                    # 本ファイル
├── CMakeLists.txt               # SC Plugin SDK + LinkAudio.hpp との結線
├── .gitignore                   # build/ 成果物
├── src/
│   ├── orbit_link_audio_out.cpp # OrbitLinkAudioOut UGen 本体
│   ├── link_audio_facade.hpp    # alpha API 変更を吸収する 1 ファイル wrapper
│   ├── channel_registry.hpp     # channelId → LinkAudioSink* lookup
│   └── channel_registry.cpp
└── external_libraries/          # submodule mount point (現状 placeholder)
    ├── supercollider-sdk/       # github.com/supercollider/supercollider plugin_interface (Step 2.2 で submodule add)
    └── link/                    # github.com/Ableton/link 全体 (LinkAudio.hpp を含む、 Step 2.2 で submodule add)
```

## ライセンス

`OrbitLinkAudio.scx` は **GPL-2.0-or-later** で配布される独立 artifact。 OrbitScore 本体 (`LicenseRef-Signal-compose-FairTrade-1.0`) とは mere aggregation で同梱され、 GPL の影響を本体側に及ぼさない。 詳細は [`docs/research/LINK_AUDIO_API.md`](../../docs/research/LINK_AUDIO_API.md) §0.4 / §3。

商用配布フェーズに移行する場合は Ableton (`link-devs@ableton.com`) への proprietary license 申請を判断する。

## ビルド前提 (Step 2.2 以降で完成)

```bash
# 1. submodule の初期化 (Step 2.2 で正式追加予定)
cd external_libraries
git submodule add https://github.com/supercollider/supercollider.git supercollider-sdk
git submodule add https://github.com/Ableton/link.git link
cd ..

# 2. macOS arm64 (Apple Silicon) only
mkdir build && cd build
cmake .. \
  -DSC_PATH=../external_libraries/supercollider-sdk \
  -DLINK_AUDIO_PATH=../external_libraries/link
make

# 3. .scx を SC extensions ディレクトリへ install
cp OrbitLinkAudio.scx ~/Library/Application\ Support/SuperCollider/Extensions/
```

`.vsix` bundle に同梱される配布版はリリースパイプライン (Step 4) が `scripts/extract-scsynth-bundle.sh` 経由で `Resources/plugins/OrbitLinkAudio.scx` を組み込む。

## 関連 Issue / PR

- Epic: signalcompose/orbitscore#187
- Step 1 research: signalcompose/orbitscore#188 / `docs/research/LINK_AUDIO_API.md`
- Step 3 (TS 側 contract): signalcompose/orbitscore#190 + #192 (consolidated PR)
- 本 sub-step (Step 2.1 skeleton): signalcompose/orbitscore#194
- Step 2.2 (UGen 実装): TBD
- Step 4 (build pipeline 統合): TBD

## ステータス

| Sub-step | 内容 | 状態 |
|---|---|---|
| 2.1 | skeleton (本パッケージ作成) | ✅ in this PR |
| 2.2 | `OrbitLinkAudioOut` UGen の単一 channel commit 実装 | ⏳ TBD |
| 2.3 | channelId → sink 動的 add/remove (sum-by-name) | ⏳ TBD |
| 2.4 | 同名 sum 動作の検収 | ⏳ TBD |
| 2.5 | tempo / phase / transport sync (LinkAudio 内蔵 Link) | ⏳ TBD |
