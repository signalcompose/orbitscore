# 設計: PDC → layer → instrument ラック、note-off flush、標準プラグイン（#606 / #634 / #635 / #636 / #669）

**対象 issue**: #606（RUN 終端の note-off 不達・`must-fix`）/ #634（PDC・`foundation`）/ #635（`layer()` 適用・`release-gate`）/ #636（instrument ラック・`release-gate`）/ #669（標準プラグイン・`release-gate`）
**関連**: #628（ラック機構・CLOSED・出荷済み）/ #588（`host.rs` の「+1 block 均一」doc 誤り・#634 に統合）/ #598 コメント 4・6（オフラインレンダの終端も #606 の経路）/ #409（`outs:` マルチアウト・接続点のみ）/ #522（カタログ param・スコープ外）/ #474（プラグイン UI・`chain_path`）
**正本**: `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.10 / `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` PH.4「All Notes Off」/ `docs/specs-v2/PITCH_DSL_SPEC_v1.1.md` §7 rule 2（本書は spec 改訂案を §12 に含む。実装より先に spec を直す）
**状態**: 設計（実装しない）・2026-09-03・main `ca176f0` 実測

---

## 0. 確定事項（再議論しない）

| # | 事項 | 出どころ |
|---|---|---|
| 1 | **順序**: {#606, #634} → #635 → #636。#669 は独立（ラックに乗るだけ） | 地図 §4.B / #635 本文 / #636 本文 |
| 2 | `[...]` は常に直列・並列は常に `layer([...])`。深さや文脈で意味を変えない | SC.10.1 規範 1 |
| 3 | `enabled: false` は**その合成の単位元** — 直列は素通し・**並列は無音** | SC.10.2 |
| 4 | ラックは**値**（レシピ）。適用時に起動し、インスタンスは共有されない | SC.10.4 |
| 5 | 再評価は **LCS** で対応づけ、出現順は**インスタンスに固定**（テキストから数え直さない） | SC.10.5 |
| 6 | instrument を裸の配列に複数並べるのは**明示エラー**。並列は `layer` のみ | SC.10.6 規範 1 |
| 7 | instrument ブランチの無効化・削除は**強制 note-off の対象**。**#606 の機構を呼ぶ**（二重に作らない） | SC.10.6 規範 2 / core spec PH.4 |
| 8 | 標準プラグインは**同梱 CLAP**・**UI 無し**・**state ファイル無し**・パラメータは DSL が正 | SC.10.8 |
| 9 | 位置は 1 次元 index で指せない。UI は名前 + 「全部開く」/ Cmd+Click | SC.10.10 / SC.10.10.1 |
| 10 | #669 は **2 段階**: 段階 1 = DSL から 3 語を削除（先） / 段階 2 = 標準 CLAP として再構築 | #669 コメント 1（owner 2026-09-02） |
| 11 | RT に**確保・ロック・syscall を持ち込まない**。`audio` スレッドからログを出さない | `rack-child lib.rs:395-412` の既存規律 |
| 12 | `play()` の意味論は変えない | CLAUDE.md 運用規則 5 |

---

## 1. 到達点（1 文）

**`kick.effect([layer([[], ["Reverb"]])])` と `cb.instrument(layer([["Kontakt 8"], ["Serum"]]))` が実機で鳴り、ブランチ間の遅延はプラグインの申告レイテンシで補償され、一発 RUN が終わったら（そして `stop_engine` を送ったら、そしてオフラインレンダが終端に達したら）鳴っているノートに必ず note-off が届く。**

---

## 2. 現在地（一次情報・本書が変えるもの）

| 事実 | 根拠（`ca176f0` 実測） | 本書 |
|---|---|---|
| `layer` は**レシピまでは通る**が、適用の直前で staged エラー | `rack.ts:160-161`（recipe 生成）→ `effect-slot.ts:138-149`（effect）/ `rack.ts:288-291`（instrument） | §5 / §6 |
| wire の `StageSpec::Layer` は `branches: serde_json::Value`（**中身が型付いていない**）で、`enabled()` は常に `false` を返す | `rack_wire.rs:67` / `:73-76` | §5.3（🔴 一方通行） |
| rack child は `Layer` を **BAD_ARG で拒否**（初期ロード・APPLY の両方） | `rack-child lib.rs:550` / `:728` / `macos.rs:369` | §5.4 |
| `chain_path` は **要素 1 個のみ**受理。ネストは staged | `daemon-client.ts:213-218` / `session.rs:356-361` | §5.5（🔴 一方通行） |
| **`latency` を扱うコードが 1 行も無い**（`orbit-clap-host` / `orbit-vst3-host` / daemon / native） | `grep -rn latency` → `buffers.rs:247,261` の `AudioPortBuffer.latency: 0` と gated テスト名のみ | §4 |
| `LoadedVst3Info` に latency フィールドが無い | `orbit-vst3-host/src/lib.rs:234-240` | §4.2 |
| `LoadedPluginInfo`（CLAP）に latency フィールドが無い。`clack-extensions` の feature に `latency` が無い | `controller.rs:92-99` / `orbit-clap-host/Cargo.toml:27-36` | §4.2 |
| OOP insert は **stage ごとに +1 block** の遅延を入れる（`PipelinedEffectHost` は前ブロックの出力を読む） | `orbit-audio-sandbox/src/host.rs:1-10` / `output.rs:945-951`（`processor.process`） | §4.1（#588 の doc 訂正） |
| post-loop は配列順（トポロジカル順）で直列。leg ごとに段数が違えば遅延も違う | `output.rs:943-985` | §4.1 |
| RUN 終端の flush は **存在する**（地図 §4.B の「無い」は**誤り**・§9 に訂正） | `run-sequence.ts:60-63` → `sequence.ts:1015-1022` → `midi-scheduler.ts:211-213` → `plugin-note-output.ts:51-56` | §3.1（穴は別にある） |
| RUN 終端の `setTimeout` は**ハンドルを保持していない**（キャンセル不能・多重発火し得る） | `run-sequence.ts:60-63` | §3.2 |
| flush 時刻は `patternDuration`（現在時刻起点）だが、イベントは `currentTime + 100` 起点で並ぶ | `run-sequence.ts:54-63` | §3.2（末尾スロットが**消える**） |
| note-off は **黙って捨てられる経路が 2 本**ある（daemon 未接続 / `pluginActive !== true`）。いずれも `warnOnce`（プロセス 1 回だけ） | `rust-engine-player.ts:1286-1303` | §3.3 |
| daemon は `active_plugin_notes` を**追跡しているが一度も読まない**（宣言・初期化・insert・remove の 4 箇所のみ） | `engine_wrap.rs:1616-1617` / `:4757` / `:7157` / `:7187` | §3.4 |
| daemon に **all-notes-off 相当の RPC が無い**（`StopAll` はサンプル再生の停止） | `session.rs` メソッド表（`:1298`-`:2282`）/ `engine_wrap.rs:8002-8006` | §3.4 |
| daemon に **SIGTERM/SIGINT ハンドラが無い**。`Supervisor::Drop`（`CONTROL_QUIT`）が走らず child が孤児化し得る | `orbit-audio-daemon/src/main.rs:21-29`（既知事項として明記） | §3.5（本書のスコープ外・防御は `ParentWatch` 250 ms） |
| `shutdown()` は `global.stop()` の note-off（fire-and-forget）と `audioEngine.quit()` / `process.exit(0)` を**待ち合わせない** | `shutdown.ts:33` / `:70` / `:76`・`plugin-note-output.ts:75-86` の `void` | §3.3 |
| `compressor` / `limiter` / `normalizer` は語彙にあり、実行すると `warnOnce` + no-op | `runtime.ts:29-31` / `global.ts:619-639` / `effects-manager.ts:110-179` / `rust-engine-player.ts:1379-1388` | §7 |
| **3 語を書いている `.orbs` は 1 本だけ**（コメントアウト以外）: `test-assets/scores/test-all-features.orbs:112,115,118,121,122,123`。`test-mastering-effects.orbs` と `examples/performance-demo.orbs` は**全行コメント** | `grep -rn "compressor\|limiter\|normalizer" --include=*.orbs .`（§9 に貼付） | §7.1 |
| core spec は 3 語を**機能一覧に記載している**（#669 本文の「リファレンス未記載」は core spec には当たらない） | `INSTRUCTION_ORBITSCORE_DSL.md:1874-1876`（機能一覧）/ `:1242`（PH.2 の参照）/ `:1991`（changelog・履歴なので触らない） | §12 |
| 標準プラグインの解決は `<child exe>/std-plugins/<name>.clap`、`ORBIT_STD_PLUGIN_DIR` で上書き | `rack-child lib.rs:86-101` / `macos.rs:239` | §7.2 |
| `Gain` 以外の標準プラグイン名は**明示エラー**（TS 側で弾かれ、wire に出ない） | `rack.ts:124-131` | §7.3 |
| ブロックは**インターリーブ stereo**、`MAX_FRAMES = 4096` / `CHANNELS = 2` / `BUF_LEN = 8192` | `orbit-audio-sandbox/src/transport.rs:56-60` | §4.3 |
| instrument slot pool は既定 8・最大 32、instance 名は `plugin:<seqName>` | `outproc_instrument.rs:87-89` / `sequence.ts:1409-1420` | §6 |
| `SetSourceRouting(source, unit, target)` は既にあり、`unit` は 0 固定で使われている | `session.rs:240-258` / `sequence.ts:724-757`（`unit` を 0 に固定するコメントは `:727`） | §6.4（#409 の接続点） |

---

## 3. #606 — note-off を届ける経路を 1 本にする

### 3.1 「機構は在るのに効かない」— 穴は 4 つ

配送機構そのものは在る。**owner ごとの flush**（`MidiScheduler.clearOwner` → `PluginNoteOutput.releaseOwner`）と**全体 panic**（`MidiScheduler.stop` → `panic`）の 2 つで、RUN 終端も `stop()` も前者を通っている。壊れているのは**その周り**である。

| # | 穴 | 根拠 | 帰結 |
|---|---|---|---|
| **H1** | RUN 終端の `setTimeout` はハンドルを持たない。`stop()` も再 RUN もキャンセルできず、**古いタイマが新しい RUN のノートを消す** | `run-sequence.ts:60-63`（返り値を捨てている） | 尻切れ。逆に「flush が来る保証」も無い（プロセスが先に落ちれば来ない） |
| **H2** | flush 時刻の原点がイベントの原点と **100 ms ずれている** | `:55` `currentTime + 100` と `:59-63` `patternDuration`（現在時刻起点） | 末尾 100 ms のスロットは**キューから消され、鳴らない**（鳴り残しではないが仕様違反） |
| **H3** | note-off が**黙って捨てられる**経路が 2 本。しかも `warnOnce` なのでプロセスで 1 回しか出ない | `rust-engine-player.ts:1286-1292`（daemon 未接続）/ `:1293-1303`（`pluginActive !== true`） | note-on は届いて note-off は届かない = **鳴りっぱなし**。ログにも 1 回しか残らない |
| **H4** | engine が死ぬと flush の**最後の砦が無い**。daemon は active note を持っているのに読まない | `engine_wrap.rs:1616-1617` ほか 3 箇所のみ / all-notes-off RPC 無し | `stop_engine`（SIGTERM）後も child が鳴り続ける。#606 の「kill -9 でしか止まらない」と整合 |

**H3 と H4 が #606 の本体**である。H1/H2 は同じ関数を直す時に一緒に閉じる。

### 3.2 設計 — 責務を 3 層に分け、層をまたいで二重に作らない

| 層 | 責務 | 単位 | 実装 |
|---|---|---|---|
| **TS scheduler** | 音楽的な解放。「この owner の保留ノートを解放する」 | owner（シーケンス名） | 既存 `MidiScheduler.clearOwner` を**そのまま使う**。新設しない |
| **daemon** | 最後の砦。「この instance の active note を全部落とす」 | instance（`plugin:<seq>`） | **新設**（`PluginAllNotesOff`）。既に持っている `active_plugin_notes` を読む |
| **child** | 触らない | — | note-off イベントは既存の ring / `NeutralEvent::NoteOff` で届く。新しい経路を作らない |

🔴 **child に flush を置かない理由**: child は自分が受けた note の簿記を持たない（`VoiceAddr` を右から左へ流すだけ）。持たせると簿記が 2 箇所になり、`(port_index, channel, key)` 参照カウント（core spec PH.4）の正本が割れる。

### 3.3 TS 側 — 終端を 1 つの関数に集約する

```ts
// packages/engine/src/core/sequence/playback/run-sequence.ts
export interface RunSequenceOptions {
  // …既存…
  /** 🔴 追加: 終端タイマのハンドルを呼び出し側へ渡す（保持・キャンセル可能にする）。 */
  setRunTimerFn: (timer: NodeJS.Timeout | undefined) => void
}
```

```ts
// run-sequence.ts — H1 / H2 の修正
const scheduleTime = currentTime + 100
scheduleEventsFn(scheduler, 0, scheduleTime)
const patternDuration = getPatternDurationFn()
// H2: イベントの原点（+100ms）と終端の原点を揃える。RUN_TAIL_GUARD_MS は「最後の
// note-off が発火してから閉じる」ための余白で、gate=1.0（スロット全長）でも取りこぼさない値。
const timer = setTimeout(() => {
  setRunTimerFn(undefined)
  clearSequenceEventsFn(sequenceName)
  console.log(`⏹ ${sequenceName} (finished)`)
}, 100 + patternDuration + RUN_TAIL_GUARD_MS)
setRunTimerFn(timer)   // H1: 保持する
```

`Sequence.stop()`（`sequence.ts:1774-1795`）は `loopTimer` と同じ扱いでこのタイマを `clearTimeout` する。**`stop()` が先に来たら終端タイマは走らない**（`clearEvents` は `stop()` 側が既に呼ぶ）。

🔴 `RUN_TAIL_GUARD_MS` の値は**推測で置かない**。`gate` の既定と `applyGateAndLegato`（`sequence.ts:1492-1503`）が作る最大 offTime から**導出**する（= `patternDuration * maxGate` の超過分）。導出できない残差があれば §15 に上げる。

### 3.4 daemon 側 — `PluginAllNotesOff`（最後の砦）

```rust
// rust/crates/orbit-audio-daemon/src/engine_wrap.rs
#[cfg(all(feature = "outproc-instrument", not(feature = "clap-host")))]
pub fn plugin_all_notes_off(&self, instance: Option<&str>) -> Result<usize, WrapError> {
    // 1. 追跡集合から対象を取り出す（instance=None は全 instance）。
    // 2. 各 (name, channel, key) へ NeutralEvent::NoteOff を push する。
    // 3. push に成功した分だけ集合から除去する（失敗分は残し、件数と共に Err）。
    // 返り値 = 送出した note-off の件数。
}
```

- **`active_plugin_notes` を読む唯一の場所**になる（現在 0 箇所）。「追跡しているのに使わない」状態が消える
- `#[cfg(feature = "clap-host")]`（in-process 経路）は追跡集合を持たないので、**同シグネチャの stub が `Err(ClapUnavailable)` を返す**。`plugin_note_on` / `plugin_note_off` が既に 3 象限の cfg 分岐を持っている（`:7089` / `:7118` / `:7166` / `:7300` / `:7315`）ので、**同じ 3 分岐に 1 本足す**だけ
- RPC は `session.rs` に `"PluginAllNotesOff"` を 1 本追加。`plugin_note_spec`（`:2354-2379`）は key/channel を要求するので**そこには入れない**（引数の形が違う）
- **`StopAll` に相乗りさせない**。`StopAll` はサンプル再生の停止（`engine.stop_all()`）で、意味が違う。相乗りさせると「サンプルを止めたら音源も止まる」という規則が spec のどこにも無い状態で生まれる

**TS からの呼び出し**は `AudioEngine.pluginAllNotesOff?(instance?: string): Promise<number>` を 1 本足し、`PluginNoteOutput.panic()` / `releaseOwner()` の**後**に呼ぶ（TS 側の簿記で落ちなかったものを daemon 側の簿記が拾う。二重 note-off は無害 — 受信側に該当声部が無いだけ・core spec PH.4 が既に明記）。

🔴 **H3 の握り潰しを直す**: `rust-engine-player.ts:1286-1303` の 2 つの早期 return は、**note-off に限っては `warnOnce` ではなく毎回 `console.error`** にする（note-on の drop は次の音が出ないだけだが、note-off の drop は**鳴りっぱなし**という復旧不能な状態を作る。同じ抑制ポリシーで扱ってはいけない）。

### 3.5 `stop_engine` の順序（#606 の「期待」2 行目）

`stopEngine()`（`extension.ts:2204-2251`）は SIGTERM を送り 2 秒後に SIGKILL する。engine 側 `shutdown()`（`shutdown.ts:29-77`）は現在 `global.stop()` → snapshot → `audioEngine.quit()` → `process.exit(0)` の順で、**note-off は `void` で投げっぱなし**（`plugin-note-output.ts:75-86`）。

```ts
// shutdown.ts — 順序を「note-off flush → daemon quit」に固定する
for (const global of globals) global.stop({ autoSnapshot: false })
// 🔴 追加: TS 簿記の note-off が daemon まで届いたことを待つ。届かなくても quit へ進む
//    （待つのは順序の保証であって成功の保証ではない）。
await Promise.allSettled(globals.map((g) => g.flushAllNotesOff()))
// …snapshot…
await audioEngine.quit()
```

`Global.flushAllNotesOff()` は `midiManager.panic()` を呼んだうえで `audioEngine.pluginAllNotesOff?.()` を await する 1 メソッド。**daemon に SIGTERM ハンドラを足すのは本書のスコープ外**（`main.rs:21-29` が #448 として既知事項に挙げている。防御は child 側 `ParentWatch` の 250 ms — `parent_watch.rs:23`）。

### 3.6 オフラインレンダの終端（#598 コメント 4 / 6）

`RenderScore` は現在ハンドラが `NOT_IMPLEMENTED` を返す（#598 P1 の想定終端）。P2 で `OfflineRenderSession` を作る時、**その終端で `plugin_all_notes_off` を呼び、その後さらに tail を回してから停める**。呼ぶのは §3.4 の同じ関数であって、レンダ専用の flush を作らない。

- レンダは transport 駆動（実時間ではない）なので、`setTimeout` ベースの §3.3 は使えない。**flush の発火点だけが違い、flush 自体は同じ**という形にする
- tail の長さは #598 の設計事項（本書では決めない）

---

## 4. #634 — PDC

### 4.1 遅延はどこで生まれるか（2 種類・混同しない）

| 種別 | 出どころ | 大きさ | 補償の場所 |
|---|---|---|---|
| **(a) プラグイン申告レイテンシ** | プラグインが自分で申告する（lookahead limiter・linear-phase EQ 等） | プラグイン依存・可変 | **rack child 内**（同じ child に全 stage が居る） |
| **(b) パイプライン遅延（+1 block）** | `PipelinedEffectHost` が前ブロックの出力を読む構造（`host.rs:1-10`） | ちょうど 1 block × 経路上の**アクティブな OOP stage 数** | **daemon / native の post-loop**（leg をまたぐ） |

🔴 **#588 の doc が誤っているのはここ**。「+1 block は最終 hw sum 全体に均一」は mixer graph 導入後は成り立たない。`seq→sum→master` は 1 段、`seq→sum→aux→master` は 2 段で、**leg 間に 1 block の差**が出る（#587 の実測）。#634 の PR で `host.rs:1-10` の doc を訂正する（#588 のチェックリスト）。

**本書の判断**: #635（`layer`）が必要とするのは **(a)** である（同一 child 内の並列ブランチ）。**(b) は #635 の前提ではない**（並列ブランチは同じ child の同じ block で処理されるのでパイプライン遅延が等しい）。したがって:

- **PR-C1 = (a) だけ**を作る → #635 が解放される
- **(b)** は #587 が実測した既存の欠陥であり、#635/#636 を塞いでいない。**PR-C2 として分ける**

### 4.2 測る — 申告レイテンシの取得

| format | API（一次ソース） | 現在地 |
|---|---|---|
| CLAP | `clap.latency` 拡張の `clap_plugin_latency.get(plugin) -> uint32_t`。ホストは `clap_host_latency.changed()` を受けて再問い合わせする | `clack-extensions` の feature に `latency` が**無い**（`orbit-clap-host/Cargo.toml:27-36`）→ 追加が要る。**clack 側の binding 名は一次ソースで確認すること**（本書は確認していない・§14） |
| VST3 | `IAudioProcessor::getLatencySamples() -> uint32`。変更は `restartComponent(kLatencyChanged)` で通知される | `vst3 = "0.3"` を使用（`orbit-vst3-host/Cargo.toml:23`）。呼び出し箇所はゼロ |

```rust
// orbit-clap-host/src/controller.rs — LoadedPluginInfo に 1 フィールド足す
pub struct LoadedPluginInfo {
    pub plugin_id: String,
    pub plugin_name: Option<String>,
    pub note_port_index: u16,
    /// 申告レイテンシ（サンプル）。拡張未実装なら 0。
    pub latency_samples: u32,
}
```

```rust
// orbit-vst3-host/src/lib.rs — LoadedVst3Info に同じ 1 フィールド
pub struct LoadedVst3Info {
    pub name: String,
    pub audio_inputs: i32,
    pub audio_outputs: i32,
    pub is_effect: bool,
    pub latency_samples: u32,
}
```

**ロード時に 1 回読む**（`setupProcessing` / `activate` の後・`setProcessing(1)` の前）。実行中の変更通知（`changed()` / `kLatencyChanged`）は **v1 では受けない** — 受けると RT 中にチェーンの再構成が要り、#628 の prepare-commit（block 境界で 1 回 swap）と衝突する。**通知が来たらログに残すだけ**にして、反映は「ラックを再評価すれば直る」に倒す（SC.5 の live 意味論と同じ姿勢）。この非目標は §12 で spec に書く。

### 4.3 補う — rack child 内の per-branch delay line

```rust
// rust/crates/orbit-effect-rack-child/src/lib.rs

/// 1 ブランチ分の固定長遅延。**構築時に確保し、process では絶対に確保しない**。
struct BranchDelay {
    /// インターリーブ stereo のリングバッファ（frames * CHANNELS）。
    buffer: Vec<f32>,
    write: usize,
    /// 遅延サンプル数（frames 単位・チャンネル数は掛けない）。
    frames: usize,
}

impl BranchDelay {
    /// 遅延 0 なら何もしない（bit 一致を守る）。
    fn process(&mut self, block: &mut [f32]) { /* 事前確保済みリングの読み書きのみ */ }
}

/// 並列ブランチの集合。`StageEntry` と同じ配列に並ぶ 1 要素。
struct LayerEntry {
    /// ブランチごとの直列 stage 列（空 = 素通しブランチ）。
    branches: Vec<Vec<StageEntry>>,
    /// ブランチごとの補償遅延（`max_latency - branch_latency`）。
    delays: Vec<BranchDelay>,
    /// ブランチごとの enabled。false は**無音**（合算に足さない・SC.10.2）。
    enabled: Vec<bool>,
    /// 合算用の事前確保スクラッチ（ブランチ数分・`BUF_LEN`）。
    scratch: Vec<Vec<f32>>,
}
```

**処理（audio スレッド・確保もロックも syscall も無い）**:

1. 入力ブロックを各ブランチの `scratch[i]` へ**コピー**（`copy_from_slice`）
2. `enabled[i] == false` のブランチは**スキップ**（`scratch` に触らない = 無音）
3. 有効なブランチだけ `branches[i]` を直列に回し、続けて `delays[i].process(&mut scratch[i])`
4. `block` を 0 で埋め、有効ブランチの `scratch[i]` を**加算**
5. **ラック自身の申告レイテンシ = `max_latency`**。これが上位（daemon）へ伝わる

🔴 **`enabled: false` を「遅延だけ通す」にしない**。SC.10.2 の単位元は「合算に何も足さない」であって「遅延した無音を足す」ではない。両者は音として同じだが、**ブランチを戻した時に位相が揃っている**必要があるので、`delays[i]` の**書き込みは enabled でも disabled でも進める**（リングを止めると再有効化時に古い音が出る）。この 1 点は実装の分かれ目なので明記する。

**上限**: `BranchDelay.buffer` は構築時に確保するので上限が要る。

```rust
/// 1 ブランチあたりの補償遅延の上限（frames）。
/// 🔴 値は実測で決める（§14）。超えたら **明示エラー**で apply を拒否し、プラグイン名と
///    申告値をエラー文に載せる。黙って切り詰めない（位相がずれた音は「動いている」ように見える）。
pub const MAX_PDC_FRAMES: usize = /* 実測して決める */;
```

### 4.4 (b) leg 間のパイプライン遅延（PR-C2・#588 の実体）

post-loop（`output.rs:943-985`）は配列順で直列に回る。stage `i` の出力が stage `j`（`j > i`）へ加算される時、`i` を通った信号は `j` を通っていない信号より **1 block 進んでいる**（`i` の processor が前ブロックを返すため）。

**補償の形**: 各 stage に「その stage へ到達するまでにいくつの OOP processor を通ったか」= `pipeline_depth` を構築時に計算し（トポロジは構築時に validate 済み・`validate_bus_topology`）、**深さの浅い leg に `max_depth - depth` block の遅延を入れる**。遅延は `InsertBusStage` が持つ既存の `buffer` と同じ寿命の事前確保リングでよい。

🔴 ただし `routing_override` / `send_gain_overrides` は**実行時に変わる**（`SetBusRouting`）ので `depth` も変わる。v1 は「構築時の静的トポロジで最大深さを取り、実行時の routing 変更では depth を変えない」に倒す（過補償はするが位相は揃う）。この保守側の選択は §12 で spec に書く。

**この節は #635 の前提ではない。** #587 の既存欠陥の解消であり、#634 の 2 本目の PR として独立に入れられる。

### 4.5 wire — ラックの申告レイテンシを上へ返す

child → daemon の返し口は既にある（`CommandOutcome.len` は state のバイト数に使われている）。**新しいフィールドを 1 つ足す**:

```rust
// orbit-audio-sandbox/src/rack_wire.rs
/// APPLY / 初期ロードの結果として child が返す、**チェーン全体の申告レイテンシ**（frames）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ChainReport {
    pub version: u32,
    /// チェーン全体（直列の和・layer は max）の申告レイテンシ。
    pub latency_frames: u32,
    /// stage ごとの申告レイテンシ（診断用。順序は plan の順序）。
    pub stage_latency_frames: Vec<u32>,
}
```

`ApplyEffectChain` の応答へ `latency_frames` を足し、TS 側は**ログに出すだけ**（v1）。「見えないものは直せない」— #662 の姿勢に揃える。

### 4.6 cfg 4 象限

`bash scripts/check-cfg-matrix.sh` の 4 象限（`default` / `outproc-effect` / `outproc-instrument` / 両方）で、本 PR が触るのは:

| 象限 | 影響 |
|---|---|
| `default` | `rack_wire` の型追加のみ（serde）。ビルドが通ること |
| `outproc-effect` | rack child・`ApplyEffectChain` 応答・post-loop 遅延 |
| `outproc-instrument` | `plugin_all_notes_off` の実体（§3.4）。PDC は無関係 |
| 両方 | 上記が同時に成立すること |

🔴 `plugin_all_notes_off` は **3 分岐すべてに書く**（`clap-host` / `outproc-instrument` / どちらも無し）。既存の `plugin_note_off` が 3 分岐を持っている（`:7118` / `:7168` / `:7315`）ので、片方だけ足すと 1 象限がビルド不能になる。

---

## 5. #635 — `layer()` を実際に並列で走らせる

### 5.1 「レイヤー」の定義（issue から）

> `[...]` = **直列**（どこでも同じ意味）/ `layer([...])` = **並列**（#635 本文）

**並列 = 同じ入力ブロックを各ブランチが独立に処理し、その出力を加算する。** ブランチは直列チェーン（`[...]`）であり、空配列 `[]` は素通しブランチ。`layer` の中に `[...]`、`[...]` の中に `layer` が入れ子になり得る（#635 受け入れ基準 3）。

**PDC への依存**（明示）: ブランチの申告レイテンシが違うと、加算がコムフィルタになる（SC.10.11）。したがって **#634 の (a) が入っていない限り #635 は入れられない**。逆に (b)（leg 間のパイプライン遅延）は `layer` の内側では発生しない（同じ child の同じ block）ので、**#635 の前提ではない**。

### 5.2 TS — レシピを解決する

`rack.ts:160-161` は今 `layer` を未解決のまま `{ kind: 'layer', source: ValueCall }` で運んでいる。これを解決する。

```ts
// packages/engine/src/signal-chain/rack.ts
export interface LayerRackRecipe {
  readonly kind: 'layer'
  /** ブランチの列。各ブランチは直列チェーン（空配列 = 素通し）。 */
  readonly branches: readonly RackRecipe[]
}
```

`resolveCall` の `case 'layer'` は「位置引数がちょうど 1 個の配列」を要求し、その各要素を `resolveRackValue` で再帰解決する（`chain()` と同じ形）。`layer()` の名前付き引数は v1 では受理しない（`enabled:` はブランチ側に書く）。

`effect-slot.ts` 側は `RackElementSpec` に `LayerElementSpec` を足し、`resolveEffectRack`（`:133-172`）を**再帰**にする。`:138-149` の 2 つの staged throw が消える。

🔴 **LCS の対応づけ**（SC.10.5）は `elementToken`（`effect-slot.ts:248-252`）が決めている。`layer` のトークンは **`layer:<ブランチ数>:<各ブランチのトークンを連結したハッシュではなく、ブランチトークン列そのもの>`** とし、**構造が同じなら keep、違えば load** にする。ブランチ内部の差分対応づけ（「layer の 2 本目のブランチの 3 番目だけ差し替え」）は **v1 ではやらない** — `layer` 単位で load し直す。これは #628 が「同名プラグインの並べ替えは表現できない」（SC.10.5 規範 5）で受け入れたのと同じ種類の割り切りで、**state は失われない**（drop 時に自動保存され、再ロード時に復元される）。§12 で spec に書く。

### 5.3 wire — `StageSpec::Layer` に型を付ける（🔴 一方通行）

```rust
// rust/crates/orbit-audio-sandbox/src/rack_wire.rs
    /// 並列ブランチ。各ブランチは直列の stage 列（空 = 素通し）。
    Layer {
        branches: Vec<Vec<StageSpec>>,
        #[serde(default = "enabled_by_default")]
        enabled: bool,
    },
```

`StageSpec::enabled()`（`:73-76`）の `Self::Layer { .. } => false` を `*enabled` にする。`params()` は空のまま。

**互換**: 現行の `branches: serde_json::Value` は **TS 側が一度も送っていない**（`effect-slot.ts:138` が先に throw する）ので、実運用の互換負債は無い。ただし wire の形が変わるので **daemon と child を同時に更新する**（`rack_wire` が両側の唯一の型定義なので、モジュール冒頭が警告している「片方だけ直して忘れる」は構造的に起きない）。

### 5.4 rack child — `Layer` を受理する

`lib.rs:550` / `:728` / `macos.rs:369` の 3 つの拒否を外し、§4.3 の `LayerEntry` を作る。

- `StageEntry` を `enum ChainNode { Stage(StageEntry), Layer(LayerEntry) }` にする。`StageList.entries: Vec<ChainNode>`
- `AudioChain::process_block`（`lib.rs:395-425`）は `ChainNode` を辿るだけ。**`adopt_at_block_boundary` / retire / 世代管理は一切変えない**（#628 の不変条件をそのまま継承する）
- `active_stage: &AtomicU32`（診断用の現在 stage）はネストで 1 次元 index が意味を失う。**`layer` に入ったら親の index を保つ**（今の値の意味を壊さない）
- `ControlStage` の `set_index` / `ui_is_settled` / `tick_ui` はブランチ内の stage にも**再帰で**行き渡らせる（`RackController::tick_ui` の 2 つのループ・`lib.rs:873-880`）

### 5.5 `chain_path` のネスト（🔴 一方通行）

`daemon-client.ts:213-218`（要素 1 個を強制）と `session.rs:356-361`（`path.len() > 1` を拒否）を外し、**任意長のパス**にする。`[i]` = トップレベル i 番目、`[i, b, j]` = i 番目の layer の b 番目のブランチの j 番目。

`rust-engine-player.ts:1231`（`target.chainPath?.[0] ?? 0`）と `global.ts:105` / `:899` も同時に直す（`pluginChainPathFor` が「唯一の写像」と宣言している以上、**そこ 1 箇所で完結させる**）。

### 5.6 スコープ外（#635 では触らない）

- **instrument の layer**（#636）
- **カタログ param**（#522）
- **`preset:`**（#522）
- **leg 間の (b) 補償**（#634 PR-C2）

---

## 6. #636 — instrument ラック

### 6.1 形

```js
cb.instrument(layer([
  ["Kontakt 8"],
  ["Serum", Gain(db: -6)],
]))
```

1 つの `play()` パターンが N 個の音源を駆動する。ブランチは `[音源]` または `[音源, effect…]`（音源を直列に繋ぐ意味は無いので、**1 ブランチに音源は 1 つ**）。

### 6.2 実装の形 — instrument slot を N 本使い、既存の単一経路はそのまま

`#636` の「触ってはいけないもの」に従う。**`PluginInstrumentManager` / instrument slot pool / `ReplacePlugin(instrument)` の単一 instrument 経路は無変更**で、layer は**その上に**載る。

| 要素 | 形 |
|---|---|
| ブランチ b のインスタンス名 | `plugin:<seqName>#<b>`（b=0 は既存の `plugin:<seqName>` と**同一**にする） |
| slot 確保 | 既存 pool（既定 8・最大 32・`outproc_instrument.rs:87-89`）から 1 ブランチ 1 slot |
| note 配送 | `PluginNoteOutput` が**1 note-on を N 回**送る（port を b ごとに変える）。`activeNotes` は port を含むので**簿記はそのまま**（`plugin-note-output.ts:33`） |
| ブランチの effect | ブランチ内の effect は **rack child の layer ではない**。instrument は音源なので、その後段の effect は**そのブランチ専用の insert bus** を要求する。v1 は **1 ブランチ = 1 insert bus**（`SetSourceRouting("plugin:<seq>#<b>", 0, bus)`）で表現する |
| 合流 | 各ブランチの insert bus が同じ宛先（seq の insert bus / master）へ加算される。**加算は既存の post-loop がやる**（新設しない） |
| PDC | 音源ごとに申告レイテンシが違う（#636 前提）。ブランチが**別の bus**に乗るので、これは §4.4 の **(b) leg 間補償**と同じ機構で解く |

🔴 **b=0 を既存名と同一にする理由**: `instrument("X")` は `instrument(layer([["X"]]))` と等価でなければならない（SC.10.6 の単要素縮退・`rack.ts:292-296` が既にそう扱っている）。名前を変えると state ファイル名（`[receiver, role, normalizedName, occurrence]`）が変わり、**既存セッションの音色が読めなくなる**。

### 6.3 ブランチ無効化・削除 = 強制 note-off（受け入れ基準 2）

```ts
// packages/engine/src/core/global/plugin-instrument-manager.ts（またはその呼び出し元）
// ブランチ b を無効化 / 削除する直前に、そのブランチだけを止める。
await this.audioEngine.pluginAllNotesOff?.(`plugin:${seqName}#${branchIndex}`)
```

**#606 の §3.4 で作る関数をそのまま呼ぶ。** note-off 配送機構を二重に作らない（core spec PH.4 の 🔴 注記・#636 受け入れ基準 2）。

発火順序は **note-off flush → ブランチ無効化**。逆にすると音源が消えてから note-off を送ることになり、届け先が無い。

### 6.4 #409（`outs:`）との接続点（**ここでは設計しない**）

`SetSourceRouting(source, unit, target)` の `unit` は今 0 固定（`sequence.ts:727` のコメントが「1-sequence/1-instrument モデルなので main output だけ」と明記）。**#636 は `unit` を触らない** — layer はブランチごとに**別の source 名**を使うので、`unit` は 0 のままでよい。

`outs:`（#409）は「**1 つの instrument の複数ポート**を別々の宛先へ」であり、layer は「**複数の instrument**」である。**軸が直交する**ので、`outs:` の設計（#409・`docs/design/611-output-line-design.md` §11）に依存しない。両者が同時に使われた時（`layer` のブランチが multi-out 音源）は `source = plugin:<seq>#<b>` × `unit = ポート` の直積になる。**この直積が成立することだけを確認し、実装は #409 が持つ。**

### 6.5 #598 P3（instrument offline）との接続点（**ここでは設計しない**）

オフライン駆動は instrument child を faster-than-realtime で回す。layer は「同じ note ストリームを N child へ送る」だけなので、**オフライン駆動の単位が 1 child から N child に増える**。#598 P3 の駆動ループが「instance の集合」を受ける形になっていればそのまま乗る。**確認だけして、実装は #598 が持つ。**

---

## 7. #669 — 標準プラグイン

🔴 **DSL 表面は owner 未決（§15 (1)）。以下は裁定に依存しない部分だけである。**

### 7.1 段階 1 — DSL から 3 語を落とす（裁定に依存しない・単独で入る）

| 触る場所 | 変更 |
|---|---|
| `packages/engine/src/signal-chain/runtime.ts:29-31` | `'compressor'` / `'limiter'` / `'normalizer'` を `GLOBAL_DSL_METHODS` から削除 |
| `packages/engine/src/core/global.ts:619-639` | 3 メソッドを削除 |
| `packages/engine/src/core/global/effects-manager.ts:102-180` | 該当実装を削除 |
| `packages/engine/src/audio/rust-engine/rust-engine-player.ts:1379-1396` | `addEffect` / `removeEffect` の no-op warn を削除（呼び出し元が消える） |
| `tests/e2e/dsl-e2e-coverage.spec.ts:89-101` | `GLOBAL_UNCOVERED_BASELINE` から 3 語を削除（**減らす方向なので許される**）。残さないと「語彙に無いのに未カバー扱い」の死んだ行になる |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:1873-1876` | 機能一覧から「Global Mastering Effects」節を削除。**`:1991` の changelog は履歴なので触らない** |
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:1242` | PH.2 の「global master effects（compressor / limiter / normalizer）と同じ役割分担」という参照を書き換える（参照先が消えるため） |
| `test-assets/scores/test-all-features.orbs:110-123` | 🔴 **実測: 唯一の実使用**（§9）。3 語の呼び出し行を削除する |

**削除後の挙動**: DSL 語彙から外れると `Unknown chain method` 系のエラー経路に乗る。🔴 **これを実機 E2E で確かめる**（#669 コメント 1）— 「黙って無視される形に落ちないこと」。#528 の `setDocumentDirectory` は**除外リストへの誤分類でユニットテストが緑のまま実行時だけ壊れた**ので、机上では判定できない。

### 7.2 段階 2 の機構（裁定に依存しない）

`orbit-std-gain` が完成形の手本になっている。**新 crate はその形をコピーする**。

| 要素 | `orbit-std-gain` の実装 | 新 crate |
|---|---|---|
| crate | `rust/crates/orbit-std-gain/`（`Cargo.toml` / `bundle-macos.sh` / `src/lib.rs` / `tests/contract.rs`） | 同一構成 |
| crate-type | `["cdylib", "rlib"]` | 同じ |
| 依存 | `clack-plugin` + `clack-extensions`（`audio-ports` / `params`） | 同じ |
| bundle | `bundle-macos.sh` が `PLUGIN_NAME` / `PLUGIN_ID` を **`src/lib.rs` から `sed` で読み出す**（片方だけ直し忘れる形を作らない） | 同じスクリプトを流用 |
| 解決 | child の exe の隣の `std-plugins/<name>.clap`。`ORBIT_STD_PLUGIN_DIR` で上書き（`rack-child lib.rs:86-101` / `macos.rs:239`） | 同じ（**解決規約は変えない**） |
| 契約テスト | `tests/contract.rs` が「UI を持たない」「state を持たない」「param 名が DSL の名前付き引数名と一致」を in-process host で検証 | 同じ 3 点 |

🔴 **param 名 = DSL の名前付き引数名**（`orbit-std-gain/Cargo.toml` 冒頭の 🔴 注記）。表面が案 1（`Compressor(threshold: …)`）でも案 2（`global.compressor(...)` 糖衣）でも、**CLAP param 名は同じ**にできるので、**crate は裁定を待たずに書ける**。

### 7.3 着手可能な範囲（裁定待ちに依存しない）

| 作業 | 依存 |
|---|---|
| 段階 1（削除） | 無し。**今すぐ入る** |
| 新 crate 3 本（DSP + contract テスト + bundle スクリプト） | 無し（DSL 表面に触れない） |
| ビルド・同梱の配線（`.app` へ 3 つの `.clap` を入れる） | 無し |
| **カタログ登録しない**ことの確認 | SC.10.8 規範 4「標準プラグインは言語の語彙として解決し、**カタログを引かない**」。`rescan_plugins` の結果に**出てはいけない**（出るとカタログ側と名前空間が衝突する） |
| `rack.ts:124-131` の `call.name !== 'Gain'` を 4 語（+3）へ広げる | 🔴 **表面の裁定に依存**（案 1 なら `Compressor` 等が要る・案 2 なら不要） |
| CLAUDE.md マージ前ゲートへの追加 | 無し（`bundle-macos.sh` を 3 本足すだけ。**条件分岐を付けない**） |

**中身の候補 `ShmKnd/Patina`**（地図 §4.B・C++17 標準ライブラリのみ・MIT）は**採用を決めない**。採るなら「C++ を ビルドに持ち込むか / Rust で書き直すか」の判断が要り、それは §15 (2)。

---

## 8. データの通り道を 1 本（端から端まで）

**`kick.effect(["A", layer([[], ["B"]])])` を評価してから音が出るまで:**

```
1. パーサ           ValueCall(layer) を含む ValueArray            parser/types.ts
2. レシピ解決       resolveRackValue → RackRecipe                 rack.ts:173-203（layer を再帰解決・§5.2）
3. 適用解決         resolveEffectRack → RackSpec                  effect-slot.ts:133-172（再帰化・staged throw 削除）
4. 差分             lcsPairs → PlanStage[]                        effect-slot.ts:255-288 / :586-653（layer トークン・§5.2）
5. wire             ApplyEffectChain { chain, save_dropped }      daemon-client.ts:538-547
6. daemon           <shm>.apply.json を書き CMD_APPLY_CHAIN       outproc_effect.rs
7. child prepare    RackController::apply → PreparedStage         rack-child lib.rs:629-824（Layer を受理・§5.4）
                      ├ ブランチごとに factory.load
                      ├ 各 stage の申告レイテンシを読む（§4.2）
                      └ max - 各ブランチ = BranchDelay.frames（§4.3）
8. child commit     ChainExchange::publish（1 回のポインタ公開）   lib.rs:284-295（**変えない**）
9. audio adopt      adopt_at_block_boundary（block 境界で 1 回）   lib.rs:356-392（**変えない**）
10. audio process   ChainNode を辿る → ブランチ並列 → 遅延 → 加算  lib.rs:395-425（§4.3）
11. 応答            ChainReport { latency_frames } をログへ        §4.5
12. post-loop       stage の buffer を宛先へ加算（leg 補償は C2）  output.rs:943-985
```

**`RUN(cb)` が終わってから音が止まるまで（#606）:**

```
1. run-sequence.ts:60-63   終端タイマ（ハンドル保持・原点を +100ms に揃える・§3.3）
2. sequence.ts:1015-1022   clearEvents → isInstrument なら getPluginScheduler()
3. midi-scheduler.ts:211   clearOwner: キューから owner を除去 → releaseOwner
4. plugin-note-output.ts:51 releaseOwner: activeNotes の owner 分へ note-off
5. rust-engine-player.ts:1285 pluginNoteOff（🔴 drop するなら毎回 error・§3.4）
6. daemon-client            PluginNoteOff RPC
7. engine_wrap.rs:7168      NeutralEvent::NoteOff を ring へ / active_plugin_notes から除去
8. child                    note ring から pop → プラグインへ
--- ここまでが正常系。以下が最後の砦（新設）---
9. global.stop() / shutdown / stop_engine → Global.flushAllNotesOff()
10. AudioEngine.pluginAllNotesOff() → RPC "PluginAllNotesOff"
11. engine_wrap.plugin_all_notes_off()  ← active_plugin_notes を**読む唯一の場所**
12. 残っていた分だけ NoteOff を ring へ
13. shutdown.ts: ここまで await してから audioEngine.quit()（§3.5）
```

---

## 9. 呼び出し元の全列挙（grep の出力を貼る）

**#669 の 3 語を書いている `.orbs`**（地図 §9 の未確認項目に対する実測）:

```
$ grep -rn "compressor\|limiter\|normalizer" --include=*.orbs .
./test-assets/scores/test-all-features.orbs:112:global.compressor(0.2, 0.9, 0.001, 0.03, 2.0, true)
./test-assets/scores/test-all-features.orbs:115:global.limiter(0.95, 0.01, true)
./test-assets/scores/test-all-features.orbs:118:global.normalizer(1.0, 0.01, true)
./test-assets/scores/test-all-features.orbs:121:global.compressor(0, 0, 0, 0, 0, false)
./test-assets/scores/test-all-features.orbs:122:global.limiter(0, 0, false)
./test-assets/scores/test-all-features.orbs:123:global.normalizer(0, 0, false)
./test-assets/scores/test-mastering-effects.orbs:2,22,28,31,34,36,39,43,50,56,57,59,60,62  ← すべて "//" コメント行
./examples/performance-demo.orbs:28,29,30                                                  ← すべて "//" コメント行
```

`.orbs` 総数 108 本のうち **実使用は `test-all-features.orbs` の 1 本だけ**。移行の手当ては**この 1 本の 6 行を消す**ことで尽きる。

**`active_plugin_notes` の全参照**（daemon 側 flush が「作る」ではなく「読む」だけである根拠）:

```
$ grep -rn "active_plugin_notes" rust/crates/orbit-audio-daemon/src/ packages/
rust/crates/orbit-audio-daemon/src/engine_wrap.rs:1617:    active_plugin_notes: Mutex<HashSet<(String, u8, u8)>>,   ← 宣言
rust/crates/orbit-audio-daemon/src/engine_wrap.rs:4757:            active_plugin_notes: Mutex::new(HashSet::new()),  ← 初期化
rust/crates/orbit-audio-daemon/src/engine_wrap.rs:7157:        self.active_plugin_notes                              ← insert（note-on）
rust/crates/orbit-audio-daemon/src/engine_wrap.rs:7187:        self.active_plugin_notes                              ← remove（note-off）
```

**読む箇所は 0 件。**

**`clearOwner` / `releaseOwner` の全呼び出し元**（RUN 終端の flush が「在る」根拠 = 地図 §4.B の訂正）:

```
$ grep -rn "clearOwner\|releaseOwner" packages/engine/src --include=*.ts | grep -v "\.spec\."
packages/engine/src/midi/midi-scheduler.ts:211:  clearOwner(owner: string): void {          ← 定義
packages/engine/src/midi/midi-scheduler.ts:213:    this.output.releaseOwner(owner)
packages/engine/src/midi/plugin-note-output.ts:51:  releaseOwner(owner: string): void {       ← 定義（plugin）
packages/engine/src/midi/rtmidi-output.ts:232:  releaseOwner(owner: string): void {          ← 定義（MIDI）
packages/engine/src/core/sequence.ts:1017:      …getScheduler().clearOwner(name)            ← MIDI 経路
packages/engine/src/core/sequence.ts:1019:      …getPluginScheduler().clearOwner(name)      ← instrument 経路
```

`sequence.ts:1015-1022`（`clearEvents`）の呼び出し元は `run-sequence.ts:49`・`:61`、`loop-sequence.ts:79`・`:181`・`:196`、`sequence.ts:1779`（`stop()`）・`:1809`（`mute()`）・`:1831`（`unmute()`）。

**`layer` の staged 拒否の全箇所**（#635 が外すもの）:

```
packages/engine/src/core/global/effect-slot.ts:140    effect ラック（第 1 段のガード）
packages/engine/src/core/global/effect-slot.ts:147    effect ラック（map 内の網羅性）
packages/engine/src/signal-chain/rack.ts:289          instrument ラック
rust/crates/orbit-effect-rack-child/src/lib.rs:550    child 初期ロード
rust/crates/orbit-effect-rack-child/src/lib.rs:728    child APPLY
rust/crates/orbit-effect-rack-child/src/macos.rs:369  StageFactory
rust/crates/orbit-audio-daemon/src/session.rs:359     chain_path のネスト
```

---

## 10. 失敗モード（握り潰される経路が無いこと）

| # | 失敗 | 現在 | 本書 |
|---|---|---|---|
| F1 | note-off が daemon 未接続で捨てられる | `warnOnce`（プロセス 1 回） | **毎回 `console.error`**。note-off の drop は復旧不能（§3.4） |
| F2 | note-off が `pluginActive !== true` で捨てられる | 同上 | 同上 |
| F3 | RUN 終端タイマが 2 重に走る | 起き得る（ハンドル未保持） | ハンドルを保持し `stop()` / 再 RUN でキャンセル（§3.3） |
| F4 | 末尾 100 ms のノートが鳴らない | 起きている（§3.1 H2） | 原点を揃える（§3.3） |
| F5 | daemon が SIGKILL され child が孤児化 | 起き得る（`main.rs:21-29`・#448） | **本書では直さない**。`ParentWatch` 250 ms が防御（明記して残す） |
| F6 | プラグインが latency 拡張を持たない | — | `0` として扱う（補償不要）。ログにも出さない（正常） |
| F7 | 申告レイテンシが `MAX_PDC_FRAMES` を超える | — | **apply を明示エラーで拒否**。プラグイン名と申告値をエラー文に載せる。黙って切り詰めない |
| F8 | 実行中に latency が変わった（`changed()` / `kLatencyChanged`） | — | v1 は**反映しない**。`tracing::warn!` で残し、「再評価で直る」を spec に書く（§12） |
| F9 | ブランチのロードが 1 本だけ失敗 | — | **layer 全体の apply を失敗させる**（#628 の prepare-commit: 旧チェーンが無傷で鳴り続ける）。部分成功を作らない |
| F10 | `layer` の中で `enabled: false` にしたブランチを戻したら位相がずれる | — | 無効ブランチでも `BranchDelay` の書き込みは進める（§4.3） |
| F11 | 3 語を削除したのに黙って無視される | 起き得る（#528 の再発型） | **実機 E2E で「明示エラーが出る」ことを見る**（§11 T5） |
| F12 | 標準プラグインがカタログにも出て名前が衝突 | — | `rescan_plugins` の結果に出ないことを E2E で確認（§11 T6・SC.10.8 規範 4） |
| F13 | rack child の apply が Busy を返し続ける | 既存（`lib.rs:642-648`） | 不変。layer を足しても `pending_stage_drops` の規律は同じ |

---

## 11. E2E（`tests/e2e/orbitstudio-mcp-gated.spec.ts` に足す・MCP ツールだけで駆動・`ok` に assert しない）

**共通**: `captureInstrumentScenario`（`:501-600`）の既存ハーネスを使う。判定は `rms(セグメント名)` と `countErrors(log) <= errorsBefore`。**ERROR 件数は `<=`**（固定 500 行窓）。

| # | 何を守るか | 駆動（MCP） | 判定（数値） |
|---|---|---|---|
| **T1** | **#606 一発 RUN の後に鳴り残しが無い** | `open_file` → `set_selection` → `run_selection` で `cb.instrument(<CLAP test synth>)` + `cb.play("1 2 3 4")` + `RUN(cb)`。パターン長 + 余白の後にセグメントを取る | RUN 中のセグメント `rms > 0`、**終端後のセグメント `rms` が開始前の無音セグメントと同程度**。CLAP test synth は note-off が来るまで `sin` を出し続ける（`rust-spike/clap-test-synth/src/lib.rs:295-311`）ので、届かなければ必ず捕まる |
| **T2** | **#606 `stop_engine` が音を止める** | T1 と同じ譜面を `LOOP` で走らせ、`stop_engine` → `waitForEngine(false)` | 停止後にキャプチャが伸びていないこと + 停止前後の `rms` 比。`get_log` に F1/F2 の error 行が無いこと |
| **T3** | **#634 PDC が効いている（相対オラクル・閾値を発明しない）** | 同一 `.orbs` を 2 回走らせる。1 回目はテスト用 CLAP effect の申告レイテンシを **0**、2 回目を **N**（fixture 側の env で切替）。譜面は `kick.effect([layer([[], ["<CLAPTestEffect>"]])])` | **2 つのキャプチャの区間 RMS が一致する**（PDC 無しなら N に依存して変わる）。加えて「1 ブランチのみ」と「同一 2 ブランチ」の RMS 比が**約 2.0**（位相が揃っていれば 2、ずれていれば √2 以下） |
| **T4** | **#635 `[]` は素通し・`enabled:false` は無音** | `layer([[], ["<effect>"]])` / `layer([[], plugin("<effect>", enabled: false)])` を評価し分ける | 素通しブランチのみ = dry と同 RMS。無効ブランチが**合算に足していない**こと（2 ブランチ有効時の RMS と 1 ブランチ時の RMS の差） |
| **T5** | **#669 段階 1: 3 語が明示エラーになる** | `evaluate_orbitscore` で `global.limiter(0.9)` を評価 | 応答テキストにメソッド未知のエラーが含まれ、`get_log` に対応する ERROR が**増える**（`<=` ではなくこの 1 本だけは増加を見る）。🔴 **黙って通ってはいけない** |
| **T6** | **#669 標準プラグインがカタログに出ない** | `rescan_plugins` → `list_plugins` | 3 つの標準プラグイン名が結果に**含まれない**（SC.10.8 規範 4） |
| **T7** | **#636 1 パターンが複数音源を駆動する** | `cb.instrument(layer([["<clap synth>"], ["<vst3 synth>"]]))` + `RUN` | layer の RMS > 各単独ブランチの RMS。片方を `enabled: false` にすると**残った方の単独 RMS と一致**する |
| **T8** | **#636 ブランチ無効化で強制 note-off** | 音が鳴っている最中に `enabled: false` の版を評価 | 無効化後のセグメント `rms` が無音セグメントと同程度（残響を除く）。T1 と同じオラクル |

**ラチェット**: `layer` は新しい DSL 語ではない（既に `GLOBAL_DSL_METHODS` / `SEQUENCE_DSL_METHODS` にある `effect` / `instrument` の引数）ので `dsl-e2e-coverage.spec.ts` の baseline は**増やさない**。#669 段階 1 は baseline から 3 語を**減らす**（§7.1）。

**hygiene**: `gated-assertion-hygiene.spec.ts` が「capture するのに rms を見ていなければ red」を強制する。T1-T4 / T7 / T8 は capture + rms なので満たす。

---

## 12. spec 改訂（実装より先・運用規則 6 / 7）

| spec | 箇所 | 改訂 | どの PR |
|---|---|---|---|
| `PITCH_DSL_SPEC_v1.1.md` §7 rule 2 | `:376` | 発火ケースに **「一発 `RUN()` の終端」** と **「オフラインレンダの終端」** を追加。現在の列挙（LOOP 除外 / MUTE / `play()` 差し替え / `global.stop()` / エンジン終了 / クラッシュハンドラ）に **RUN 終端が無い** | PR-A0 |
| `INSTRUCTION_ORBITSCORE_DSL.md` PH.4「All Notes Off」 | `:1496-1509` | 同じ発火ケースを追記し、**「engine が死んでも daemon が最後の砦になる」**（instance 単位の all-notes-off）を規範として書く | PR-A0 |
| `SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.10.11 | `:409-415` | `layer` の staging を解除。**PDC の v1 非目標**を明記: (i) 実行中の latency 変更通知は反映しない（再評価で直る）/ (ii) leg の pipeline 深さは構築時の静的トポロジで決める | PR-C0 |
| 同 SC.10.5 | `:296-311` | `layer` の LCS は**構造が同じなら keep、違えば layer 単位で load し直す**（ブランチ内部の差分対応づけは v1 では行わない）を規範に追加 | PR-D0 |
| 同 SC.10.8 | `:328-355` | 標準プラグインが **カタログに現れない**ことを（規範 4 の帰結として）検証可能な形で明記 | PR-G0 |
| `INSTRUCTION_ORBITSCORE_DSL.md` `:1240-1250` | PH.2 | 「global master effects（compressor / limiter / normalizer）と同じ役割分担」の参照を、3 語の削除に合わせて書き換える | PR-G1 |
| `INSTRUCTION_ORBITSCORE_DSL.md` `:1873-1876` | 機能一覧 | 「Global Mastering Effects」節を削除（`:1991` の changelog は履歴なので**触らない**） | PR-G1 |
| `orbit-audio-sandbox/src/host.rs:1-10` | doc | 「+1 block は**stage ごと**。leg 間の相対遅延はグラフの段数差で生じる」へ訂正（#588） | PR-C2 |

---

## 13. PR 分割

| PR | `type(scope): 件名` | 対象チェックリスト | 触るファイル（概算行） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| **PR-A0** | `docs(spec): add RUN termination and offline render to the note-off firing cases` | #606 全項 / #598 コメント 6 | `PITCH_DSL_SPEC_v1.1.md` / `INSTRUCTION_ORBITSCORE_DSL.md`（+30） | — | docs のみ（advisor 相談） | — |
| **PR-A1** | `fix(engine): hold the RUN tail timer and align its origin with the scheduled events` | #606-1（H1/H2） | `run-sequence.ts` / `sequence.ts`（+60） | PR-A0 | T1 | — |
| **PR-A2** | `feat(daemon): add PluginAllNotesOff so a dying engine cannot leave notes sounding` | #606-1（H3/H4）/ #606-2 | `engine_wrap.rs` / `session.rs` / `protocol-types.ts` / `daemon-client.ts` / `rust-engine-player.ts` / `plugin-note-output.ts` / `global.ts` / `shutdown.ts`（+300） | PR-A1 | T1 / T2・cfg 4 象限 | 🔴 **wire**（新 RPC） |
| **PR-C0** | `docs(spec): state the v1 non-goals of plugin delay compensation` | #634-2 | `SIGNAL_CHAIN_DSL_SPEC_v1.md`（+20） | — | docs のみ | — |
| **PR-C1** | `feat(engine): report and compensate plugin latency inside the rack child` | #634-1 / #634-2 | `orbit-clap-host`（Cargo + `controller.rs` + `effect.rs`）/ `orbit-vst3-host/src/lib.rs` / `rack-child lib.rs` / `macos.rs` / `rack_wire.rs`（+450） | PR-C0 | T3・cfg 4 象限・`bundle-macos.sh` + rack-child `--ignored` | 🔴 **wire**（`ChainReport`） |
| **PR-C2** | `fix(engine): compensate the pipeline depth difference between mixer legs` | #634-2 / #588 全項 | `output.rs` / `engine_wrap.rs` / `host.rs`（doc）（+250） | PR-C1 | 直行 leg と send leg の合算 RMS | — |
| **PR-D0** | `docs(spec): define how layer racks are matched on re-evaluation` | #635 | `SIGNAL_CHAIN_DSL_SPEC_v1.md`（+20） | — | docs のみ | — |
| **PR-D1** | `feat(dsl): run layer() branches in parallel` | #635 全項 | `rack.ts` / `effect-slot.ts` / `rack_wire.rs` / `rack-child lib.rs` / `macos.rs` / `session.rs` / `daemon-client.ts`（+700） | PR-C1・PR-D0 | T4・cfg 4 象限 | 🔴 **wire**（`StageSpec::Layer` の型・`chain_path` のネスト） |
| **PR-G0** | `docs(spec): state that standard plugins never appear in the catalog` | #669 段階 2 | `SIGNAL_CHAIN_DSL_SPEC_v1.md`（+15） | — | docs のみ | — |
| **PR-G1** | `refactor(dsl): drop compressor/limiter/normalizer from the vocabulary` | #669 段階 1 | `runtime.ts` / `global.ts` / `effects-manager.ts` / `rust-engine-player.ts` / `dsl-e2e-coverage.spec.ts` / core spec / `test-all-features.orbs`（−250） | — | T5 | 🔴 **DSL 表面**（削除） |
| **PR-G2** | `feat(engine): add the standard compressor/limiter/normalizer CLAP plugins` | #669 段階 2（機構） | `rust/crates/orbit-std-{compressor,limiter,normalizer}/` 新規（+900）/ 同梱スクリプト / CLAUDE.md ゲート | PR-G1 | T6 + 各 crate の contract テスト | — |
| **PR-G3** | `feat(dsl): expose the standard dynamics plugins` | #669 段階 2（表面） | `rack.ts`（+40）ほか | **🔴 §15 (1) の裁定** | 表面に応じた E2E | 🔴 **DSL 表面** |
| **PR-I1** | `feat(dsl): instrument racks driven by one pattern` | #636 全項 | `rack.ts` / `plugin-instrument-manager.ts` / `sequence.ts` / `plugin-note-output.ts`（+500） | PR-A2・PR-D1 | T7 / T8・cfg 4 象限 | — |

**マージ前ゲート**（CLAUDE.md・無条件）: `npm run build` → `bash rust/crates/orbit-std-gain/bundle-macos.sh` → `cargo test -p orbit-effect-rack-child --lib -- --ignored`（`--lib` は load-bearing・#629）。PR-G2 以降は 3 本の新 `bundle-macos.sh` も同じ行に足す（**条件分岐を付けない**）。

---

## 14. 確信度と反証方法

| 主張 | 確信度 | 反証方法 |
|---|---|---|
| RUN 終端の flush 呼び出し**自体は存在する**（地図 §4.B の「無い」は誤り） | **高** | §9 の grep 出力。`run-sequence.ts:61` → `sequence.ts:1019` → `midi-scheduler.ts:213` を読む |
| daemon 側に all-notes-off が無く、`active_plugin_notes` は読まれていない | **高** | §9 の grep（4 件・読み 0 件）。`session.rs` のメソッド表 |
| #606 の実機症状の主因は H3（note-off の silent drop）か H4（engine 死亡）である | **中** | 実機で Kontakt を鳴らし、`get_log` に F1/F2 の warn が出るかを見る。出なければ別経路。**設計はどちらでも成立する**（daemon 側の砦がどちらも塞ぐ） |
| `layer` は `[a, b]` 並列で PDC (a) だけを必要とし、(b) は不要 | **中〜高** | 同一 child の同一 `process_block` 内で全ブランチが処理されるので pipeline 遅延は共通（`lib.rs:395-425`）。反証は「ブランチが別 child になる設計に変える」場合のみ |
| clack で CLAP latency 拡張が使える（feature 名 `latency`） | **低** | 🔴 **未確認**。clack のリポジトリ（`rev = f874e858…`）で `clack-extensions` の feature 一覧と `PluginLatency` 系の型を読む。無ければ `clap_plugin_latency` を raw ABI で叩く（`clack-plugin` の raw アクセス経由） |
| VST3 の `getLatencySamples()` が `vst3 = "0.3"` の binding にある | **中** | `cargo doc -p vst3` か crate ソースで `IAudioProcessor` のメソッド一覧を見る |
| `MAX_PDC_FRAMES` の妥当な値 | **無し（決めていない）** | カタログの effect（#549 実測 272 本）を rack child でロードして申告 latency を集計する gated スクリプトを 1 本書き、分布を見る。**それまで数値を書かない** |
| `RUN_TAIL_GUARD_MS` の妥当な値 | **無し（決めていない）** | `applyGateAndLegato`（`sequence.ts:1492-1503`）が作る最大 offTime を単体で測り、`patternDuration` からの超過分を出す |
| 3 語の実使用は `.orbs` 1 本のみ | **高** | §9 の grep 出力 |
| T3 の「RMS 比 ≈ 2.0」が PDC の有無を弁別する | **中** | 実装前に red を確認する（PDC 無しで比が 2.0 未満になること）。ならなければ「同一ブランチ 2 本」では弁別できないので、片方だけレイテンシを持つ構成へ変える |

---

## 15. 🔴 owner 裁定待ち（本文はこれに依存せず着手できる）

### (1) #669 の DSL 表面 — 3 案（#669 本文）

| 案 | 形 | 得るもの | 失うもの |
|---|---|---|---|
| **A** | `global.effect([Compressor(threshold: …)])` に統一。専用メソッドは復活させない | 他のプラグインと**完全に同じ扱い**。#649「ラインの順序がモデル」と整合。SC.10.1 規範 3 のカテゴリ分けがそのまま効く | `global.compressor()` と書いていた人は書き換えが要る（実測: `.orbs` 1 本・6 行だけ・§9） |
| **B** | `global.compressor(...)` を**チェーン上の 1 要素の糖衣**として残す | 既存の書き味 | 「なぜこの 3 つだけ専用メソッドがあるのか」を説明できない。#649 の「フェーダーという段を作らない」と同じ種類の非対称が戻る |
| **C** | 専用メソッドのまま、内部で標準プラグインを差す | B と実装は同じ | B と同じ。加えて「マスター段」という特別な場所が残る |

**main の推奨: A。** 根拠は 3 つ — (i) #669 コメント 1 の段階 1 で**一度 DSL から消える**ので「既存の譜面を守る」制約がそもそも無くなる（owner 自身がそう書いている）、(ii) 実測で使っている譜面は 1 本 6 行だけ（§9）、(iii) SC.10.8 が「標準プラグインは大文字始まりの呼び出し」と既に定めており、A だけがそこに素直に乗る。

**影響範囲**: PR-G3 のみ（§13）。**PR-G1（削除）と PR-G2（crate 群）は裁定に依存せず今すぐ着手できる。**

### (2) #669 の中身 — `ShmKnd/Patina` を採るか自前で書くか

地図 §4.B が候補として挙げている（C++17 標準ライブラリのみ・MIT・実在確認済み）。**採ると Rust workspace に C++ ビルドが入る**（`orbit-std-gain` は純 Rust + clack）。SC.10.8「パラメータは DSL が正・UI 無し」も、Patina の**パラメータ数が多い**ことと噛み合うかを確認する必要がある（#669 コメント 2 が「着手時に確認」としている）。

- **A**: Patina を採る（DSP の質が上がる / ビルドが複雑になる）
- **B**: Rust で最小構成を書く（`orbit-std-gain` と同じ形が保てる / DSP を自作する）

**main は推奨を持たない**（DSP の質の要求水準が owner の判断）。

### (3) `layer` のブランチが**別の bus に乗る**か（#636 の形の確認）

§6.2 は「1 ブランチ = 1 insert bus」で設計した。これは既存の `SetSourceRouting` と post-loop の加算をそのまま使えるが、**bus を N 本消費する**（`MAX_INSERT_BUS_STAGES = 64`・`output.rs:347`。ただし既定プールは env で決まる）。

- **A**: 1 ブランチ = 1 insert bus（本書の設計。既存機構を使い回す）
- **B**: instrument child の出力を daemon 側で先に合算してから 1 本の bus に乗せる（bus を消費しないが、**ブランチごとの effect が書けなくなる**）

**main の推奨: A。** #636 の例（`["Serum", Gain(db: -6)]`）が**ブランチごとの effect** を前提にしているため、B は仕様を満たせない。ただし bus 消費が上限に当たる可能性は残るので、owner に「1 譜面でいくつの layer ブランチを使うか」の想定を確認したい（地図 §9 の「上限を決めない対象」5 語に **layer ブランチ数は含まれていない**）。

---

## 16. 本書が扱わないもの（参照のみ）

| 事項 | 正本 |
|---|---|
| `output(宛先, thru:, db:)` / master が終端でないこと / 合算規則 | `docs/design/611-output-line-design.md` |
| render エンドポイント宣言・`%n` テンプレート・オフライン駆動 | `docs/design/598-render-endpoint-design.md` / #598 |
| `outs:` の値が宣言ノードを一様に受ける形 | #409 / `611-output-line-design.md` §11 |
| ミキサーの stage 構成・`sum` / `aux` / MX.4 の固定順 | `docs/design/643-mixer-foundation-design.md` |
| フェーダー位置（`global.gain()` が instrument に効かない） | `docs/design/649-audio-line-design.md` / #649 |
| daemon の graceful shutdown（SIGTERM ハンドラ） | `main.rs:21-29` の既知事項（#448）。**本書は防御の現状を明記するだけ** |
| カタログのパラメータ設定・`preset:` | #522 |
| プラグイン UI のエディタ面（Cmd+Click） | #474 残スコープ / #664 |
