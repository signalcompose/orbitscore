# Post-2.0 エンジン方針 + ライセンス/配布/収益モデル

> **ステータス: 探索→方向収束。post-2.0。2026-06-19 大和さんと議論。** 実装はまだ。`docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md`（Tracktion feasibility）の Tracktion 寄り結論を**本書が更新**する。前提: 2.0.0-dev 確定が先（[[POST_2.0_ROADMAP_NOTES]]）。

---

## 0. 結論（engine 決定の重心が Rust に移った）

**エンジンは Tracktion ではなく、既存の自社 Rust ワークスペース `rust/` を発展させる方向。** 重心を動かした2点:
1. **既存 Rust エンジンが foundation を既にカバー**（下記 §1）。Tracktion の「実装速度」優位がほぼ消えた。
2. **ライセンス/収益モデル**（§3-4）: GPL（Tracktion/JUCE）は **freemium を原理的に foreclose** する。permissive な Rust なら freemium/商用/クローズドの自由が残る。

**確定の最後の関門 = 「Rust で 3rd-party プラグインホスティングが現実的か」→ ✅ feasibility 確認済（2026-06-19, `docs/research/RUST_PLUGIN_HOSTING.md`）。** 3 標準すべてに permissive な Rust binding が存在し、Rust 製 DAW(MeadowlarkDAW) が実際に clack でホストしている。成熟度 CLAP ＞ AU ＞ VST3。**★ VST3 が MIT 単独化（SDK 3.8, 2025-10）で copyleft 障壁も消滅**。→ **engine = Rust（既存 `rust/`）で確定方向**。Tracktion フォールバックの license 動機は消えた（残るのは clack pre-1.0 breaking / RT 統合が解けない等が判明した場合のみ）。**残る証明は CLAP 統合スパイク + RT 統合設計**（binding 存在 ≠ production 実績）。

## 1. 既存 Rust エンジン `rust/`（実装・テスト済み・permissive・PoC v0.0.1）

- **`orbit-audio-core`**（platform 非依存・thiserror のみ）: フレーム精度スケジューラ + interleaved ミキサー、per-sample gain、`play_id` 個別 stop、マスターゲイン線形ランプ、RT 配慮（callback は try_lock→silent drop・alloc 無し）、完了 drop。ユニットテスト充実。
- **`orbit-audio-native`**（cpal + symphonia + rubato）: 実 cpal 出力（F32/I16/I32/U16・ALSA 含む）、xrun/device-lost を atomic、RAII、scratch 事前確保。symphonia デコード + rubato リサンプラ。
- **`orbit-audio-daemon`**（WebSocket IPC・protocol v0.1）: 「別プロセス + IPC」そのもの。JSON command/response/event、handshake、capabilities、起動 ready/error 1行 JSON、server/session/backend + tests。SoT = `docs/research/ENGINE_DAEMON_PROTOCOL.md`。**TS↔Rust 接続契約が既にある**（OSC でなく WebSocket）。
- **`orbit-audio-wasm`**: AudioWorklet stub（同じ core がブラウザ/Electron worklet で動く路）。
- ライセンス = Fair Trade、依存は全て permissive（cpal/symphonia/rubato/tokio = MIT/Apache/MPL）。**GPL フリー**。

### 差分（未実装）
- ★ **3rd-party プラグインホスティング（CLAP/VST3/AU）**= long pole・唯一の本当の未知数 → feasibility research。
- **lock-free 化**（今 Mutex+try_lock。コード内 TODO）。
- **LinkAudio 統合**（今は C++ `.scx`。Rust では隔離 GPL モジュールに）。
- MIDI/pitch は TS のまま（想定通り）。

## 2. アーキテクチャ: 薄い permissive ホスト + DSP はプラグイン

- **engine core は薄く保つ**: 再生 / ミックス / ルーティング / スケジュール（実装済）。RT で自明な gain/pan までプラグイン化しない。
- **DSP/FX/楽器 = プラグイン**（CLAP/VST3）。**hosting は 3rd-party 専用**（自分で書かないもの・MIDI/標準駆動）。
- **time-stretch は engine 内**（hosted plugin にしない）: 理由 = それは「**ストレッチを持つサンプラー楽器**」であり、OrbitScore の音声 DSL（slice/chop/rate/**time/fixpitch**/polymeter/per-slice gain）は **MIDI より豊か**で、MIDI 駆動の hosted plugin では落ちる。engine は既にサンプラーなので、**native sample ノードに permissive stretch（Signalsmith）を足す**のが最短。DSL 面は **#213 `fixpitch()`/`time()`**（今 stub）を Rust stretch ノードに対して実装。
- **売り物化は DSP を共有 crate に**: stretch DSP を再利用可能 crate にし、engine ノード（DSL 駆動）と、任意の **standalone サンプラー VST（MIDI 駆動・他 DAW・単体販売の別製品）** の2フロントエンドで共有。engine を plugin 境界に通さずに製品も作れる。1st-party プラグインは **nih-plug（Rust・ISC・CLAP+VST3 を1コードベースで）**。

## 3. ライセンス規律（全戦略の土台・唯一守る規律）

- **engine の依存を permissive に保つ。GPL は隔離する。**
  - time-stretch = **Signalsmith（permissive）**。**Rubber Band（GPL）は避ける**、élastique は商用。
  - **Ableton Link（GPL）は別プロセス/別 crate の隔離モジュール**に留める（Link 商用ライセンスは交渉可・Ableton は交渉余地あり）。
- **engine は Fair Trade License の自社内部基盤**。外販エンジン事業（Tracktion ポジション）はやらない → 「安定 public API/外部サポート/engine 市場で競合/出荷の焦点喪失」の負担が全部消える。**自社製品に必要な分だけ整える**。
- これさえ守れば Fair-Trade エンジン + permissive 依存の上に free/freemium/クローズド/商用 を何でも乗せられる。

## 4. 収益モデルと層構造

| 層 | ライセンス/形 | 収益 |
|---|---|---|
| **orbit-audio エンジン** | Fair Trade・内部基盤 | （外販しない。製品の土台） |
| **1st-party プラグイン**（サンプラー/FX, nih-plug） | permissive | 同梱無料 + 単体販売 |
| **OrbitStudio アプリ**（VSCodium + engine + DSL） | freemium | 無料ベース + 有料機能ロック解除 |
| **OrbitScore 言語** | オープン | — |

- **freemium ⟺ permissive は表裏**: 機能ロック課金は GPL では不可能（ソース公開 + 改変/再配布自由 → ロックは外せるし法的に許される）。**permissive コアだからこそ freemium ができる**。これが engine ライセンスが load-bearing な理由。
- 「完全 OSS」か「freemium（有料部分はクローズド）」かは別途の意思決定だが、**どちらを選ぶ自由も permissive 基盤が前提**。

## 5. 配布チャネル

- **App Store はプラグインホスト型アプリにはほぼ不可**: ① sandbox が任意の第三者 VST ロードを許さない（AU は entitlement で条件付き可・VST は不可）② GPL を抱える場合さらに不可。収益モデルと無関係に技術で弾かれる。
- **現実的チャネル = Steam + Developer ID で notarize した直接配布（.dmg）**。両方 GPL/sandbox 制約と相性が良い。Steam は「無料機能制限版 + 有料フル版」も可。
- macOS の notarize は既存 **#210（Developer ID re-sign）** と地続き。

## 6. `.vsix` の寿命と命名

- **`.vsix` は 2.0.0 で feature freeze**（廃止でなく）。専用アプリが実用品を出すまで **2.0.x パッチ口は残す**（唯一動く船を先に燃やさない）。
- **pitch/song 再設計はアプリ優先**、必要なら `.vsix` に backport（VS Code 利用者カバーは二次目標）。
- 命名: **OrbitScore = 言語（拡張でもアプリでも中で生きる）/ OrbitStudio = 専用アプリ（候補名）**。移調は `transpose()`（`transport` は再生ヘッド連想で不可）。

## 7. 次の一手（feasibility は確認済 → スパイクへ）

feasibility research 完了（`docs/research/RUST_PLUGIN_HOSTING.md`）。次は実証スパイク:
- **S1（最優先）: CLAP ホスティング** — `clack-host` を既存 orbit-audio の cpal callback に統合し、実 CLAP 楽器を1つロードして発音 → render tap。最短・最成熟（MeadowlarkDAW が前例）。
- **S2: AU**（`objc2-avf-audio`/AVAudioEngine。AUv3 registration の落とし穴に注意）。
- **S3: VST3**（`vst3` crate, MIT。host ロジック手書き＝工数最大、最後）。
- **着手前に要設計検証**: orbit-audio の cpal callback + WebSocket daemon への RT 安全な統合方式（同一 callback / 別スレッド / プロセス分離）。
- **別途調査(open)**: time-stretch（Signalsmith の Rust binding `ssstretch`/`signalsmith-stretch` が存在の兆候・詳細未確認）/ 配布（Mac App Store sandbox・notarize/Steam）。

## 8. Caveats
- 既存 Rust engine は PoC（v0.0.1・Mutex・hosting/stretch 無し）。「foundation 済」であって「完成」ではない。
- Rust プラグインホスティングは未検証（本研究で確認）。
- Fair Trade License の具体条項が engine の扱いを最終的に規定する。

---

関連: [[POST_2.0_ROADMAP_NOTES]] / [[POST_2.0_PITCH_MODEL_NOTES]] / `docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md`（本書が Tracktion 結論を更新）/ `docs/research/ENGINE_DAEMON_PROTOCOL.md` / #210 / #213。
