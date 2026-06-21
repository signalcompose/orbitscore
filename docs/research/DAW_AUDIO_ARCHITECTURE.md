# 標準 DAW オーディオ信号経路アーキテクチャ調査

**調査日**: 2026-06-21  
**目的**: post-2.0 native Rust オーディオエンジン（orbit-audio）の routing・effects・multi-out 設計 backlog への roadmap 入力。標準 DAW の確立された慣習を OrbitScore 確定アーキ（`docs/development/POST_2.0_ENGINE_AND_DISTRIBUTION.md` §2）にマップする。  
**方法**: context7 MCP（`/free-audio/clap` ライブラリ）/ WebSearch（Ableton・Logic・Reaper・Bitwig 公式マニュアル、定評ある教材サイト）/ OrbitScore docs 精読。  
**位置づけ**: アーキ §2（確定済）を再設計しない。機能の「居場所」を確定アーキにマップし、実装含意と増分順序を提示することが成果物。

---

## 1. 標準 DAW の信号経路概観

```
  ┌──────────────────────────────────────────────────────────┐
  │  Instrument Track / Audio Track                          │
  │  [Sound Source / Clip] → [Insert FX Chain] → [Fader]   │
  │                              │ (pre-fader send)         │
  │                              │         ↓                │
  │                              │   [Return/Aux Track]     │
  │                              │   [Insert FX (e.g. Reverb)]
  │                              │         ↓                │
  │                         (post-fader send)               │
  │                              │                          │
  └──────────────────────────────┼──────────────────────────┘
                                 │
  ┌──────────────────────────────▼──────────────────────────┐
  │  Group / Bus Track (サブミックス)                        │
  │  [受け取った複数トラックのミックス] → [Insert FX] → [Fader]│
  └──────────────────────────────┬──────────────────────────┘
                                 │
  ┌──────────────────────────────▼──────────────────────────┐
  │  Master Bus                                              │
  │  [全トラック合流] → [Insert FX (Limiter等)] → [Master Fader]│
  └──────────────────────────────┬──────────────────────────┘
                                 │
  ┌──────────────────────────────▼──────────────────────────┐
  │  Hardware Output Routing                                 │
  │  Output Bus 1→2 → Audio Interface ch 1/2 (Main)         │
  │  Output Bus 3→4 → Audio Interface ch 3/4 (DJ Cue 等)    │
  └──────────────────────────────────────────────────────────┘

  ※ Sidechain: コンプ等の非メイン入力ポートに別トラックをルーティング
  ※ PFL (Pre-Fader Listen): フェーダー前の信号をモニター/Cue に送る
```

### 各 DAW のモデル差異（「標準の共通項」の限界）

- **Ableton Live**: Return トラック（Aux）は固定。Group トラック（通称 Bus）は複数トラックを入れ子にするサブミックス専用。両者は明確に区別される。Send は1トラック内でレターグループ（A, B, C…）単位で pre/post-fader を切り替え可能（個々の send ごとにバラバラには切れない）。デフォルトは **post-fader**。
- **Logic Pro**: Aux Channel Strip が Return 相当、Bus はルーティング先バス番号で指定。Logic 8 以降、内部的に Aux と Bus は同一実装（ワークフロー上の意味が異なるのみ）。
- **Bitwig Studio**: デバイスチェーン内に Instrument・FX・Note エフェクトの概念があり、signal flow が他 DAW よりフレキシブル。Post-fader がデフォルト。
- **Reaper**: 「ラベル付きバスが存在せず、任意のトラックから任意のトラックへ直接ルーティング可能」な統一トラックモデル。Pro Tools と対照的に最も柔軟。
- **Pro Tools**: バス名と信号経路を明示的に設定する固定型（Aux Input トラックへのバスアサイン方式）。named buses + aux tracks の固定モデルが標準の最小公倍数に近い。

> **含意**: 「標準 DAW」の共通項は「**insert chain → send/return → group → master → hardware out の層構造**」と「**pre/post-fader の tap 点の概念**」であり、具体的なルーティング UI は OrbitScore 固有設計に委ねられる。Reaper のフレキシブルモデルは OrbitScore の graph-based routing 設計に概念的に近い。

> 出典: forum.ableton.com / musicguymixing.com / blackghostaudio.com / soundonsound.com / audeobox.com / reaper.blog（詳細 URL は §7 参照）

---

## 2. 機能 → OrbitScore での居場所マッピング表

> **居場所の定義**:
> - **① engine core routing**: engine が RT で管理。graph トポロジー・tap 点・ゲイン・バス割り当てを所有。
> - **② CLAP プラグイン**: out-of-process sandbox（未来の γ フェーズ）または現在の in-process CLAP ホスト（S1/S1b）。pure audio→audio DSP。
> - **③ DSL 表現面**: OrbitScore `.orbs` DSL からユーザーが記述・制御する層。

| # | 機能 | 標準 DAW での挙動 | 居場所 | 実装含意 |
|---|------|------------------|-------|--------|
| 1 | **insert チェーン**（直列 FX） | トラックの signal path にプラグインを直列挿入。音源→insert 1→insert 2→...→fader の順。Ableton は上→下の順序が signal flow。 | **① + ②**: チェーンのグラフトポロジーを ① core が所有。個々のノードは ② CLAP プラグイン。挿入・削除・順序変更は ① が graph を書き換える。 | RT 安全なグラフ更新（lock-free or double-buffer）が必要。プラグインは順序を知らない。core がチェーンの実行順を決定。 |
| 2 | **insert 順序の制御**（最重要） | drag & drop でプラグインスロットを並び替え可能（Ableton・Logic・Bitwig 共通）。順序変更は即時反映。 | **① engine core routing** | §4 で独立詳述。RT 中の graph 変更は原子的でなければならない（次フレームから有効など）。 |
| 3 | **send（pre-fader）** | フェーダー前の信号を別トラック（Return/Aux）へ分岐。フェーダーを下げても send 量は変わらない。Cue モニター・ヘッドフォンモニタリング（PFL）の一般的な接続方法。 | **① engine core routing** | tap point = insert chain 直後・fader 前。send level は ① が管理するゲインパラメータ。DSL からは `send :amount, :to` 等の表現で制御予定（③ 将来）。 |
| 4 | **send（post-fader）** | フェーダー後の信号を分岐。フェーダー操作に send 量が追従。空間系 FX（Reverb・Delay）の一般的な接続方法。Ableton・Logic・Bitwig でデフォルト。 | **① engine core routing** | tap point = fader 後。pre/post の tap 切り替えは ① 内の接続設定。Ableton は1トラック内でレターグループ単位の pre/post 切り替えをサポート（ゲインレベルとは別パラメータ）。RT 安全な tap 切り替えが要る。 |
| 5 | **複数 send** | 1トラックから複数の Return/Aux に同時 send 可能（例: Reverb Bus + Delay Bus に並行送り）。 | **① engine core routing** | グラフの分岐（fan-out）。① が複数の送り先へのゲインセットを管理。DAG（非循環）制約を ① が強制。 |
| 6 | **aux / return トラック** | send の受け取り専用トラック（Ableton の Return Track / Logic の Aux Channel Strip）。1以上のトラックからの send を受け、自身の insert FX を通して Master に流す。 | **① + ②**: バスのトポロジーは ①。aux に挿入される FX は ②（CLAP）。 | Return トラック = ① 内の混合ノード + FX チェーン。Group との区別: Group は「入力元が直接ルーティング」、Aux は「send で来る」。 |
| 7 | **group / bus トラック** | 複数トラックをサブグループとしてまとめ、サブミックス用 FX（コンプ・EQ）を一括適用（Ableton の Group Track / Logic の Buss / Reaper の子トラック）。 | **① + ②**: サブミックスの sum は ①。Group に挿入する FX は ②。 | Group = sum ノード + FX チェーン。Reaper の「全トラックが Bus」モデルは OrbitScore のフレキシブル graph 設計に近く、参考になる。 |
| 8 | **sidechain ルーティング** | コンプ等の「非メイン」入力ポートに別トラックの音を入力。例: キックドラムでベースのコンプを叩く。Ableton: Compressor の "Audio From" でソーストラックを選択（Pre-FX 推奨: ソーストラックの FX をバイパスした素の信号を使う）。Logic: Compressor の Side Chain ドロップダウンで入力 ch を指定。サイドチェーン信号は通常の insert chain を通らない「別ポート」経由。 | **① engine core routing**（接続）+ **② CLAP プラグイン**（処理） | サイドチェーン = プラグインの非メイン入力ポートへの接続。CLAP では `audio-ports` extension で入力ポートを複数宣言可能（CLAP_AUDIO_PORT_IS_MAIN でないポートがサイドチェーン）。ルーティング接続は ① が管理。DAG cycle に注意（サイドチェーンが循環するとデッドロック）。 |
| 9 | **master bus / 最終出力** | 全トラックが合流するフィナルミックス段。Limiter・Meter・Mastering FX 等を insert。Master Fader が全体音量を制御。 | **① engine core routing**（master sum + fader）+ **②**（insert FX） | orbit-audio-core の既存 `master_gain` が相当。Master への FX チェーンは ② CLAP。 |
| 10 | **ハードウェアマルチアウト** | 出力バス（stereo pair 等）をオーディオインターフェースの物理 ch に割り当て。例: Bus 1/2→ch 1/2（Main）/ Bus 3/4→ch 3/4（Cue / DJ B deckへ）。 | **① engine core routing** | cpal の device output mapping に相当。① が出力バスと cpal デバイス ch の対応を管理。OrbitScore の dance/DJ 運用で重要。 |
| 11 | **DJ Cue / PFL (Pre-Fader Listen)** | フェーダー前の信号をヘッドフォン/モニターに送る（PFL）。「フェーダーを下げてもCueで聴ける」。AFL(After Fader Listen)はフェーダー後。DAW では Cue Bus に signal を tap する形で実装。 | **① engine core routing**（tap + Cue Bus） | PFL tap = insert chain 後・fader 前の信号を Cue 出力バスに分岐。マルチアウトで物理 ch を確保してから実装可能。DJ ミキサーに繋ぐ場合はマルチアウトが前提（次項）。 |
| 12 | **DJ A/B 切り替え / クロスフェード** | 2 deckの信号を crossfader で A→B にブレンド（DJ ミキサーモデル）。DAW 内の代表的な実装例: **Ableton Live** の Session View にある A/B クロスフェーダー（トラックごとに A/B/なし を割り当て、Session Crossfader で混合比を制御）。OrbitScore の主運用は「マルチアウト→外部 DJ ミキサー」。 | **① engine core routing**（内部実装の場合）or **マルチアウト経由で外部処理** | 内部 crossfade = ① の gain ノード2系統をクロスフェード係数で補間（Ableton Session Crossfader 参考）。外部 DJ ミキサー運用 = ① で Bus A / Bus B を物理 ch に出力し、ハードウェア側で操作。OrbitScore の確定アーキでは「マルチアウト→外部 DJ ミキサー」が主案（owner 明示）。内部 A/B クロスフェードは追加の gain ノードで実現可能（① のみ）。※ 調査済: Ableton 公式 Session crossfader が DAW 内 DJ A/B の標準例。Bitwig 独自クロスフェード器の有無は未確認。 |

---

## 3. insert 順序制御の設計含意（最重要）

### 標準 DAW の慣習

標準 DAW（Ableton Live・Logic Pro・Bitwig・Reaper）では、insert スロットの物理的な並び順が signal flow 順と一致する。Ableton では上から下、Logic では左から右にチェーンされる。ユーザーは drag & drop でスロット位置を変更でき、変更は通常「次フレーム or 次バッファ」から有効になる（再生中断なし）。「pre/post」の概念はチェーン内ではなくチェーン全体に対する fader の位置（pre-insert / post-insert = after all inserts）として使われる。

> **出典**: Ableton Live 12 Manual, "Audio Effects" section — <https://www.ableton.com/en/packs/audio-effects/>; Logic Pro Manual, "Signal flow in a channel strip" — <https://support.apple.com/guide/logicpro/welcome/mac>  
> ※ 公式マニュアルの該当 URL は要確認（下記 §7 参照）。一般的な DAW 慣習として高確度、マニュアル直 URL は「未確認・要確認」とマークする。

### OrbitScore での実装含意

**graph は engine core (①) が所有し、プラグインは順序を知らない。**

CLAP プラグイン自体は自身が insert chain の何番目かを知らない。host（engine core）が処理グラフの有向辺（A→B→C）を管理し、各フレームで宣言順に `process()` を呼ぶ。insert 順序の制御 = **グラフのエッジ書き換え**（core の仕事）。

**RT 中の順序変更**は以下の方針が必要:
- **double-buffer / shadow graph**: 現行グラフを RT スレッドが使用中に、新グラフを main スレッドで構築。ポインタ原子交換で切り替え。
- **次バッファ境界で有効**: 変更はバッファ境界までは旧グラフで処理し、次バッファから新グラフに切り替える（可聴アーティファクト最小化）。
- **DAG 制約の強制**: エッジ追加時にサイクル検出（sidechain を含む）。フィードバックループは許可しない（DAG = 非循環有向グラフを厳守）。

**PDC（Plugin Delay Compensation）**:
CLAP の `latency` extension により、各プラグインは処理レイテンシを samples 単位で報告する（`clap_plugin_latency_t::get()`）。ホスト（engine core）は insert chain 内の各プラグインのレイテンシを合計し、並行するトラック（例: Dry 信号・別 Bus）にディレイを挿入して整合させる（Plugin Delay Compensation = PDC）。insert 順序が変わるとチェーン合計レイテンシが変化するため、**順序変更のたびに PDC 再計算が必要**。PDC は ① engine core の責務。  
> 出典: context7 `/free-audio/clap` — `render-latency-extensions.md`: *"Used by the host for audio alignment, recording offsets, and latency compensation."*

**pre/post の概念（tap point の3階層）**:

標準 DAW の send には「insert の後、fader の前後」という2軸があり、さらに「insert 以前」の特殊 tap を合わせて3種の tap point がある:

| tap 名 | 位置 | 用途 |
|--------|------|------|
| **pre-FX（pre-insert）** | insert chain より前（dry 信号） | サイドチェーン入力用（Ableton Compressor の "Audio From: Pre-FX"）。send の tap としては特殊。 |
| **pre-fader（post-insert）** | insert chain 通過後・fader 前 | Cue モニター・PFL。フェーダーを下げても send 量が変わらない。**row 3 の tap point**。 |
| **post-fader** | fader 通過後 | 空間系 FX（Reverb・Delay）への send。フェーダー操作に send 量が追従。Ableton・Logic・Bitwig のデフォルト。**row 4 の tap point**。 |

- **重要**: "pre-fader send" = insert chain 通過後・fader 前（post-insert / pre-fader）。"pre-insert（pre-FX）" は別の概念でサイドチェーン専用。誤って同一視しないこと。
- tap point は ① core がグラフ内の接続点として管理（プラグインは関知しない）。Ableton では pre/post-fader はレターグループ（A, B, C…）単位で切り替え可能（個別 send ごとには切れない）。
- 出典: musicguymixing.com / gear4music.com（Ableton sidechain pre-FX 説明）/ Ableton forum

---

## 4. CLAP routing 能力と out-of-process 境界の含意

### CLAP の routing 能力

CLAP プラグインは **ports** を宣言し、**ホストが接続する**設計である。プラグインは自身のグラフ上の位置を知らない。

| CLAP Extension | 機能 | OrbitScore での意味 |
|----------------|------|---------------------|
| `audio-ports` | プラグインが持つ入出力オーディオポートを宣言。`CLAP_AUDIO_PORT_IS_MAIN` フラグで主ポートを識別。非メインポートがサイドチェーン入力に使える。 | サイドチェーン接続 = 非メイン入力ポートへの接続を ① core が確立する。マルチアウト = プラグインが複数出力ポートを宣言。 |
| `note-ports` | MIDI / CLAP ネイティブ note イベント / MIDI 2.0 / MPE のうちサポートする dialect を宣言。`note_id` で per-note 識別。 | in-process 楽器の DSL 表現力（per-note/per-slice）と密接。out-of-process effects には note ports 不要なことが多い。 |
| `latency` | プラグインが導入するサンプル数レイテンシを報告（`get()` は main-thread のみ・activate 中は不変）。 | ① core が PDC を実装するための情報源。 |
| `params` | パラメータ自動化・sample-accurate な parameter sweep をサポート。 | insert チェーン内の FX パラメータを DSL や transport から制御する将来機能の基盤。 |
| `transport-control` | host transport（再生/停止/BPM/拍子）をプラグインへ供給。**README が "draft" と明記**。 | BPM-sync FX（オートワウ等）に将来必要。draft 段階のため安定 API として扱わない。 |

**重要原則**: *CLAP ホスト（= engine core ①）が routing のすべてを所有する。プラグインはポートを宣言するだけ。insert 順・send 接続・サイドチェーン接続はすべて host side の graph 管理。*

> 出典: context7 `/free-audio/clap` — `audio-ports-extension.md`, `note-ports-extension.md`, `render-latency-extensions.md`

### out-of-process 境界（γ フェーズ）の含意

**現状（S1/S1b 完了）**: effects は in-process CLAP ホスト（clack-host）でロードされる。out-of-process sandbox はまだ未構築（§2.2 fault ②「γ」= open）。

**γ 実装時の含意**:
- effects プラグインプロセスへのオーディオ転送に **shared-memory IPC**（零コピー）が必要（WebSocket は RT には不適）。
- insert チェーンの1ノードが out-of-process になると **往復 1 frame + process time のレイテンシ**が追加される。PDC でこれを補正。
- out-of-process プラグインが crash しても engine core は生存し、そのスロットを bypass 扱いにする watchdog が必要（§2.2 fault ② の核心）。
- **DAG 制約はプロセス境界をまたいでも必要**（サイドチェーンが out-of-process プラグインをまたぐ場合、デッドロックリスクがある。送受信の順序を厳密に設計する）。
- **RT-safe event IPC**: パラメータ・note イベントも out-of-process 境界を越える。lock-free ring buffer over shared memory が定石（Bitwig / Studio One の既知手法）。

---

## 5. 増分順序の提案

> **前提**: §2.5（engine-first ロードマップ）を尊重する。確定済ロードマップの修正案ではなく、routing/FX 機能を **§2.5 の後続増分にどう積むか** の提案。変更を要する場合は「提案」として明示。

### 基礎（現行 第1増分・§2.5）
- **pan / slice / per-slice gain** + **α recovery floor**: 現在進行中（issue #300 系）。
- これが完了すると「core routing の基礎ノード」（gain、基本ミックス）が使える状態になる。

### 推奨増分順序（routing・FX・multi-out・DJ）

| 段 | 内容 | 依存 | 備考 |
|----|------|------|------|
| **R1** | **送り先（Return/Aux バス）の sum ノード** をコアに追加。簡単な send (post-fader) を DSL で記述できるようにする。 | 第1増分完了 | グラフに fan-out エッジを追加する最初の一歩。PDC は R1 では不要（レイテンシゼロの理想ノードから始める）。 |
| **R2** | **group / bus トラック**（sub-sum ノード）。複数トラックのサブミックスを core で実現。 | R1 | R1 と構造が近い（sum ノードの再利用）。大和さんが評価する「資産再利用」に沿う。 |
| **R3** | **insert チェーン（CLAP プラグイン1本）** の接続。in-process CLAP ホストは S1/S1b 完了済みなので接続 API と graph への組み込みが主作業。 | R2 + S1/S1b | 最初は1スロット固定で良い。順序変更・PDC は後続へ。 |
| **R4** | **insert チェーン複数スロット + 順序変更**。RT 安全なグラフ更新（double-buffer）と PDC 再計算。 | R3 | §3 で詳述した設計が必要になるタイミング。 |
| **R5** | **マルチアウト（cpal 物理 ch マッピング）**。出力バスを cpal デバイスの ch ペアに割り当て。 | R4 | DJ 運用の前提。cpal は既存資産（orbit-audio-native）。 |
| **R6** | **Cue / PFL**（DJ モニター）と **DJ A/B（内部 crossfade またはマルチアウト経由）**。 | R5 | R5 のマルチアウトが実装されると「Bus A を ch 1/2、Bus B を ch 3/4 に出す」で外部 DJ ミキサー運用が実現する。内部 crossfade は追加の gain ノード。 |
| **R7** | **out-of-process sandbox（γ）**。shared-mem IPC + watchdog + PDC 補正。3rd-party CLAP プラグインの安全なホスティング。 | R4 + α完了 | §2.2 fault ② 相当。R4 の insert 基盤が固まってから。 |
| **R8** | **サイドチェーンルーティング**（非メイン入力ポートへの接続）。 | R4 + R7 (out-of-process が必要な場合) | in-process CLAP なら R4 後から可能。DAG cycle 検出の実装が必要。 |
| **R9** | **pre-fader send**（tap point 切り替え）。 | R1 | R1 で post-fader send を実装した後、tap 切り替え機能を追加。 |

### リスク

| リスク | 内容 | 軽減策 |
|--------|------|--------|
| γ(out-of-process) の複雑度 | shared-mem IPC + RT safety + watchdog は §8 caveat 通り未構築で工数未知 | R3-R4 の in-process insert で効果を先に使えるようにし、γ を別スパイクで充分に設計する |
| PDC の複雑度 | insert チェーン合計レイテンシの変動・out-of-process の追加レイテンシ | R4 着手前に PDC 設計をドキュメント化してから実装 |
| DAG サイクル（sidechain） | サイドチェーン接続がフィードバックループになる可能性 | cycle detection を graph 更新のすべてのパスで強制（insert・send・sidechain 共通）|
| transport-control CLAP extension が draft | BPM-sync FX の実装が CLAP の安定 API に依存できない | この機能は CLAP 仕様が stable になるまで defer |
| clack-host pre-1.0 breaking changes | R3-R4 の insert 実装が clack の API 変更で破損するリスク | clack の changelog を定期的に追う。抽象ラッパーで内部 API 変更を隔離 |

---

## 6. 参照

### OrbitScore 内部ドキュメント
- `docs/development/POST_2.0_ENGINE_AND_DISTRIBUTION.md` §2 — アーキ正本（居場所判定の一次根拠）
- `docs/research/RUST_PLUGIN_HOSTING.md` — CLAP/VST3/AU hosting feasibility 調査（2026-06-19）
- `docs/research/ENGINE_DAEMON_PROTOCOL.md` — daemon/IPC 設計

### CLAP（context7 `/free-audio/clap`）
- Audio Ports Extension — <https://github.com/free-audio/clap/blob/main/_autodocs/api-reference/audio-ports-extension.md>
- Note Ports Extension — <https://github.com/free-audio/clap/blob/main/_autodocs/api-reference/note-ports-extension.md>
- Render & Latency Extension — <https://github.com/free-audio/clap/blob/main/_autodocs/api-reference/render-latency-extensions.md>
- CLAP GitHub リポジトリ — <https://github.com/free-audio/clap>

### DAW 公式・準公式リソース
- Ableton Live 12 Manual — <https://www.ableton.com/en/manual/ableton-live-intro-manual/>（Return Track・Send 説明）
- Ableton pre/post-fader 説明（forum） — <https://forum.ableton.com/viewtopic.php?t=168437>
- Pre-fader vs Post-fader 解説 — <https://www.musicguymixing.com/pre-fader-post-fader/>
- Logic Pro User Guide — <https://support.apple.com/guide/logicpro/welcome/mac>（Channel Strip signal flow）
- Logic Aux/Bus/Send の違い — <https://musictech.com/tutorials/logic-pro/using-bus-sends-and-aux-channels-in-logic-pro-x/>
- Aux vs Bus vs Send vs Return の区別 — <https://www.blackghostaudio.com/blog/the-difference-between-buses-auxes-sends-and-returns>
- Sound On Sound: Logic sends/buses/auxes — <https://www.soundonsound.com/techniques/logic-pro-sends-buses-auxes>
- Reaper User Guide — <https://www.reaper.fm/userguide.php>
- Reaper フレキシブルルーティング解説 — <https://www.audeobox.com/learn/reaper/routing-and-sends-guide/> / <https://reaper.blog/2016/06/audio-routing-explained/>
- Bitwig Studio Manual — <https://www.bitwig.com/support/documentation/>
- Pro Tools Reference Guide — <https://resources.avid.com/SupportFiles/PT/Pro%20Tools%20Reference%20Guide.pdf>
- PFL (Pre-Fader Listen) — <https://www.sweetwater.com/insync/pre-fade-listen-pfl/> / <https://www.soundonsound.com/sound-advice/q-what-do-solo-pfl-and-afl-do>
- Sidechain in Ableton — <https://www.gear4music.com/blog/how-to-sidechain-in-ableton-live/>
- DAW insert chain の order of operations — <https://www.izotope.com/en/learn/signal-chain-order-of-operations.html> / <https://www.izotope.com/en/learn/understanding-audio-signal-flow-in-a-daw.html>

> **注意**: DAW マニュアルの individual section permalink は「概略 URL のみ確認・セクション URL は未確認」とマークする。CLAP extension ドキュメントは context7 経由で一次情報確認済。forum / 教材サイトの URL は調査時点での確認済み。

### Rust ライブラリ
- `clack-host` crate — <https://docs.rs/clack-host/latest/clack_host/>
- `clack` GitHub — <https://github.com/prokopyl/clack>
- MeadowlarkDAW/Dropseed (CLAP ホスト実例) — <https://github.com/MeadowlarkDAW/Dropseed>

---

*本ドキュメントは post-2.0 roadmap 入力用リサーチであり、§2（アーキ確定済）を再設計するものではない。増分提案は確定アーキの範囲内での優先度提案。*
