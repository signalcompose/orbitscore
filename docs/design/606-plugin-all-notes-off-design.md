# #606 PR-K-A2 — `PluginAllNotesOff` と「最後の砦」

**起案**: Fable（effort high・2026-09-05） / **審査・実測検証**: main（同日） /
**実装**: Codex / **検証**: main（sandbox 外・実機）

> 🔴 本書の「テスト表」は**テスト対象の一覧**として読む。検証手段は CLAUDE.md
> 「テストの積み上げ規律」で決め直す（設計書は本規則を上書きできない）。

---

## 1. 直すもの

### H3 — note-off が黙って捨てられる

`packages/engine/src/audio/rust-engine/rust-engine-player.ts:1286-1303` の 2 つの gate
（`!daemon.isRunning()` / `pluginActiveByKey !== true`）は note-on と note-off を**同じ経路で捨てる**。
捨てられたのが note-**off** なら**音は鳴り続ける**。

### H4 — daemon 側の台帳に読み手が 0 件

`rust/crates/orbit-audio-daemon/src/engine_wrap.rs:1617`:

```rust
active_plugin_notes: Mutex<HashSet<(String, u8, u8)>>,   // (instance, channel, key)
```

書き手は `plugin_note_on`（`:7157` insert）と `plugin_note_off`（`:7187` remove）の 2 つだけで、
🔴 **`session.rs` に読み手が無い**（grep で確認）。memory `consumerless-code-is-unprotected` の型。

**本 PR はこの台帳に読み手を与える。**

---

## 2. 🔴 main の見立ての訂正（Fable の指摘・main が一次ソースで確認）

main は当初「engine 異常終了では daemon が既に死んでいて RPC が送れない」を難所と考えたが、
**逆だった。**

| 経路 | 音は鳴るか | 根拠 |
|---|---|---|
| **daemon が死ぬ** | **鳴らない** | child は `getppid()` の変化を 250 ms 周期で検知して自ら exit する（`rust/crates/orbit-audio-sandbox/src/parent_watch.rs`） |
| 🔴 **engine が死んで daemon が生き残る** | **鳴り続ける** | daemon は孤児になるが child の親は健在。#607 の孤児 daemon がこの型 |

**危ないのは後者で、それを観測できるのは daemon 自身（session 切断）だけ。**
RPC だけでは届かない。

---

## 3. 設計

### 3.1 wire

```jsonc
{ "id": "…", "method": "PluginAllNotesOff", "params": {} }
{ "id": "…", "result": { "released": 3, "stale": 0, "failed": 0 } }
```

- **params は v1 では空**（= 全 instance）。3 場面はいずれも全 instance で、instance 指定の
  消費者は本 PR に存在しない（消費者のいない API を作らない）
- `released` = NoteOff の push に成功した件数。`stale` = 台帳にあったが送り先が既に無かった件数。
  `failed` = NoteOff の送出を試みたが runtime error になった件数
- 戻り値の形は既存の兄弟 `StopAll` → `{"stopped": n}`（`session.rs:2296-2299`）に揃える
- **`NoteChoke` は使わない** — PH.4 が「note-off を逐次送出」と定めている

**エラー語彙は新設しない**: 台帳 mutex poisoned → `OUTPROC_INSTRUMENT_RUNTIME` /
JoinError → `INTERNAL_ERROR`。ring 枯渇など entry 単位の送出失敗は成功 response の `failed` に
集計し、daemon log に詳細を残す。`clap-host` 単独と両 feature 無しのビルドは ok `{0,0,0}`
（前者の発音経路は instance ごとの台帳の対象外、後者には発音経路が無いため「0 件解放」は真。
stop 経路を feature-gap エラーで汚さない）。

**protocol version は上げない**（Fable 調査・確信度 中）。直近 3 件の wire 追加
（`ReplacePlugin` / `ApplyEffectChain` / `SetSourceRouting`）も bump 無しで入っており、
TS は厳密等価で照合し daemon は拡張に同梱されるので**食い違う組み合わせが出荷上存在しない**。
代わりに `docs/research/ENGINE_DAEMON_PROTOCOL.md` に節を足す。

### 3.2 daemon 側の読み手は「1 本の関数 + 2 つの trigger」

```
plugin_all_notes_off()   ← engine_wrap.rs（台帳を drain して NoteOff を送る）
   ├─ trigger 1: RPC "PluginAllNotesOff"        （session.rs の handler）
   └─ trigger 2: session 切断                    （session.rs の read ループを抜けた直後）
```

**配送機構は 1 本**（PH.4「発火点が増えても配送機構は 1 本」）。

🔴 **lock を持ったまま ring に push しない。** 台帳を lock → 全 entry を drain して Vec へ →
unlock → entry ごとに push、の順にする。

### 3.3 H3 は**対称のまま**にする（Fable の判断・main 同意）

note-off だけ gate を素通りさせる案は**棄却**。`PluginNoteOutput.noteOn` は送信の成否に
関わらず `activeNotes` に push するので、gate を抜くと **note-on が落ちた note の note-off まで
送られ**、1 件ごとにエラーが出る。得られるのは W4 の短縮だけで、それは `global.stop()` で止まる。

**非対称性は daemon 側の台帳に既にある** — note-on が daemon に届いていればその note は
台帳にあり、届いていなければ鳴っていない。**台帳そのものが「落ちた note-off の記録」**。

### 3.4 TS 側の配線は 1 箇所だけ

```
global.stop() → transport-control.ts:50 → RustEnginePlayer.stopAll()
shutdown      → global.stop() → 同上
```

`stopAll()` の呼び出し元は rust 経路で厳密に 2 つ（`transport-control.ts:50` と
`rust-engine-player.ts:791` の `quit()`）。**PH.4 の「3 場面以外から呼ばない」が配線で保証される。**

`daemon.stopAll()` の直後に `pluginAllNotesOff()` を並べる。
🔴 **`global.ts` / `shutdown.ts` / `plugin-note-output.ts` は触らない。**

`quit()` は `disposed=true` を先に立てるので既存 guard で flush も skip される。これで正しい —
直後の `daemon.quit()` が SIGTERM で daemon を落とし、child は `ParentWatch` で exit する。

**正常系に何も足さない**: `released > 0 || stale > 0` の時だけ `console.log`（stdout。
stderr は ERROR に分類される）。通常は台帳が空なので `released: 0` で無言。

### 3.5 台帳の stale entry

`ReplacePlugin` の commit で旧 tenant は teardown されるが台帳は消えない。
**commit 時に `name` の entry を remove する**（`released` の水増しを防ぐ）。
🔴 **ただし quarantine 時（teardown 失敗）は消さない**。全 quarantine variant でも旧 child は
`InstrumentChildSupervisor::drop` から watchdog の `CONTROL_QUIT` と reap を経て必ず停止するため、
旧 child の音が残るわけではない。残った entry は次回 `PluginAllNotesOff` で新 tenant に対して解決され、
実害は `released` 件数の水増しに限られる。この quarantine path は ledger key を slot 同一性へ変える
issue #752 の対象に含め、本 PR では構造を変更しない。

---

## 4. テストと受け入れ

**順序は CLAUDE.md の E2E > 機能 > 変異。review round 2 では batched retain を識別する unit test に
remove-on-success 変異を一時適用し、red → 復元後 green を確認する。**

fixture の CLAP test synth は **note-off が来るまで 0.25 振幅の sin を出し続け release が無い**
ので、「止まった後の窓の RMS」が理想のオラクル（鳴っていれば ≈0.177・止まっていれば ≈0）。

| # | 層 | 何を証明するか |
|---|---|---|
| **E2E-K3** 🔴 | gated E2E | `LOOP` → 音を確認 → **engine を `kill -9`** → 1 s 待つ → **daemon がまだ書いている WAV** の末尾 0.5 s rms < 0.01。**daemon 側の砦をユーザーと同じ経路で証明する唯一のテスト** |
| T2（意図的に削除） | gated E2E | `stop_engine` は capture を書く daemon 自体を終了するため silent tail を記録できず、engine 終了後の disconnect cleanup log も取得できない |
| T1 | gated E2E | `RUN(cb)` → 終端後の窓 rms < 0.01（A1 の受け入れ） |
| cargo gated | 機能 | note_on → `plugin_all_notes_off()` → `released == 1` → `probe_live_count == 0` |
| `tests/protocol.rs` | 機能 | **ws を drop すると台帳が 0 件になる**（切断 trigger） |
| unit | 機能 | 台帳空 → `{0,0,0}` / 注入 → `stale` / TS 側の送信順と `quit()` で送らないこと |
| cfg 4 象限 | 機構 | `check-cfg-matrix.sh --clippy` 緑 |

T2 は意図的に受け入れ対象から外した。`stop_engine` が capture writer である daemon を終了するため、
末尾 window を収録できず、tracing を relay する engine も既に終了しているので cleanup log の有無も
判定材料にならない。T1 が通常の engine-side release、E2E-K3 が daemon を生かした disconnect fallback を担う。

### 受け入れ基準

1. **E2E-K3 が green**（実装前の red を実出力で残していること）
2. T1 が green（T2 は上記理由で意図的に削除）
3. cargo gated: `released == 1` → `probe_live_count == 0`
4. `tests/protocol.rs`: 切断で台帳 0 件
5. cfg 4 象限 clippy 緑
6. `npm test` 全緑・件数増・`typecheck:e2e` 緑
7. 🔴 **`active_plugin_notes` の読み手が grep で 2 件以上**（RPC・切断）— 「読み手 0 件」の解消を機械で確認

---

## 5. 確信度が低い箇所

| 箇所 | 確信度 | 反証方法 |
|---|---|---|
| daemon が死ねば鳴らない | **高**（main が `parent_watch.rs` で確認） | child が親死後も自前で出力デバイスを開く経路があれば崩れる |
| version を上げない | 中 | owner 裁定次第。上げる場合の変更は 3 箇所 |
| **E2E-K3 のハーネス**（engine の `pgrep`・孤児 daemon の後始末・次テストの engine 再起動） | **中〜低** | flaky なら cargo gated + `protocol.rs` を主証拠に降格し K3 は隔離して報告。**T2 だけでは daemon 側の砦を証明できない**（TS の経路が先に止める） |
| stale の判定を文字列一致でしている | 中 | `WrapError` の variant で判定できる形に寄せる。**文字列で判定しない** |
| `ReplacePlugin` commit で台帳を消す副作用 | 中 | quarantine 時は消さない分岐にして unit で両方を固定する |

---

## 6. レビュー後に**先送りしたもの**（2026-09-05・main が追記）

🔴 **この節は「後回しにしたが、やらないとは言っていない」ものの置き場である。** 消さないこと。

### 6.1 台帳のキーを slot 同一性にする → **#752**

`ReplacePlugin` の**スナップショットと `instance_index` の再ポイントの間**に旧 instance 宛の NoteOn が
届くと、その entry はスナップショットから漏れ、teardown 後の cleanup を素通りして台帳に残る。
旧 child は殺されるので**その音は止まる**が、次の `PluginAllNotesOff` が**新テナントへ NoteOff を送り**、
新テナントが同じ (channel, key) を鳴らしていれば**その音が切れる**。本 PR が直した欠陥の鏡像である。

- 🔴 **窓を狭めるだけでは閉じない**。`plugin_note_on` は push（control lock を取って解放）→ 台帳 insert の
  順なので、push 済み・insert 前の note がどうやってもスナップショットから漏れる
- 直し方は **`(slot_index, tenant_generation, channel, key)` でキーし直す**。`tenant_generation` は
  既に存在する（`outproc_instrument.rs:208`・teardown で `fetch_add`・`engine_wrap.rs:6413`）
- 🔴 **本設計の §「却下した案」で「wire が名前しか運ばないから無理」と書いたのは誤り**だった。
  `push_outproc_instrument_event` は note の時点で名前→index を解決済みで、index は追加コストなしに手に入る
- 本 PR に含めない理由: 差分が既に 1600 行あり、この変更は per-note 経路のシグネチャに触る。
  残存窓はロック 2 回ぶんで、本 PR が直した 500 ms の窓より 2 桁以上狭い

### 6.2 タイマーのライフサイクル管理点が 2 箇所に分かれている

`loopTimer` は `preparePlayback` が一括クリアする一方、`runTimer` は `run()` / `loop()` / `stop()` の
3 箇所で個別に `clearRunTimer()` している。**本 PR が特別扱いを増やしたわけではなく**（`stop()` 側の
`loopTimer` インラインクリアも既存の同型）、既存パターンを踏襲しただけだが、層はずれている。

寄せ先は `PreparePlaybackOptions` に `runTimer` も渡して既存の「Clear existing loop timer if any」を
両タイマー共通にすること、および `stop()` のインラインクリアを `stateManager.clearTimers()`（既に両方を
クリアする実装がある）へ寄せること。**挙動が変わりうるので独立した PR で扱う。**

### 6.3 `analysisTailRms` の二乗平均の重複 → **解消済み**（2026-09-05）

PR #746 が `tests/e2e/helpers/capture-windows.ts` に `quadraticMeanRms` を切り出して main に入ったので、
本ブランチを載せ替えたうえで **import に差し替えた**。
