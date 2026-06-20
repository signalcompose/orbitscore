# Post-2.0 エンジン方針 + ライセンス/配布/収益モデル

> **ステータス: 方向収束 + 次フェーズ・アーキ確定。post-2.0。2026-06-19 engine=Rust 決定 / 2026-06-21（Issue #298）楽器配置・fault・egress 確定 + ロードマップを「土台2本→改良層」に再優先順位化（§2.5）。** A0+S1+S1b（PR #294）+S2（PR #297）実装済。**土台 = ① VSCodium化（OrbitStudio・最初の /goal = 2.0.0 parity・先決）+ ② ネイティブエンジン（α #300〜）／ 改良層（β audio DSL⊇pitch・audio 機能）は土台の後**。`docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md`（Tracktion feasibility）の Tracktion 寄り結論を**本書が更新**する。

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

## 2. アーキテクチャ: 薄い permissive ホスト + 楽器は in-process / DSP・3rd-party は sandboxed plugin

> **2026-06-21 更新（Issue #298・本セッションで owner + advisor + CLAP 一次情報により再接地）**: 本節の結論「**楽器系 DSP は engine 内（in-process）**」は維持。ただし*根拠*を「MIDI 駆動 hosted plugin では表現が落ちる」→「**楽器は DSL 表現力の着地点だから flatten 境界（プロトコル/シリアライズ）を経由させない**」に置換する。理由: ホスト対象は **CLAP（≠MIDI 1.0）** であり、CLAP は `note_id` / `CLAP_PARAM_IS_MODULATABLE_PER_NOTE_ID`・`_PER_KEY` / note expression / sample-accurate `header.time` を持つ（context7 `/free-audio/clap` で確認）ので「MIDI 貧弱で表現が落ちる」という旧根拠は崩れた。配置・fault・egress・シーケンスを §2.1–2.5 に確定する。

### 2.0 薄いコア
- **engine core は薄く保つ**: 再生 / ミックス / ルーティング / スケジュール（実装済）。**transport を所有**。RT で自明な gain/pan までプラグイン化しない。

### 2.1 配置決定（決定軸 = DSL 表現力の着地点に flatten 境界を作らない）
- **楽器（サンプラー / audio DSL の楽器）= in-process（crown jewel・非交渉）**。楽器は DSL 表現力が着地する場所。in-process は表現力を「**自由に進化できる**」状態に保つ（engine の Rust 型を共有・wire format のバージョン管理不要・シリアライズ無し）。かつ自社 Rust なので**隔離の必要が無い**（守る必要のないコードに IPC 税をかけない）。
- **effects + 3rd-party = plugin（out-of-process sandbox）**。effects は audio-in→audio-out（DSL 表現の下流）なので plugin で良い。3rd-party（特に VST）は大量に使われ、その crash がアプリを殺すのは不可 → **プロセス境界で隔離**（C-ABI segfault はプロセス境界でのみ封じ込められる＝Bitwig/Studio One の標準）。
- **判定基準**: **DSL が per-note / per-slice 制御を要する → 楽器側（in-process）／ 純 audio→audio → effect・plugin 側**。注意: per-note pitch-shift・per-slice gain は "effect っぽい" が DSL の per-note 制御が要るので**楽器側**。
- **protocol ≠ placement（取り違え注意）**: 「MIDI を経由しない＝表現力を守る」のは*プロトコル*の話（CLAP リッチイベント / OrbitScore 拡張）で、in-process でも out-of-process でも達成できる（CLAP イベントは POD でシリアライズ可）。**in-process の真の利点は「表現力が自由に進化する＋税ゼロ」**であって表現力そのものではない。
- **OrbitScore CLAP 超集合（1st-party 用）**: 1st-party 楽器/FX は **standard CLAP + `com.orbitscore.*` ベンダ拡張**（`get_extension(id)` は文字列名前空間・未対応ホストは NULL で graceful degrade）。slice 番地 / sample-bank ロード / per-slice gain / time/fixpitch 等の「MIDI より豊か」な意味論を運ぶ。VST3 でも custom interface は可能だが重く、AUv3 は Apple の component モデルに縛られ難しい（**CLAP が一番素直**）。

### 2.2 fault は3層（α が floor）
- **① app が daemon の死を生存** = recovery floor（全部の前提・**§7 で α**）。現状: daemon に Rust panic hook→exit(1)+DaemonError はあるが、auto-respawn / session 復旧は未実装。
- **② daemon が 3rd-party crash を生存** = out-of-process sandbox（新規・未構築スパイク・**§7 で γ**）。
- **③ 1st-party in-process crash**（panic / `unsafe` / Signalsmith は C++）は **①の respawn でのみ捕捉** → in-process 楽器は①を*前提にする*（不要にはしない）。

### 2.3 audio DSL ⊇ pitch DSL（DSL 設計制約）
- audio DSL は **pitch DSL の全表現力 + audio 固有（slice/chop/stretch/per-slice）**。定義上 MIDI を超える → サンプラーが in-process である必然性の根拠。
- **pitch モデル（Track C / C1）は audio DSL の真部分集合として設計**する（後で上位互換にできなくなるのを防ぐ）。
- pitched synth は 12音 or（MIDI 2.0 の per-note pitch=微分音）に収まる限り**世の MIDI/MIDI2.0 プラグインで足りる**（CLAP note expression ≈ MIDI 2.0 on notes）。**超集合への投資を正当化するのはサンプラー/audio DSL であって synth ではない**。

### 2.4 egress（楽器を外に出さず、音を外に出す）
- **(A) 楽器 egress**（standalone VST/AU 出荷）: 超集合は VST/AU に渡らないので**標準サブセットに劣化** = §4 の別製品（CLAP 単体販売なら超集合を保持可）。standalone の (i)native /(ii)in-process超集合plugin の差は**load-bearing でない**（再利用資産は**共有 DSP crate**で、plugin shell は nih-plug が CLAP+VST3 を1コードベース、AU は別の発明）。**完全忠実度の楽器は OrbitScore がホストする経路にしか存在しない**（standalone は劣化版・§4 を過大評価しない）。
- **(B) 音 egress**（無劣化・engine は家のまま）:
  - **b1 薄い bridge プラグイン + standalone エンジン（主案）**: DAW のインストルメント位置に薄い conduit を置き、**ローカル点対点 共有メモリ IPC** で standalone エンジンの音を受ける（**システムのオーディオデバイスでないので aggregate device / 入力奪取が起きない**＝仮想デバイス〔BlackHole/Loopback〕の運用地獄を回避）。1 エンジン + N bridge（出力バス毎）。transport 3モード = **free-running/audio-only（MVP・同期なし）／ follower（bridge が DAW host transport を中継→エンジン追従）／ leader は standalone 専用（plugin 制約・defer。standalone は Link #283 で既にリーダー可）**。clock は pull 駆動 render で単一化（drift 無し）。
  - **b2 engine 埋め込みプラグイン（後付けオプション）**: DAW プロジェクトに丸ごと保存/recall・per-instance 状態・「プラグイン1個」配布が欲しい時。ただし nested hosting（プラグイン内で 3rd-party を out-of-process sandbox）・AUv3 sandbox/entitlement・packaging が重い（**CLAP/VST3 > AUv3**）。`engine = 分離した daemon` なので「IDE を plugin 化」でなく「**engine/daemon を plugin shell に埋め、editor は別アプリで接続**」（SynthesizerV の editor+plugin 同型）。
  - **LinkAudio** は **非 DAW / inter-app 補助**（live rig 同期等）に位置づけ降格（便利だが運用が重い）。
- **設計制約**: **engine を clean に埋め込み可能に保つ（daemon/engine ↔ editor の分離を崩さない）** — b2 の feasibility を担保する。今すぐ作る話ではなく「壊さない」制約。

### 2.5 ロードマップ（2026-06-21 owner 再優先順位化 = 土台2本 → 改良層）
**今後の様々な改良が載る土台は2本: ① VSCodium化（OrbitStudio）+ ② ネイティブ音声エンジン。** DSL 拡張・audio 機能は**土台が成ってから**（今の `.orbs` DSL は表現力として充分・急がない・やる時はそれに集中する）。

- **土台① OrbitStudio（VSCodium）→ 2.0.0 parity（近期 focus・先決）**: 既存 SC スタックで動くアプリを VSCodium で（Track B / B1 rebrand rebuild）。**engine 非依存**（2.0.0 は SC 既定）なので ② と別コードベース＝並行可だが、focus は ① に置く。
- **土台② ネイティブ音声エンジン（Rust）**: S1/S2 済 → **α recovery floor（fault ①・issue #300）** → 成熟（**γ out-of-process sandbox（fault ②・3rd-party + effects）** → **δ 3rd-party VST3/AU** → 既定 cutover #108）。
- **改良層（土台の後・集中して）**: **β audio DSL ⊇ pitch DSL（+ #213 `fixpitch()`/`time()`・in-process・C1 pitch spec 先行が前提）** / audio 機能（slice #239 / audio `[ ]` #238）。
- **旧版（α→β→γ→δ 一直線）からの変更**: **VSCodium を土台として前倒し**（master plan の「Track B は engine の後（A1–A2 後）」を撤回）/ **β を改良層へ後置**（engine 土台が成る後）。fault と features-as-plugin の分離性は維持（staging の自由度）。

### 2.6 売り物化 = DSP を共有 crate に
- stretch / sampler DSP を再利用可能 crate にし、**engine ノード（DSL 駆動・in-process）**と、任意の **standalone サンプラー製品（MIDI/標準駆動・他 DAW・単体販売）**の2フロントエンドで共有。engine を plugin 境界に通さずに製品も作れる。1st-party プラグイン shell = **nih-plug（Rust・ISC・CLAP+VST3 を1コードベース）**。

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
- **2.0.x patch は `main` でなく `v2.0.0` タグから分岐する**。背景: `v2.0.0` タグ=パッチ anchor / `.vsix` は main でも 2.0.0（post-2.0 は additive・opt-in）/ 2.0.x ブランチは未作成（タグ+規律で十分・実 patch 時に `v2.0.0` から切る。空ブランチを今作らない）。
- **pitch/song 再設計はアプリ優先**、必要なら `.vsix` に backport（VS Code 利用者カバーは二次目標）。
- 命名: **OrbitScore = 言語（拡張でもアプリでも中で生きる）/ OrbitStudio = 専用アプリ（候補名）**。移調は `transpose()`（`transport` は再生ヘッド連想で不可）。

## 7. 次の一手（スパイク完了 → 土台2本 → 改良層・§2.5 と同一）

**完了**: feasibility research（`docs/research/RUST_PLUGIN_HOSTING.md`）→ **A0+S1+S1b（PR #294）= CLAP hosting が RT 安全に成立**（in-process clack-host）→ **S2（PR #297）= daemon dispatch seam parity**。詳細 `POST_2.0_A0_RT_INTEGRATION_DESIGN.md`。

**土台層（先に作る・両方が改良の土台）**:
- **① OrbitStudio（VSCodium）→ 2.0.0 parity（近期 focus・先決・最初の `/goal`・issue #301）** — 既存 SC スタックで動くアプリを VSCodium で（Track B / B1 rebrand rebuild）。engine 非依存。未確証 = VSCodium で既存 .vsix/extension を動かす形 / VST GUI の Electron 共存（着手時に feasibility）。
- **② ネイティブ音声エンジン（Rust）** — ①と並行可（別コードベース）。S1/S2 済 →
  - **α recovery floor（fault ①・issue #300）** — daemon supervision + auto-respawn + 最小 recovery contract（接続再確立 + active loops 復帰 / 可聴ギャップ許容 / one-shot drop / transport 再 anchor）。Done = fault-injection kill-test（kill -9 + 故意 segfault プラグイン〔S1b misbehave synth 拡張・再利用〕で liveness + 復旧後 correctness〔transport desync・orphaned play_id 無し〕）+ 既存テスト全緑 / SC 既定無改変。
  - **γ out-of-process sandbox（fault ②）** — 3rd-party + effects 隔離。shared-mem audio / RT-safe event IPC / watchdog→respawn / +~1 block latency。**最大の未構築サブシステム**。
  - **δ 3rd-party VST3/AU** — 成熟度順（AU `objc2-avf-audio` / VST3 `vst3` crate MIT・工数最大）。
  - 既定 cutover（#108・Rust を default audio backend に）。

**改良層（土台の後・集中して）**:
- **β audio DSL ⊇ pitch DSL** — `#213 fixpitch()/time()`（今 stub）含む。in-process・S1 基盤。**C1 pitch モデル spec 先行が前提**（pitch を audio の真部分集合に）。
- audio 機能: slice #239 / audio `[ ]` #238。
- **egress**（§2.4）: b1 bridge プラグイン主案 / b2 engine 埋め込み（後付け）/ LinkAudio は非DAW補助。

**別途調査(open)**: time-stretch Signalsmith の Rust binding（`ssstretch`/`signalsmith-stretch`・詳細未確認）/ 配布（App Store sandbox・notarize/Steam）/ γ out-of-process・b2 engine-as-plugin の feasibility。

## 8. Caveats
- 既存 Rust engine は PoC（v0.0.1・Mutex・stretch 無し）。「foundation 済」であって「完成」ではない。
- **in-process** CLAP hosting は S1/S1b で実証済（PR #294）。**out-of-process sandbox（γ）は未構築の別スパイク**（「DAW では解決済み」は業界の話で本リポジトリには無い）。b2 engine-as-plugin も着手時に feasibility が要る。
- Fair Trade License の具体条項が engine の扱いを最終的に規定する。

---

関連: [[POST_2.0_ROADMAP_NOTES]] / [[POST_2.0_PITCH_MODEL_NOTES]] / `docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md`（本書が Tracktion 結論を更新）/ `docs/research/ENGINE_DAEMON_PROTOCOL.md` / #210 / #213。
