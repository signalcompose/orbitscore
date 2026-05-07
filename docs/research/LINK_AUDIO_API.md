# Research: Ableton Link Audio API 調査結果（Issue #188 / Epic #187）

**調査日**: 2026-05-07
**ブランチ**: `188-link-audio-research`
**関連 Issue**: [#188](https://github.com/signalcompose/orbitscore/issues/188) (Step 1) / [#187](https://github.com/signalcompose/orbitscore/issues/187) (Epic)

## 調査目的

Ableton Live 12.4 (2026-05-05 公開) で導入された **Link Audio** を OrbitScore に統合するため、 SDK の API surface・サンプルレート挙動・ライセンス条件を一次情報で確定する。 後続の Step 2 (SC plugin 実装) / Step 3 (DSL 構文) / Step 4 (ビルドパイプライン) が安心して着手できる解像度を確保する。

## 一次情報のソース

- Ableton/link 公式リポジトリ: https://github.com/Ableton/link
- LinkAudio.hpp 直接取得: https://raw.githubusercontent.com/Ableton/link/master/include/ableton/LinkAudio.hpp
- 参考実装: gluon/Void-LinkAudio (https://github.com/gluon/Void-LinkAudio) — Max/PD/TouchDesigner/VCV/oF 用 host adapter、 GPL-2.0-or-later
- LinkAudioHut example: https://github.com/Ableton/link/tree/master/examples/linkaudiohut

## 0. 確定した設計決定 (post-research review)

調査結果を元にユーザーと判断した設計上の決定事項。 詳細な根拠は以下のセクションを参照。

### 0.1 出力モード — Global で明示宣言、 ファイル単位で hardware と排他

```
init global.linkAudio()           # 有効化、 target SR 自動検出 (fallback 48000)
init global.linkAudio(48000)      # 明示 target SR で有効化（auto-detect 不可時の override）
```

- once-per-file diagnostic の対象に追加（既存の `global.tempo()` 等と同様）
- 宣言中は **全 sequence が LinkAudio 経由**、 hardware 出力との混在不可
- 宣言なし → 既存通り hardware 出力のみ（既存挙動を保持）

### 0.2 Per-sequence channel 指定

```
seq.output("kick-channel")        # channel name のみ (kind は Global mode から implicit)
```

- `init global.linkAudio()` 未宣言で `seq.output()` を使った場合は VS Code diagnostic で warning（Step 3 で実装）
- channel name 制約: ASCII 英数 + `-_`、 max 64 chars（API 仕様未明、 安全側、 Step 2 で再確認）

### 0.3 Sample rate 戦略

- scsynth は **hardware SR**（boot option で強制しない）
- plugin が target SR へ resample してから commit
- target SR の決定優先順: **auto-detect → DSL override → 48k fallback**
- auto-detect 戦略は LinkAudio peer info / OS query を試みる（実装可能性は Step 2.1 で検証）

### 0.4 License 分離 (mere aggregation)

- `.scx` plugin を独立 **GPL-2.0-or-later artifact** として分離配布
- `.vsix` bundle に同梱する場合は LICENSE.GPL-2.0 + NOTICE で aggregation 明記
- OrbitScore 本体 (`LicenseRef-Signal-compose-FairTrade-1.0`) は GPL の影響を受けない
- 商用配布フェーズ移行時に Ableton への proprietary license 申請判断（現状 research / personal use フェーズで OK）

### 0.5 Channel 同時公開上限

**API / LinkAudio 仕様レベル**: self-imposed 制限なし。 LinkAudio ライブラリ仕様に任せる。

**OrbitScore 推奨上限** (§4.1 参照): 同時シーケンス数の現実的な目安として 16 を推奨。 これは API による hard limit ではなく、 一般的な live coding セッションでの可読性 / 演奏性を考慮した soft guideline。

### 0.6 Plugin ライフサイクル

- `init global.linkAudio()` 宣言時に plugin load + `enableLinkAudio(true)`
- scsynth shutdown 時に自動 disable / unload
- ランタイム切替（演奏中に LinkAudio mode を on/off）は v1.2.0 では非対応（次版で検討）

## 1. API surface

### 1.1 クラス階層

```
BasicLink<Clock>  (既存、 tempo/beat/phase/transport 同期を担当)
  └─ BasicLinkAudio<Clock>  (Link を継承し audio 機能を追加)
       └─ LinkAudio = BasicLinkAudio<link::platform::Clock>
```

**重要**: `LinkAudio` は `Link` を継承しているため、 既存 Link の tempo / beat / phase / start-stop API がそのまま利用できる。 **Link Audio が「Link の上位互換」と説明される根拠はこの継承関係**。 ユーザープロンプトの「Link と LinkAudio の同時使用は不可、 LinkAudio に統一する」 は正しい（同 peer name で 2 つの Link オブジェクトを作ると衝突する）。

### 1.2 LinkAudio クラスの主要メソッド

```cpp
LinkAudio(double bpm, std::string name);              // コンストラクタ

bool isLinkAudioEnabled() const;                      // 状態取得
void enableLinkAudio(bool bEnable);                   // ランタイム有効/無効切替

std::string peerName() const;
void setPeerName(std::string name);

template <typename Callback>
void setChannelsChangedCallback(Callback callback);   // callback シグネチャ: void()
                                                      // 引数なし、 内部で channels() を呼んで取得

std::vector<Channel> channels() const;                // 現在の Sink 一覧

template <typename Function>
void callOnLinkThread(Function func);                 // Link 内部スレッドへタスク dispatch
```

### 1.3 Channel struct

```cpp
struct Channel {
  ChannelId id;          // 内部 ID (peer 内一意)
  std::string name;      // 公開名 (利用者 visible)
  PeerId peerId;         // 発信元 peer ID
  std::string peerName;  // 発信元 peer 名
};
```

**永続性**: ChannelId と PeerId は再起動を跨いで永続的（リファレンス記述は LinkAudio.hpp ではなく Live 12.4 release notes 由来、 同一 peer 内で名前を変えても ID は不変）。

### 1.4 LinkAudioSink (publish 側)

```cpp
template <typename LinkAudio>
LinkAudioSink(LinkAudio& link, std::string name, size_t maxNumSamples);

std::string name() const;
void setName(std::string name);                       // ※ 注意: name 系は thread-safe ではない
void requestMaxNumSamples(size_t numSamples);
size_t maxNumSamples() const;

// RAII で commit する内部構造
struct BufferHandle {
  BufferHandle(LinkAudioSink&);                       // ロック取得
  ~BufferHandle();                                    // ロック解放
  operator bool() const;                              // 有効かチェック
  int16_t* samples;                                   // 16-bit signed int 書き込み先
  size_t maxNumSamples;

  template <typename SessionState>
  bool commit(const SessionState&,
              double beatsAtBufferBegin,              // バッファ先頭ビート位置
              double quantum,                         // 量子化単位 (拍数)
              size_t numFrames,                       // フレーム数
              size_t numChannels,                     // 1 (mono) または 2 (stereo)
              uint32_t sampleRate);                   // ★ commit ごとに渡す（固定不要）
};
```

**重要発見**:
- `commit()` は **realtime-safe** と明記（SC plugin の audio thread から直接呼んで OK）
- `sampleRate` は **commit ごとに任意の値**を渡せる仕様 → API 上は SR 固定不要
- ただし後述「2. Sample rate 戦略」で別の制約あり

### 1.5 LinkAudioSource (subscribe 側 — OrbitScore では使わない)

```cpp
template <typename LinkAudio, typename Callback>
LinkAudioSource(LinkAudio& link, ChannelId id, Callback callback);
// Callback: void (BufferHandle bufferHandle)

ChannelId id() const;
~LinkAudioSource();

// BufferHandle は callback で渡される
struct BufferHandle {
  int16_t* samples;
  Info info;  // numChannels, numFrames, sampleRate, sessionBeatTime, tempo, etc.
};
```

OrbitScore は publisher のみ実装するため Source 側は本 Epic では使わない（Live が subscribe する側）。

## 2. Sample rate 戦略（最重要）

**API 上は柔軟だが、 実用上は publisher と subscriber の SR を一致させる必要がある。**

### 根拠 (Void-LinkAudio README からの一次引用)

> Pd vanilla performs no internal SRC. If Pd runs at 44.1 kHz against a publisher at 48 kHz (Live default), the receive ring buffer overflows continuously at the rate ratio (~8 % continuous drops).

つまり Link Audio 自身は **内部リサンプリングを行わない**。 publisher が 48k で出して subscriber が 44.1k で受けると、 ring buffer が ~8% 連続でオーバーフローし、 連続的にサンプルがドロップする。

### Live 12.4 のデフォルト

Live のデフォルト SR は **48kHz** （Live 12 は 44.1 もサポートするがプロジェクト設定依存、 Link Audio の peer 間整合は 48k 想定で運用するのが事実上の標準）。

### OrbitScore (scsynth) 側の方針

**確定方針 (Section 0.3 参照): scsynth は hardware SR のまま、 plugin 内で target SR へリサンプリング。**

当初は `-S 48000` 強制起動も候補だったが、 ユーザーレビューで以下の理由で plugin リサンプリング経路を採用:
- macOS audio device で 48kHz 不可なケースでの起動失敗を避け、 hardware 環境差異を吸収できる
- target SR を `init global.linkAudio(SR)` で .orbs ファイル単位に設定可能、 Live のセッション SR (44.1 等) にも対応できる柔軟性

### Step 2 への申し送り

- scsynth boot は既存通り (hardware SR 任せ)
- plugin 内で `LinkAudioSink::commit()` に target SR を渡す前にリサンプリング実装
- target SR の auto-detect 実装可能性を Step 2.1 で検証（LinkAudio peer info / OS query / その他）、 不可なら 48k fallback + DSL override
- リサンプリング実装は alpha 段階では線形補間 / 簡易 sinc などで最小実装、 後続で rubato 相当に置換も検討

## 3. ライセンス分離方針

### 3.1 Ableton Link のライセンス

- **GPL-2.0-or-later** (確認済、 標準 GPL v2 テキストに改変なし) または **proprietary commercial license**
- 商用配布する場合は `link-devs@ableton.com` への申請が必要
- header-only ライブラリ（`include/` 配下のヘッダのみ）→ 静的リンクではない

### 3.2 OrbitScore 本体ライセンス

- root: `LicenseRef-Signal-compose-FairTrade-1.0` (Cargo.toml workspace で確認、 LICENSE ファイル参照)
- VS Code extension: `SEE LICENSE IN ../../LICENSE`

### 3.3 SC plugin (`OrbitLinkAudio.scx`) のライセンス扱い

**結論: SC plugin (`.scx`) を独立 GPL-2.0-or-later artifact として分離配布する。**

- `.scx` 内に LinkAudio.hpp の inline コードがコンパイル結果として含まれる → 派生作品 → GPL-2.0-or-later 適用
- OrbitScore 本体（TypeScript / Rust / その他）は GPL の影響を受けない（プロセス分離 = scsynth 内 plugin、 OrbitScore は OSC client にすぎない）
- `.vsix` bundle に `.scx` を同梱する場合:
  - `LICENSE.GPL-2.0` を `Resources/plugins/` 配下に同梱（`scripts/extract-scsynth-bundle.sh` で copy）
  - `NOTICE` ファイルに「`Resources/plugins/OrbitLinkAudio.scx` is licensed under GPL-2.0-or-later, separate from the OrbitScore base license」と明記
  - distributing aggregation (mere aggregation) として扱える（GPL FAQ）→ OrbitScore 全体が GPL になることはない

### 3.4 商用配布判断

OrbitScore が将来商用配布フェーズに入る場合:
- 選択肢 A: GPL plugin のまま配布、 利用者は GPL 義務を理解
- 選択肢 B: Ableton から proprietary license を取得して GPL 制約を外す
- 現状は research / personal use フェーズ → 選択肢 A で問題なし。 Step 4 のリリースパイプライン整備時に re-review

### 3.5 Legal review が必要な箇所（明文化）

- `.scx` 配布時の LICENSE / NOTICE 文言の最終確認
- `.vsix` bundle 内での aggregation 認定の有効性（mere aggregation かどうか）
- Marketplace 配布時の Microsoft / Open VSX のライセンス表記要件

## 4. 設計上の追加確定事項

### 4.1 channel name の制約

公式仕様では明示されていない。 安全側で以下を採用:
- 許容文字: ASCII 英数 + `-` + `_`（peer 間で文字化け回避）
- 最大長: 64 chars（推測の安全側、 LinkAudio 仕様で上限が確認できれば更新）
- 最大 channel 数 / peer: 制約なし（複数 Sink 公開は API 上自由）。 OrbitScore 側で実用上 16 を上限とする（同時シーケンス数の現実的上限）

### 4.2 enable/disable ライフサイクル

- `enableLinkAudio(true)` を plugin load 時に呼ぶ
- `enableLinkAudio(false)` は scsynth shutdown 時に呼ぶ（デストラクタ任せでも良い）
- ランタイム切替（Live セッション中に LinkAudio をオフにする等）は v1.2.0 では非対応とする（次バージョンで検討）

### 4.3 Link 単独同時使用ガード

- 既存 OrbitScore に Link 単独統合は **無し**（探索済、 `node-abletonlink` 等の依存なし）
- 将来追加した場合は OrbitScore 起動時に検出して エラー終了する guard を実装（Step 4 で対応）

### 4.4 channels callback の使い道

- `setChannelsChangedCallback` のシグネチャは `void()`（引数なし）
- 内部で `channels()` を呼んで現在の channel リストを取得する
- OrbitScore 用途では「他 peer が新 channel を公開した」 通知に使えるが、 publisher only 実装のため当面は **logging のみ**（debugging / status display 用途）

## 5. プランへの修正提案

### 5.1 修正なし（仮説が一次情報で裏付けられた項目）

- SC plugin (C++ UGen) 経路の妥当性 ✅
- `LinkAudio` が `Link` を継承するため tempo/beat/phase/transport は base クラスで取れる ✅
- 16-bit signed int interleaved 形式 ✅
- mono / stereo のみ ✅
- `BufferHandle::commit()` は realtime-safe で SC plugin の audio thread から呼べる ✅
- alpha API、 wrapper 1 ファイルでの追従戦略 ✅

### 5.2 追加・補強

- **出力モードを Global で排他化**: 当初の per-sequence destination 案 (`seq.output("link-audio", "ch")`) から、 `init global.linkAudio()` による file 単位の mode 宣言 + sequence 側は channel name のみ (`seq.output("ch")`) へ簡素化（Section 0.1, 0.2）
- **scsynth は hardware SR 任せ + plugin 内リサンプリング**: 当初の `-S 48000` 強制起動案を撤回、 hardware 環境差異吸収と Live セッション SR 柔軟対応のため (Section 0.3)
- **target SR は auto-detect → DSL override → 48k fallback**: `init global.linkAudio(SR)` でファイル単位設定可能
- **LinkAudio enable/disable ライフサイクル**: `init global.linkAudio()` 宣言時に load + enable、 scsynth shutdown 時 disable / unload (Section 0.6)
- **channels callback は debug/logging 用途**: publisher only 実装のため現段階で機能的役割なし
- **Channel 同時公開上限**: self-imposed 制限なし、 LinkAudio 仕様任せ (Section 0.5)
- **Channel name policy**: ASCII + `-_`、 max 64 chars（API 仕様未明、 安全側）

### 5.3 Step 2 着手前の TODO

- LinkAudioHut example の `AudioPlatform` 抽象を読み込んで commit ループの実装パターンを確定（404 で取得できなかった `linkaudio/AudioPlatform.hpp` を git submodule 取り込み後に直接読む）
- target SR auto-detect 戦略の実装可能性検証 (Step 2.1): LinkAudio peer info / OS query / その他の API surface を確認
- Plugin 内リサンプリング実装方針確定: 線形補間 / 簡易 sinc / rubato 相当のいずれを選ぶか（alpha 段階では最小実装で開始）
- SC Plugin SDK のバージョン整合（scsynth bundle 3.14.x との ABI 一致を `verify-bundle.sh` で assert）

## 6. 残る不確定要素

| 項目 | 影響度 | 解決時期 |
|---|---|---|
| `linkaudio/AudioPlatform.hpp` の commit ループ実装パターン | 中 | Step 2.1 で submodule 取り込み後 |
| LinkAudio peer info / OS API による target SR auto-detect 可否 | 中 | Step 2.1 で API surface 直接確認 |
| Plugin 内リサンプリングの実装方式（線形 / sinc / rubato 相当） | 中 | Step 2.2 で audio quality 評価しつつ確定 |
| `.vsix` bundle 内の aggregation 法的扱い | 中 | Step 4 (リリースパイプライン) で legal review |
| LinkAudio.hpp の SDK バージョン pinning 戦略 | 中 | Step 2.1 submodule 設定時 |

## 7. 結論

**Step 1 ゴール達成。** API surface・SR 戦略・ライセンス分離方針・設計上の追加確定事項がすべて一次情報ベースで明文化され、 ユーザーレビューにより設計決定 (Section 0) が確定した。 当初の per-sequence destination + 48kHz 強制案からは、 **Global mode 宣言 + plugin 内リサンプリング + per-sequence channel name only** へ簡素化されたが、 これは破壊的 finding に基づく変更ではなく UX 設計上の judgment call。 Epic #187 のプラン本体は Section 0 を反映した形で update が必要 (Step 2 着手前に Epic body を update 予定)。 後続 Step 2 (SC plugin 実装) は本ドキュメントの確定事項を前提に着手可能。

---

**参考: 直接引用元の URL 一覧**

- LinkAudio.hpp: https://raw.githubusercontent.com/Ableton/link/master/include/ableton/LinkAudio.hpp
- Ableton/link README: https://github.com/Ableton/link/blob/master/README.md
- Ableton/link GPL v2.0 license file: https://raw.githubusercontent.com/Ableton/link/master/GNU-GPL-v2.0.md
- Void-LinkAudio README: https://raw.githubusercontent.com/gluon/Void-LinkAudio/main/README.md
- LinkAudioHut example: https://github.com/Ableton/link/tree/master/examples/linkaudiohut
- scsynth `-S` フラグ: https://manpages.debian.org/testing/supercollider-server/scsynth.1.en.html
- ServerOptions sample rate: https://doc.sccode.org/Classes/ServerOptions.html
