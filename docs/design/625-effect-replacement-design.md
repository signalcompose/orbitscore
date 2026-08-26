# 設計書: effect insert の差し替え・削除（issue #625）

- 起案: Fable（設計担当・2026-08-26）
- 対象 issue: #625（effect insert の再起動なし差し替え・削除）
- 関連: #618 / PR #621（instrument 側・機構は流用不可）・#522（SC.5）・#623（プラグイン解決の先勝ち/後勝ち不一致）
- 実装担当への注意: 本書は「それ単体で実装できる粒度」を目標に書かれている。**§7 Known Decisions 相当（本書 §4 決定事項）は確定済みとして扱い、再設計しないこと。** 仕様から逸脱する必要が生じたら spec 側を先に更新する（§7 Stage 0）。

---

## 0. 調査で確認した現状（すべて実ファイルで確認済み）

### 0.1 拒否の現状（3+1 経路）

| 経路 | 拒否箇所 | 文言 |
|---|---|---|
| `global.effect(A)`→`(B)` | `packages/engine/src/core/global/plugin-effect-manager.ts:53-54` | "effect chains are reserved for future support" |
| `seq.effect(A)`→`(B)` | `packages/engine/src/core/global/sequence-effect-manager.ts:109-111` | "chains (multiple inserts) are reserved for future support" |
| `sum("x").effect(A)`→`(B)` | `packages/engine/src/core/global/mixer-manager.ts:354-356` | 同上 |
| `aux("x").effect(A)`→`(B)` | 同上（`MixerManager` は sum/aux 同型の `KindState` 2面。`mixer-manager.ts:95-100, 138-156`） |

throw の実体は `EffectChainMap.declareBody`（`effect-slot.ts:264-274`）。`EffectChainMapOptions.replacement`（`effect-slot.ts:122-127`）が**instrument 専用の opt-in** で、effect 3 manager はいずれも渡していない。渡せば `issueReplacement`（`effect-slot.ts:286-375`）へ分岐する — **TS 層の差し替え発行機構そのものは既に role 汎用**（entry 構築は effect 分岐を持つ: `effect-slot.ts:340-354`）。

### 0.2 wire / daemon の現状

- `DaemonClient.replacePlugin`（`daemon-client.ts:473-495`）は role/bus/instance/state_path をそのまま送る — **wire クライアントは既に effect を送れる形**。
- session 側 `ReplacePlugin` ハンドラが **`role='instrument'` を明示要求して他を拒否**（`session.rs:1572-1581`）。
- `load_outproc_plugin_impl` は `ChildSlot::Active` を4分岐すべて拒否（`engine_wrap.rs:3784-3843`）。effect も同関数を通る。
- `GetPluginState` は role 汎用（`session.rs:1654-1711`・`{role:'effect', bus}` を受ける。TS 側 `daemon-client.ts:497-517`）。

### 0.3 instrument 機構が流用できない理由（確認済み）

| | instrument | effect |
|---|---|---|
| スロット | N 個の同質プール + `allocate_slot()`（`engine_wrap.rs:954`） | **bus 名で位置固定**: `bus_slots: HashMap<String, Weak<Mutex<ChildSlot>>>`（`engine_wrap.rs:259`）。`install_effect_bus_slots`（`engine_wrap.rs:536-591`）が stream 起動時に1回だけ構築。master は `child_slot`（`engine_wrap.rs:256`） |
| 名前→スロット間接層 | `instance_index` あり（`engine_wrap.rs:3302-3304` で張り替え commit） | **無い**。render 側 `InsertBusStage`（`orbit-audio-native/src/output.rs:296-330`）が構築時に processor（=当該 shm への `PipelinedEffectHost`）を直接抱える |
| 予備スロット方式 | 成立（`replace_outproc_instrument_plugin` = `engine_wrap.rs:3172-3335`） | **成立しない**（張り替え先が無い） |

### 0.4 本設計が使う既存部材（確認済み）

1. **`engaged` フラグ**: `OutProcEffectPostProcessor::process` は `engaged=false` の間 **shm transport に一切触れず data を dry 素通し**する（`outproc_effect.rs:365-367`）。attach 成功時に `engaged=true`（`engine_wrap.rs:3977`）。
2. **quiesce handshake**: 各 bus と master に `teardown_requested`/`teardown_done` の AtomicBool ペアが**既に存在**する（bus: `EffectBusBuild.stop/done` = `engine_wrap.rs:434-436`、master: `engine_wrap.rs:2259-2260`）。RT 側は requested を見たら transport を触らず done を立てる（`outproc_effect.rs:361-365`）。現在は stream 終了時の `OutProcTeardownGuard`（`outproc_effect.rs:771-798`）だけが使う。
3. **teardown プリミティブ**: `detach_and_reset_control_run::<R>`（supervisor 停止→join→reap→shm control を RUN へ reset・`engine_wrap.rs:5347-5355`）と `EffectRole::detach_keep_shm`（`engine_wrap.rs:1587-1589`）は role 汎用。`retryable_attach_failure` も同様（`engine_wrap.rs:5329-5342`）。
4. **`bus_actives`**: 宣言 = activation（`engine_wrap.rs:2963-2970`）。🔴 **inactive の bus に tag された PlayAt イベントは消費されず retain される**（`output.rs:311-316` の明示ハザード）。→ 差し替え窓・失敗後も **bus_active は落とさない**のが本設計の要点の一つ。
5. **TS 側の uncertain-ensure 機構**: `EffectChainMap.uncertainReplacements`（`effect-slot.ts:153, 279-283, 332-337`）— 失敗後の再宣言を `ReplacePlugin`（ensure 意味論）へ誘導する。
6. **state 保存/復元**: `save_outproc_plugin_state` は role 汎用（`engine_wrap.rs:3674-3771`）。`issueReplacement` の `statePathFallback`（project.yaml 復元）は effect manager 3 者とも既に配線済み（各 manager の `externalReceiverId` + `createStatePathFallback`）。
7. **respawn 実績**: effect child の watchdog respawn は同一 shm への re-attach を既に日常的に行っている（`EffectChildSupervisor`・`outproc_effect.rs`）。「同一 shm に新 child を attach し直す」操作自体は新規リスクではない。

### 0.5 daemon control 側に**欠けている**もの（不在証明・列挙済み）

`OutProcControl`（`engine_wrap.rs:249-278`）の全フィールドを列挙した結果、以下を**保持していない**:

- 各 slot の `shm_path` / `child_exe`（既定値）/ `sample_rate` — teardown 後の `ChildLaunch` 再構築に必須（instrument は `InstrumentSlotEntry` = `engine_wrap.rs:1016-1034` が保持）
- 各 slot の `engaged` / `teardown_requested` / `teardown_done` への control 側ハンドル（現在は `ChildSlot` 内と `StreamGuard` の `OutProcTeardownGuard` にしか無い。`StreamGuard` は `main.rs` 側所有で `EngineWrap` から辿れない）
- effect 版 `replacements_in_flight`

**→ 実装の中心は「`EffectSlotEntry` の追加」+「in-place teardown/attach の orchestration」+「wire/TS の開通」であり、RT 側（orbit-audio-native）のコード変更はゼロ。**

---

## 1. 完了条件（曖昧語なし）

以下がすべて満たされたとき done:

1. `global.effect(A)`→`global.effect(B)` / `seq.effect(A)`→`seq.effect(B)` / `sum("x").effect(A)`→`.effect(B)` / `aux("x").effect(A)`→`.effect(B)` の4経路すべてが、**エンジン再起動なし・楽譜再評価のみ**で B の音になる。実証は gated E2E（§6 FM-R26）で、(i) capture WAV の区間 RMS 比が A/B の gain 差を反映、(ii) 旧 child PID 消滅 + 新 child PID 出現、(iii) `get_log` の ERROR 行数が増えない、の3オラクル全通過。
2. ロード失敗注入（存在しないパス）時、(i) teardown 前失敗では旧 effect が鳴り続ける（rust unit FM-R7 + TS unit FM-R13）、(ii) teardown 後失敗では bus が dry pass-through で鳴り続け（無音にならない・bus_active true 維持 = FM-R8）、同じ宣言の再発行だけで復旧する（FM-R9、E2E でも実証）。
3. 差し替え・削除の直前に旧 insert の state が project.yaml 配下へ自動保存され（FM-R12/R22）、旧 spec の再宣言で `[plugin-state] restoring` 経由の復元が起きる（E2E で実証）。
4. `remove("名前")` が 4 経路（global / seq / sum / aux）で動き、bus は解放されず routing が生き残る（FM-R19/R20/R21）。
5. 「chains (multiple inserts) are reserved」系の文言が、**異 spec 再宣言（=差し替え要求）の経路では一切 throw されない**（FM-R1）。
6. `plugin-instrument.spec.ts` の T11 が「3経路で差し替えが発行される」意味へ書き換わり、§5 の失敗モード表の全行に対応するテストが**変異検証つき**（各行の「変異」列を実施し red→restore→green の実出力を PR に添付）で存在する。
7. `cargo test --features outproc-effect,outproc-instrument`（rust 全体）と `npm test`（1362+ 全体）が green。既存 instrument 差し替えテスト（T1-T9、rust 側 replace/teardown 群）は**無変更のまま** green（FM-R24）。
8. spec 3 箇所（`docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` の **SC.3 規範4 括弧書き** と **SC.5「v1 の現在地」**、`docs/core/INSTRUCTION_ORBITSCORE_DSL.md` の effect 節）が §3.9 の文面案どおり実装**前**に更新済み（§7 Stage 0）。

---

## 2. 採用する機構と却下案

### 2.1 採用: 案 (a) 同一 ChildSlot の in-place 建て直し（quiesce ack 付き）

**1行要約: 「engaged を落として dry 素通し → 既存 quiesce ペアで RT の transport 離脱を ack 待ち → supervisor detach + shm control reset → 同一 shm へ新 child を attach」— RT コード無変更・bus_active は常時 true 維持。**

シーケンス（新関数 `EngineWrap::replace_outproc_effect_plugin(path, plugin_id, bus: Option<String>, state)`）:

```
0. control lock: slot 解決（bus=None → child_slot / Some → bus_slots[bus]）、
   EffectSlotEntry（新設・§3.1）取得、effect_replacements_in_flight 重複ガード。
   entry.shutdown（§2.1.1 の latch）が true なら Err "engine is stopping" で即中止（旧無傷）
1. slot 検分（instrument 版 engine_wrap.rs:3216-3257 と同型）:
   - Active 同一 (path, plugin_id, state) → engaged=true して冪等 Ok（差し替えない）
   - Empty → 通常 load へ委譲（ensure 意味論。§3.1-(5) の activation 規律に注意）
   - Loading → Err "load already in progress"（既存文言・旧無傷）
   - Closed → Err OUTPROC_SLOT_CLOSED（旧 attach 失敗で shm 消失済み・再起動が必要・旧無傷）
   - Active 異 spec → 2 へ
2. engaged.store(false)  … 次 callback から dry 素通し（音は流れ続ける・effect だけ外れる）
3. quiesce: done=false → requested=true → done=true を EFFECT_QUIESCE_TIMEOUT(500ms) まで poll
   - timeout → ロールバック: requested=false, done=false, engaged=true, in-flight 解除, Err
     （旧 child は殺していない → 旧 effect が鳴り続ける）
4. supervisor 取り出し（Active → mem::replace で Closed）→ open_shared(shm) →
   detach_and_reset_control_run::<EffectRole>（supervisor 停止→child reap→control RUN reset）
   - open_shared 失敗 → detach_keep_shm + slot=Closed（隔離・dry 恒久・Err）
5. stats.current_child_pid=0、slot = Empty(ChildLaunch { entry の shm_path/child_exe/sample_rate,
   stats, engaged, cleanup_shm_on_drop: true })
6. quiesce フラグ後始末（🔴 §2.1.1 の shutdown latch 検査つき・無条件 store 禁止）:
     if !entry.shutdown { requested=false; done=false;
       if entry.shutdown { requested=true }  // clear と latch セットの競合を復元で閉じる
     }
   （順序は instrument teardown 成功時 engine_wrap.rs:3479-3482 と同じ requested→done。
   engaged は false のままなので RT はまだ dry。）
7. entry.shutdown を再検査: true なら slot=Empty のまま Err "engine is stopping"
   （停止中の無駄な child spawn を避ける）。false なら
   load_outproc_plugin_impl::<EffectRole>(slot, 新 path, plugin_id, state)
   - 成功: engaged=true が内部で立ち（engine_wrap.rs:3977）新 effect の音へ
   - retryable 失敗: slot=Empty で dry 継続（再宣言で復旧可）
   - unrecoverable 失敗: slot=Closed（dry 恒久・再起動が必要）
8. in-flight 解除、ReplacedPluginSummary { quarantined_slot: false } を返す
```

**bus_active はどの段でも触らない**（旧宣言時から true・§0.4-4 のハザード回避）。master は active フラグ自体が無い。

#### 2.1.1 stream 停止との交錯 — quiesce フラグの所有権（main レビュー指摘・Important）

手順 3/6 が使う requested/done ペアは、**stream 停止時の `OutProcTeardownGuard`（`outproc_effect.rs:781-797`）と同じ Arc** である。guard は drop で `requested=true` を立て `done` を `TEARDOWN_TIMEOUT` まで poll するが、guard は `StreamGuard` 側所有で `EngineWrap` から辿れない（§0.5）。手順 6 を無条件 store にすると次の交錯が成立する:

差し替えが手順 6 直前 → 並行 stream 停止で guard が `requested=true` → 手順 6 が両フラグを clear → RT は `requested=false` を先に見て done を立てない（`outproc_effect.rs:361-367`）→ guard は timeout 満了まで待ち **ack 無しで stream 停止へ進む** → さらに手順 7 の attach が `engaged=true` にすると、ack が防ぐはずだった「stream 停止機構と RT の並行」が復活する。演奏中差し替えを許可する（決定 6）以上、「差し替え中の stop_engine」は現実的な操作であり、対処必須。

**採用: control 側専用の第3フラグ `shutdown`（latch）**

- `EffectSlotEntry` に `shutdown: Arc<AtomicBool>` を追加し、同じ Arc を `OutProcTeardownGuard` に持たせる（`new` の第3引数化）。guard は **drop の冒頭・`requested=true` より前に** `shutdown=true` を store する。一度立ったら降りない latch。
- **RT はこのフラグを読まない**（`OutProcEffectPostProcessor::process` 無変更）— 「RT 変更ゼロ」の採用理由（§2.1）を保つ。
- 差し替え側の規律: (i) 手順 0 で `shutdown=true` なら即 Err（旧無傷）。(ii) 手順 6 は「shutdown が false のときだけ clear し、clear 直後に再検査して true になっていたら `requested=true` を復元」する（手順 6 の擬似コード）。復元後の done は false のままでよい — RT は requested=true を見た次の callback で done を立て直すので、guard の poll は control スレッドの数命令ぶんの遅延で ack を得る（`TEARDOWN_TIMEOUT` に対して無視できる）。(iii) 手順 7 の直前で再検査し、停止中なら attach しない。
- guard 側の待ち合わせは変更不要: 差し替え自身の quiesce（手順 3）で requested が既に true の間に guard が drop しても、`requested=true` の再 store は冪等で、RT が毎 callback done を立てているため guard は即 ack を得る。

**却下案**:

- `compare_exchange(true→false)` 単独 — requested は差し替え側と guard 側の**どちらも true を立てる**ため、CAS が成功しても「誰の quiesce を消したのか」を区別できない。guard が立てた直後の窓では今回の競合がそのまま残る。不十分。
- 差し替え専用の quiesce ペア新設 — RT が2組のフラグを見る形になり `process` に分岐が入る = **RT 変更ゼロという採用理由（§2.1）を壊す**。却下。

対応する失敗モードは §5 **FM-R27**。

採用理由:

- **RT 側変更ゼロ**: `InsertBusStage` / `OutProcEffectPostProcessor` / cpal callback に一切手を入れない。使うフラグ（engaged / requested / done）はすべて既存で、RT 側の読み方も既存のまま。新しい UB 面を作らない。
- **窓は「無音」ではなく「dry 素通し」**: `engaged=false` は data をそのまま流す（`outproc_effect.rs:365-367`）。insert の差し替え中もソース音は鳴り続け、effect だけが一時的に外れる。owner の動機（準備段階でリバーブを聴き比べる）に対して、この縮退は十分許容できる。窓の長さは child spawn + plugin load + READY 待ち（実測は CLAP/VST3 で数百 ms〜数秒のオーダー。上限 `CHILD_READY_TIMEOUT`=60s = `engine_wrap.rs:1820`）。
- **quiesce ack を保持する理由**: instrument teardown は「RT が shm を触らなくなったことの決定論的 ack」を必須とした（`engine_wrap.rs:3406-3424`、memory: 既存機構を借りるなら不変条件も継承する）。effect でも `reset_control_run` と RT の `process_block` の並行を排除するため ack を踏襲する。ack ペアは既存の stop/done を流用する（新規フラグ不要）。

### 2.2 却下: 案 (b) bus stage が 2 つの ChildSlot を持ち engaged を切り替える

- 全 17 slot（insert 8 + sum 4 + aux 4 + master）に **shm + `PipelinedEffectHost` + transport をもう1式**持たせることになる（`InsertBusStage` は構築時に processor を1つ固定で抱える設計 = `output.rs:296-330`）。`build_effect_bus_stages` / `RenderState` / callback render 経路の改造 = **RT コードに新しい分岐と切替ロジック**が入る。
- 得られるのは「途切れない」ではなく「dry 窓が消える」だけ。案 (a) の窓は無音ではないので、その対価に見合わない（owner 動機は準備段階の反復であり、gapless は要件でない）。
- なお wire/TS 層の設計（ReplacePlugin ensure 意味論）は機構非依存なので、将来 gapless が要件化したら daemon 内部だけを (b) へ差し替えられる。**却下は「今作らない」であって、拡張路をふさがない。**

### 2.3 却下: 案 (c) bus pool から予備 bus を取り routing を張り替える

- **master に bus が無い**ため 3 経路を揃えられない（決定 8 と矛盾）。
- `SetBusRouting` は「stage の**出力先**」を切り替えるだけで（output は sum のみ・forward-only・`engine_wrap.rs:3030-3049`）、**PlayAt の bus tag（入力側）を別 bus へ向け直す機構は無い**。seq→bus の対応替えは TS 側の routing replay（`rust-engine-player.ts:918-930`）・state 宛先（`{role:'effect',bus}`）・UI 宛先・respawn 台帳（`pluginKey` = `rust-engine-player.ts:942-944`）のすべての key を同時に張り替える大工事になる。
- 旧 bus を非 active 化すると §0.4-4 の event retain ハザードを踏む。逆に active のまま放置すると pool を1本ずつ恒久消費する。

---

## 3. 詳細設計

### 3.1 Rust: `engine_wrap.rs`

**(1) `EffectSlotEntry`（新設）** — instrument の `InstrumentSlotEntry`（`engine_wrap.rs:1016-1034`）の effect 版:

```rust
#[cfg(feature = "outproc-effect")]
struct EffectSlotEntry {
    shm_path: PathBuf,
    child_exe: PathBuf,      // 起動時の既定 child exe（select_child_exe が attach ごとに再導出する）
    sample_rate: u32,
    engaged: Arc<AtomicBool>,
    quiesce_requested: Arc<AtomicBool>,  // = 既存 stop（EffectBusBuild.stop / master teardown_requested）
    quiesce_done: Arc<AtomicBool>,       // = 既存 done
    /// stream 停止 latch（§2.1.1・新設）。OutProcTeardownGuard が drop 冒頭で true にする。
    /// control 側専用 — RT は読まない。差し替えは手順 0/6/7 でこれを検査する。
    shutdown: Arc<AtomicBool>,
}
```

`OutProcTeardownGuard::new` は第3引数 `shutdown: Arc<AtomicBool>` を取り、`Drop` の冒頭（`requested=true` の**前**）に `shutdown.store(true, Release)` する（`outproc_effect.rs:782-797` の改修・RT 側は無変更）。呼び出し箇所は master（`engine_wrap.rs:2343` と両建てパス `2578`）+ per-bus（`install_effect_bus_slots` 内 `engine_wrap.rs:578`）で、いずれも同じ Arc を `EffectSlotEntry` と共有する。

`OutProcControl` に `master_entry: EffectSlotEntry` と `bus_entries: HashMap<String, EffectSlotEntry>`、および `replacements_in_flight: HashSet<Option<String>>`（None=master）を追加する。構築場所:

- master: `start_outproc_effect_post_boot`（`engine_wrap.rs:2240-2350` の `engaged`/`teardown_requested`/`teardown_done`/`shm_path`/`cfg.child_exe`/`sample_rate` を clone）
- bus: `install_effect_bus_slots`（`engine_wrap.rs:536-591`）で `build.stop/done/engaged` を **`OutProcTeardownGuard`/`ChildLaunch` へ move する前に clone** して entry を作る
- 🔴 起動経路は**複数ある**（effect 単独 L2240 系と effect+instrument 両建て L2461 系）。`OutProcControl` を構築する**全**箇所（テスト注入 L765, L7010, L7032, L7122, L7156 含む）を `grep -n "OutProcControl {"` で列挙して全部埋めること。テスト注入箇所は fixture 値でよい。

**(2) `replace_outproc_effect_plugin`（新設）** — §2.1 のシーケンス。lock 規律は instrument 版に合わせる: outproc mutex は slot 解決と in-flight 操作の間だけ保持し、quiesce 待ち・attach 本体はロック外（`engine_wrap.rs:2943-2945` の理由と同じ）。in-flight 解除は成功・失敗どちらでも必ず行う（instrument の `InstrumentReplacementReservation` = `engine_wrap.rs:1099-1160` に相当する Drop ガードを effect 用に用意する。spare が無いぶん簡素になる）。

**(3) `teardown_outproc_effect_slot`（新設）** — §2.1 の 2〜6 段。instrument 版 `teardown_outproc_instrument_resources`（`engine_wrap.rs:3389-3492`）を**手本にするが関数は共有しない**: note-ring drain・`tenant_generation`・VoiceTable リセットは instrument 固有で、effect には対応物が無い（`OutProcEffectStats` に該当フィールド無し）。共有するのは下位プリミティブ（`detach_and_reset_control_run` / `lock_child_slot_recovering` / `ChildLaunch` 再構築パターン）のみ。

**(4) `unload_outproc_effect_plugin`（新設・Stage C）** — replace の 1〜6 段 + 「7 の load をしない」版。slot Empty なら冪等 Ok（`{status:'noop'}`）。bus_active・bus 簿記は触らない。

**(5) activation 規律** — replace/unload 経路では `bus_actives` を**読みも書きもしない**。Empty への ensure-load fallback も `load_outproc_effect_plugin_with_state`（activation rollback を持つ・`engine_wrap.rs:2984-2990`）を経由**せず**、slot 解決済みの `load_outproc_plugin_impl` を直接呼ぶ。理由: 失敗時 rollback の `active.store(false)` は「初回宣言の失敗 = TS も bus を返す」場合にのみ正しく、差し替え文脈では event retain ハザード（§0.4-4）になるため。

**(6) 定数** — `EFFECT_QUIESCE_TIMEOUT: Duration = 500ms`・poll 2ms（`INSTRUMENT_DRAIN_TIMEOUT`/`INSTRUMENT_DRAIN_POLL` = `engine_wrap.rs:1826-1828` と同値）。

### 3.2 Rust: `session.rs`

**(1) `ReplacePlugin`** — `role='instrument'` 固定（`session.rs:1573-1581`）を撤廃し、LoadPlugin と同じ役割分岐（`session.rs:1408-1437` の cfg 4分岐パターン）へ:

- `role='effect'`: `bus` を `parse_bus_param` で解析（`session.rs:1446` と同関数）、`instance` は拒否（"ReplacePlugin instance is only valid for role='instrument'"）、`engine.replace_outproc_effect_plugin` へ。feature `outproc-effect` 無しビルドは `OUTPROC_EFFECT_UNAVAILABLE`。
- `role='instrument'`: 既存のまま無変更。
- role 欠落/その他: "ReplacePlugin requires role='effect' or role='instrument'"。

**(2) `UnloadPlugin`（新コマンド・Stage C）** — params `{ role: 'effect', bus? }`。v1 は effect のみ受理（instrument は "UnloadPlugin supports role='effect' in v1"）。成功 `{ status: 'unloaded' | 'noop' }`。feature 無しは `OUTPROC_EFFECT_UNAVAILABLE`。

**(3) 既存テスト** `replace_plugin_explicitly_rejects_every_non_instrument_role`（`session.rs:2295` 付近）は「effect が受理される・missing だけ拒否」へ書き換える。

### 3.3 wire ドキュメント / TS 型

- `docs/research/ENGINE_DAEMON_PROTOCOL.md`（protocol-types.ts:4 が SoT と明記）へ ReplacePlugin(role=effect) と UnloadPlugin を追記。
- `protocol-types.ts:18-56` `CommandMethod` に `'UnloadPlugin'` を追加。
- `types.ts:109-117` `AudioEngine.replacePlugin` の doc を role 汎用へ改訂。`unloadPlugin?(role: 'effect', bus?: string): Promise<void>` を追加。
- `daemon-client.ts` に `unloadPlugin(role, bus?)` を追加（`replacePlugin` と同じ省略規約: bus 非空時のみ送る）。

### 3.4 TS: `effect-slot.ts`

**(1) `EffectChainMapOptions.replacement` に失敗ポリシーを追加**:

```ts
readonly replacement?: {
  readonly beforeReplace: (key: K, oldSlot: PluginSlot) => Promise<void>
  readonly onQuarantinedSlot?: (key: K) => void
  /**
   * 差し替え失敗時の登記の扱い。
   * 'retain-on-reject'   (instrument): DaemonProtocolError は旧 spec が daemon に残るので登記温存
   * 'forget-and-ensure'  (effect):     in-place 差し替えは失敗種別を問わず旧が消えている可能性が
   *                                    あるため、登記を必ず忘れて uncertain を立て、以後の宣言を
   *                                    ReplacePlugin(ensure) に誘導する
   */
  readonly failurePolicy: 'retain-on-reject' | 'forget-and-ensure'
}
```

`issueReplacement` の catch（`effect-slot.ts:332-337`）を分岐: `forget-and-ensure` では **error 種別を問わず** `chains.delete(key)` + `uncertainReplacements.add(key)`。`retain-on-reject`（instrument）は現行維持。

> なぜ effect は「常に忘れる」で正しいか: 旧が実は生きている失敗（in-flight 競合・Loading・quiesce timeout 等）でも、uncertain 経由の次回宣言は ReplacePlugin(ensure) を発行し、daemon 側の 1 段（Active 同一→冪等 / Active 異→差し替え / Empty→load）が実態へ収束させる。逆に instrument 方針（温存）を effect に流用すると、teardown 後失敗（旧消滅）で「同 spec 再宣言が冪等 no-op」になり dry のまま固まる（§6 FM-R9）。

**(2) `hasUncertain(key)` / `hasAnyUncertain()`（新設）** — linkAudio ゲート用（§3.6）。成功時 clear は既存（`effect-slot.ts:373`）。

**(3) `remove(key, expectedNormalizedName, occurrence)`（新設・Stage C）** — `declare` と同じ per-key `pending` キューへ直列に載せる（連打・declare との交錯を防ぐ）。本体:

1. chain 空 → throw `"<receiver>: remove(\"<name>\") — no effect insert is declared."`（uncertain 立っている場合は wire の UnloadPlugin を発行してから登記をそのまま空に確定する）
2. `chain[0].normalizedName !== expectedNormalizedName` → throw（現行 insert 名を含む文言・§3.8）。`occurrence !== 0` → throw（v1 は単一 insert）
3. hooks.beforeReplace（UI close + state 自動保存・§3.5）
4. `audioEngine.unloadPlugin('effect', bus)` — 失敗時: 種別を問わず `chains.delete` + `uncertainReplacements.add` + rethrow（forget-and-ensure と同じ理由）
5. 成功: `chains.delete(key)`・uncertain clear

**(4) 文言** — `issueReplacement` 冒頭の `'Instrument replacement requires the Rust engine backend.'`（`effect-slot.ts:292`）を `'Plugin replacement requires the Rust engine backend.'` へ（role 非依存化）。

### 3.5 TS: 3 manager + `Global` の hook 配線

- `PluginEffectManager` / `SequenceEffectManager` / `MixerManager`（makeKind 内の 2 面）のコンストラクタに hooks（`beforeReplace`, `onQuarantinedSlot?`, `failurePolicy:'forget-and-ensure'`）を注入する。注入元は `Global` コンストラクタ（instrument の `global.ts:172-190` と同型）。
- `Global.prepareEffectReplacement(receiverId, oldSlot)`（新設）: `prepareInstrumentReplacement`（`global.ts:1097-1140`）の effect 版。差分は (i) UI index は **1**（bus/seq とも effect は 1 始まり = `global.ts:838-845, 869-877`）、(ii) 保存 identity は `{receiver: receiverId, role:'effect', normalizedName, occurrence}` + daemonTarget `{role:'effect', bus: oldSlot.bus}`（`pluginStateTargetForSlot` = `global.ts:62-77` を再利用）。receiverId は master→`'master'`、seq→seqName、mixer→`formatReceiverId(kind,name)`（= `'sum:drums'` 形式・UI/E2E と同一 namespace）。
- 保存失敗 → throw（差し替え中止・旧無傷 = T3 意味論）。document directory 未設定 → warn 1 回 + 続行（T4 意味論）。
- `SequenceEffectManager.effect` の catch（`sequence-effect-manager.ts:130-158`）は無変更でよい: 差し替え失敗時は `hadBus === true` なので bus は返却されない（温存が正しい）。

### 3.6 TS: linkAudio ゲート

`Global.linkAudio()`（`global.ts:366-378`）の master 判定を `this.pluginEffectManager.hasDeclaration()` → `hasDeclaration() || hasUncertain()` へ。seq は `buses` map（失敗でも温存）、mixer は `buses` map（削除しない）でゲートが既に保たれるため master のみ補修する（§6 FM-R11）。`PluginEffectManager` に `hasUncertain()` を生やして `EffectChainMap.hasUncertain('master')` を委譲。

### 3.7 TS: `rust-engine-player.ts`

- `replacePlugin` の catch（`rust-engine-player.ts:1016-1026`）を role 分岐: `role==='effect'` は **error 種別を問わず** `loadedPlugins.delete(key)` + `pluginActiveByKey.delete(key)`（respawn 台帳から消す = dry 縮退宣言と一致・§6 FM-R10）。instrument 分岐は現行維持。
- `unloadPlugin(role, bus?)`（新設）: 成功時 `loadedPlugins.delete` + `pluginActiveByKey.delete`。失敗時も同様に delete（forget-and-ensure と対応）+ rethrow。

### 3.8 DSL 表面（Stage C）と診断文言

**remove の表面（SC.5 規範 6 準拠・`remove("名前"[, n])`）**:

| 経路 | 表面 | 委譲先 |
|---|---|---|
| master | `global.remove("Reverb")` | `PluginEffectManager.remove` |
| seq | `kick.remove("Reverb")` | `Sequence` → `Global.sequenceEffectRemove(name, ...)` → `SequenceEffectManager.remove` |
| sum/aux | `sum("x").remove("Reverb")` | `MixerBusHandle.remove`（`mixer-manager.ts:70-83` の interface に追加） |

- 語彙登録: `GLOBAL_DSL_METHODS` / `SEQUENCE_DSL_METHODS` / `BUS_DSL_METHODS`（`packages/engine/src/signal-chain/runtime.ts:7-77`）へ `'remove'` を追加。🔴 **載せ忘れるとエディタ評価が `Unknown chain method` で全滅する**（runtime.ts:52-53 の #528 再発警告・§6 FM-R23）。
- `Sequence.remove` は effect insert 専用: 名前が instrument の normalizedName に一致する場合は `"Sequence '<name>': remove() targets the effect insert; instrument removal is not supported in v1 (declare a different instrument to replace it)."` で明示拒否。
- 引数 `n`（出現順）は受理するが v1 は `0` のみ（それ以外は `"v1 supports a single insert; occurrence must be 0"`）。

**診断文言の変更点**:

1. 「chains reserved」系 3 文言（§0.1）は**残置**するが、replacement opt-in により異 spec 再宣言からは到達不能になる（到達するのは将来 maxLength>1 の実装時のみ）。`EffectSlotLimitError`（`effect-slot.ts:129-138`）も S4/#522 の消費予定があるため存置。
2. remove 名前不一致: `` `${receiver}: remove("${name}") does not match the declared insert '${current}'.` ``
3. quiesce timeout（新・daemon）: `"effect replacement quiesce ack timed out; the previous effect is kept"`（`WrapError::OutProcEffect` → `OUTPROC_EFFECT_RUNTIME`）。
4. teardown 後 attach 失敗は `load_outproc_plugin_impl` の既存文言をそのまま透過（`OUTPROC_ATTACH_FAILED` 等）。**テストは実装が実際に投げる文言をアンカーにする**（捏造禁止・引数名でなく説明部分をアンカー）。

### 3.9 spec 更新（Stage 0・実装より先）

🔴 SC.5 の注記だけでは足りない（main レビュー指摘）: **SC.3 規範4（`SIGNAL_CHAIN_DSL_SPEC_v1.md:98`）の括弧書き**が「新インスタンスの準備成功を待って原子的に切り替わり、失敗時は旧インスタンスが保持される（**SC.5 の後勝ち原則と同一の失敗モデル**）」と、prepare-commit 型を SC.5 の一般則として主張している。effect の in-place 方式（teardown 後の失敗は dry 縮退）はこの一般則に反するため、放置すると spec に false な文が残る。**採用: ②「SC.5 に失敗モデルを2型として明記し、SC.3 はそこを参照する」**（①の instrument 限定注記だけでは、effect 側の失敗モデルが spec のどこにも書かれない片翼になるため）。

1. `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` **SC.3 規範4** の括弧書きを次へ差し替える（Codex は文面をそのまま使うこと）:

   > 旧: （SC.5 の後勝ち原則と同一の失敗モデル）
   > 新: （SC.5 の失敗モデル (i) prepare-commit 型 — スロットに名前→実体の間接層があるレシーバに適用される）

2. 同ファイル **SC.5 の「v1 の現在地」注記**（L151-163 直下）を改訂:
   - 「v1 は同一内容の再宣言が冪等まで」を、(i) 単一 insert の**異 spec 再宣言 = 差し替え**（規範 4 の後勝ちの単一 insert 部分集合）と (ii) `remove("名前")`（規範 6）が v1 実装済み、へ更新。ブロック再評価（規範 4 全体）・チェーンは引き続き #522。
   - **失敗モデル 2 型の明記**を追加する（文面案・そのまま使う）:

   > **失敗モデルは 2 型ある（#625）**:
   > **(i) prepare-commit 型** — スロットに名前→実体の間接層があるレシーバ（v1 では instrument）。差し替えは新インスタンスの準備成功を待って原子的に切り替わり、失敗時は旧インスタンスが無傷で保持される。
   > **(ii) in-place 型** — スロットが bus 名で位置固定なレシーバ（v1 では effect insert: master / seq / sum / aux）。差し替えは同一スロットの建て直しで行われ、窓の間は dry 素通し（ソース音は途切れない・insert だけが一時的に外れる）。旧インスタンスの解体**前**に失敗した場合は旧 insert が保持され、解体**後**に失敗した場合は dry 素通しへ縮退する（無音にはならない）。縮退からの復旧は同じ宣言の再評価のみで行える（エンジン再起動不要）。差し替え・削除の直前に旧 insert の state は自動保存される。

3. `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` の PH.2b（seq.effect）/ MX.2-MX.3（sum/aux insert）/ master effect 節へ同内容（差し替え可・remove・失敗モデル (ii)）を反映（specs-v2 との乖離を作らない・フェーズゲート規則 7）。

---

## 4. 決定事項一覧（8 項目）

| # | 決定 | 根拠 | 確信度 |
|---|---|---|---|
| 1 | **swap 機構 = (a) in-place 建て直し**（quiesce ack 付き・§2.1）。(b)(c) 却下 | RT 変更ゼロ・窓は無音でなく dry・既存フラグ流用。(b) は shm×2/RT 改造の対価が「dry 窓の消滅」だけ。(c) は master 不成立 + PlayAt tag の入力側張り替え機構が無い（§2.3） | 高 |
| 2 | **teardown は共有プリミティブ再利用 + effect 専用 orchestration**。instrument 関数の role 汎用化はしない | instrument teardown の半分（note drain / tenant_generation / VoiceTable）は effect に対応物が無い（`OutProcEffectStats` に該当フィールド不在）。共有すべき下位関数（`detach_and_reset_control_run` 等）は既に role ジェネリック | 高 |
| 3 | **差し替え・削除の直前に自動 state 保存**（instrument #618 と同一。保存失敗=中止、doc dir 未設定=warn+続行） | `GetPluginState` は role 汎用・`statePathFallback` 配線済み（§0.4-6）。E5 型の swap-back 復元が effect でも成立する。owner の音色ループ要件（#546）と整合 | 高 |
| 4 | **失敗時不変条件: teardown 前=旧無傷 / teardown 後=dry 縮退 + forget-and-ensure**（旧の自動復元はしない） | 「旧を復元」は復元自体が失敗しうる入れ子構造。旧 state は直前保存済みなので、**復元機構は「旧 spec の再宣言」として既に存在する**。dry は無音でなく素通しなので演奏は止まらない。bus_active 維持で event retain を回避 | 高 |
| 5 | **`remove("名前")` を実装する**（4 経路・SC.5 規範 6 の表面・v1 は occurrence=0 のみ・instrument 削除は対象外）。**表面名はこのまま確定**（owner 確認不要 — main 裁定 2026-08-26） | issue title が "replace or remove"。聴き比べ（挿す→外す）は差し替えと同頻度の準備操作。**spec が正本**: SC.5 規範 6 が `remove("名前")`（出現順指定 `remove("名前", n)`）と明記済みで、`GLOBAL_DSL_METHODS`（`signal-chain/runtime.ts:7-35`）に `remove` は無く衝突も無い。将来の名前衝突は仮定の話で、spec の表面から外す理由にならない | 高 |
| 6 | **演奏中の差し替え・削除を許可**（dry 窓を仕様として明文化） | instrument が演奏中差し替えを既に許しており（E2E は LOOP 中に差し替える・`orbitstudio-mcp-gated.spec.ts:2291-2343`）、自動 state 保存も演奏中に成立実績あり。禁じると owner 動機（準備の反復）を殺す | 高 |
| 7 | **診断: 差し替え要求経路から「chains reserved」を消す**（文言自体は将来のチェーン上限用に残置）。backend 無し文言を role 中立化。quiesce timeout の新文言 | §3.8。誤答（差し替え要求にチェーンの話）は replacement opt-in で構造的に消える | 高 |
| 8 | **master / seq / sum / aux の 4 経路を同一 Stage で同時に解く** | daemon 側は slot ハンドルの違い（child_slot vs bus_slots[bus]）だけで、経路ごとの機構差が無い。段階を分けると T11 の書き換えが 2 度手間になり、E2E も 2 本要る | 高 |

---

## 5. 失敗モード一覧 ↔ 受け入れ基準テスト（1:1 対応表）

失敗モード **33 件**・対応行 **33 件**。**テストの無い失敗モード、対応する失敗モードの無いテストは無い。**

> **R28-R33 は実装後に追加された行**（main の変異検証 5 件 + Fable 監査 2 件の発見）。
> うち R28 と R33 は**テストではなく構造で閉じている** — 前者はコンパイラが、後者は型ではなく
> メモリ順序の指定が検出器である。1:1 を保つため、検出器が何かを列に明記する。
TS unit の新規置き場は `tests/core/plugin-effect-replace.spec.ts`（R* 番号）。rust unit は `engine_wrap.rs` 内 `effect_replace_tests` mod（instrument 版 fixture = `engine_wrap.rs:7940-` の sleep-child 方式を手本にする）。

| # | 失敗モード | どう壊れるか（状態遷移） | 検出するテスト | 種別 | 変異（このテストを意味あらしめる壊し方） |
|---|---|---|---|---|---|
| R1 | 異 spec 再宣言が旧来の恒久エラーのまま | declare → duplicateMessage throw、replacePlugin 未発行 | plugin-instrument.spec.ts **T11 改**「issues replacement for master, sequence, sum and aux effect managers」: 4 経路で `replacePlugin` が各1回・throw しない | unit | 各 manager から `replacement` オプションを外す → red |
| R2 | 差し替えが LoadPlugin で発行され daemon Active-reject | issueLoad → OUTPROC_EFFECT_RUNTIME | R2: 異 spec 再宣言で `loadPlugin` 0回・`replacePlugin` 1回・引数 `(resolvedPath, pluginId, 'effect', bus)`（`toHaveBeenCalledTimes` + 引数検証） | unit | `declareBody` の replacement 分岐を issueLoad へ差し替え → red |
| R3 | wire で bus/role が落ちる | ReplacePlugin params 不正（bus が instance に化ける等） | daemon-client.spec.ts「ReplacePlugin sends the effect bus spec」: seq は `{role:'effect', bus:'seq-bus-0'}`・master は bus キー**不在**を `not.toHaveProperty` で固定 | unit | daemon-client.ts の `...(bus ? { bus } : {})` を削除 → red |
| R4 | session が role='effect' を拒否し続ける | MALFORMED_REQUEST | session.rs 新 test `replace_plugin_accepts_effect_role`（both build で engine 関数到達）+ 既存 reject test の書き換え。instrument-only build は `OUTPROC_EFFECT_UNAVAILABLE` | rust unit | role 検証を `Some("instrument")` 固定へ戻す → red |
| R5 | 旧 child 残存 / 新旧 2 child 併存 | teardown 未実行のまま新 attach | rust unit `replace_active_tears_down_old_child_before_attach`（sleep-child fixture・旧 pid の kill -0 消滅を assert） | rust unit | teardown 呼び出しを削除 → red |
| R6 | 同一 spec 冪等が差し替えを発行（無意味な dry 窓） | Active 同一 → respawn | rust unit `replace_same_spec_is_idempotent`（`current_child_pid` 不変 + Ok）+ TS R6（同一 spec 再宣言で `replacePlugin` 0回） | rust unit + unit | 冪等分岐（Active 同一）を削除 → red |
| R7 | quiesce ack timeout 後に teardown 強行（RT と shm 並行操作） | reset_control_run と process_block の競合 | rust unit `replace_rolls_back_when_quiesce_ack_times_out`: done を立てない → Err + slot Active 温存 + engaged が true に復帰 + requested/done が false | rust unit | timeout 分岐を「継続して teardown」に変える → red |
| R8 | attach 失敗で bus_active が落ち PlayAt イベント retain | active=false + イベント滞留（`output.rs:311-316`） | rust unit `failed_replacement_attach_keeps_bus_active`: 存在しないパスで attach 失敗 → `bus_actives[bus]` true のまま + slot Empty | rust unit | 失敗時に `active.store(false)`（load_with_state の rollback 流用）を追加 → red |
| R9 | 失敗後 TS が旧 spec を信じ、再宣言が冪等 no-op → 永久 dry | chain 温存 → 同 spec 宣言が既存 load await で false success | R9: replace 失敗（DaemonProtocolError）→ `chainFor` 空 + **次の宣言（同 spec でも異 spec でも）が `replacePlugin` を発行** | unit | catch を instrument 方針（protocol error は温存）に変える → red |
| R10 | 失敗後 respawn が旧 A を replay し dry 縮退宣言と食い違う | loadedPlugins 残留 → reloadPluginsAfterRespawn が旧 A を再ロード | rust-engine-player unit R10: effect replacePlugin が protocol error → `loadedPlugins`/`pluginActiveByKey` から該当 key 消滅（respawn 再発行 0回を mock daemon で確認） | unit | catch の delete を非 protocol 限定（現行）に戻す → red |
| R11 | master 差し替え失敗後に linkAudio ゲート素通し | hasDeclaration()=false → PH.5 排他が破れる | R11: master replace 失敗後 `global.linkAudio()` が throw | unit | `hasUncertain` 参照をゲートから外す → red |
| R12 | 差し替え前の自動 state 保存が無く swap-back で音色喪失 | 旧 tenant state 未保存のまま teardown | R12: `ProjectStateStore.save` が旧 identity `{receiver, role:'effect', normalizedName, occurrence}` + `{role:'effect', bus}` で 1 回、`invocationCallOrder` で save < replacePlugin | unit | beforeReplace hook を no-op 化 → red |
| R13 | 保存失敗でも差し替え進行 → 旧喪失 | save reject 後に wire 発行 | R13: save reject → `replacePlugin` 0回 + chain 旧のまま（T3 mirror） | unit | beforeReplace の throw を握りつぶす → red |
| R14 | doc dir 未設定で差し替え自体が不能（過剰 fail-closed） | throw で中止 | R14: warn 1回（'document directory' を含む）+ replacePlugin 続行（T4 mirror） | unit | warn 分岐を throw に変える → red |
| R15 | UI を開いたまま差し替え → stale UI 簿記 / 旧 UI が新 tenant に貼り付く | close 未実施 | R15: 開いた UI がある状態で差し替え → `closePluginUi({role:'effect',bus}, 1)` が save より先（invocationCallOrder・T2 mirror） | unit | prepare 内の close 呼び出しを削除 → red |
| R16 | 同一 key 連打で並行 replace | 直列化欠落 → 交錯 commit | R16: T9 mirror（burst で maxConcurrent=1・最後の spec が chain に残る）+ rust unit `second_replace_while_in_flight_is_rejected`（"already in progress"） | unit + rust unit | TS: `declare` の pending 直列化をバイパス / Rust: in-flight guard 削除 → red |
| R17 | transport 断（結果不明）後の次宣言が LoadPlugin を出して Active-reject | uncertain 未設定 | R17: transport error（非 DaemonProtocolError）→ chain 空 + 次宣言が `replacePlugin`（ensure）を発行（uncertain-ensure mirror） | unit | `uncertainReplacements.add` を削除 → red |
| R18 | quiesce フラグ後始末忘れ → 以後の quiesce/stream teardown が stale done で即時偽 ack | requested/done が立ちっぱなし | rust unit `quiesce_flags_reset_after_successful_replace`: 成功後 requested=false・done=false を直接 assert + 2連続 replace が成立 | rust unit | フラグ reset（§2.1 手順6）を削除 → red |
| R19 | remove が bus を解放し routing 破壊 | pool.release → 参照中 bus 名が pool へ漏れる | R19: `seq.remove` 後 `getBus(seq)` が同一 bus・`hasDeclaration`（bus 簿記）true のまま | unit | remove 成功経路に `pool.release` を追加 → red |
| R20 | remove で bus_active が落ち event retain | active=false | rust unit `unload_keeps_bus_active_and_resets_slot_to_empty` | rust unit | unload に `active.store(false)` を追加 → red |
| R21 | remove の名前不一致で現行 insert を黙って削除 | 検証無しで unload | R21: `remove("wrong")` → throw（文言に現行 insert 名を含む）+ `unloadPlugin` 0回 + chain 温存 | unit | normalizedName 検証を削除 → red |
| R22 | remove 前の自動保存欠落 → 再宣言で音色が戻らない | 保存無しで teardown | R22: remove 実行で `ProjectStateStore.save` 1回（旧 identity）、save < unloadPlugin の順序 | unit | remove 経路の beforeReplace 呼び出しを削除 → red |
| R23 | `remove` の DSL 語彙載せ忘れ → エディタ評価が Unknown chain method | dispatch 拒否（#528 型） | interpreter unit R23: `global.remove(...)` / `kick.remove(...)` / `sum("x").remove(...)` が interpreter 評価を通って各 manager に到達 | unit | `GLOBAL_DSL_METHODS`/`SEQUENCE_DSL_METHODS`/`BUS_DSL_METHODS` から `'remove'` を外す → red |
| R24 | instrument 差し替えの退行（共通コード変更の巻き添え） | failurePolicy 導入・session 分岐で instrument 経路が変質 | 既存 suite 無変更 green: plugin-instrument.spec.ts T1-T9 ほか + rust instrument replace/teardown 群（`cargo test --features outproc-effect,outproc-instrument`） | unit + rust unit | （既存テスト群自体が #618 で変異検証済み。新たな変異は不要 — 変更差分がこれらを赤くしないことが検出条件） |
| R25 | master 経路の bus 混線（master 差し替えが bus slot を対象化 / 逆） | bus=None の解決誤り | rust unit `replace_without_bus_targets_master_slot`（master slot の状態遷移を assert）+ TS R25（master の wire params に bus 無し = R3 と相補） | rust unit + unit | `bus=None` を `bus_slots` 参照へ変える → red（unknown bus） |
| R26 | 実機で差し替えても音が変わらない / 削除が効かない / エラーが静黙（配線全長の断線） | ユニット緑のまま実機全滅（#528 型） | **gated E2E**（§6）: RMS 比 + PID + ERROR 計数 + 失敗注入 + remove + swap-back restore の複合オラクル | gated E2E | 実装の daemon 側 attach（手順7）を no-op にする → RMS 比が変化せず red（E2E がユニットの見えない配線を掴む位置にある） |
| R27 | stream 停止と差し替えの交錯で guard の quiesce が取り消される（§2.1.1） | 手順 6 の無条件 clear が guard の `requested=true` を消す → RT が done を立てず guard は timeout 満了で ack 無し停止 → 手順 7 の `engaged=true` で停止中の RT が shm を触る | rust unit `replace_respects_stream_shutdown_latch`: (i) `shutdown=true` 先行 → replace が Err "engine is stopping" + slot/フラグ無傷、(ii) 手順 6 相当の clear ヘルパ（`clear_quiesce_unless_shutdown`）を関数として切り出し、clear 中に shutdown が立った系列で `requested` が true に復元されることを assert | rust unit | clear ヘルパから shutdown 検査を外して無条件 store に変える → red |
| R28 | 同型 `Arc<AtomicBool>` の位置引数取り違え（`clear_quiesce_unless_shutdown` / `OutProcTeardownGuard::new` / `OutProcEffectPostProcessor::new`） | 兄弟フラグが入れ替わり、guard が誰も立てない flag を待つ／偽の ack を掴む。型検査は通る | **検出器 = コンパイラ**。引数を名前付き struct 1 つに畳み、取り違えを表現不能にした（`EffectSlotEntry` / `OutProcTeardownParts` / `OutProcEffectPostProcessorParts`） | compile | 3 引数へ戻す → `error[E0061]` |
| R29 | `engaged` の配線切断（entry / `ChildLaunch` / RT stage のいずれかが別 Arc） | dry 窓が無言で無効化。または attach 成功後も RT が engage せず**音が恒久的に dry** | `effect_slot_wiring_tests::{bus,effect_only_master,combined_master}_slot_shares_the_engaged_flag_across_entry_launch_and_render_stage` | rust unit | entry 側／`ChildLaunch` 側それぞれを別 Arc に差し替え → 3 経路とも red |
| R30 | shutdown latch の両端切断（guard と entry が別 Arc） | latch 機構全体が無言で無効。§2.1.1 が閉じた競合窓がそのまま開く | `effect_slot_wiring_tests::*_teardown_guard_latches_the_entry_shutdown`（3 経路） | rust unit | guard に別 Arc を渡す → 3 経路とも red |
| R31 | guard が latch より先に quiesce 要求を publish する | 差し替え側が `shutdown=false` を読んで要求を消し、再検査でも復元しない → ack 無し停止 | `outproc_effect::tests::teardown_guard_latches_shutdown_before_requesting_quiesce`（`latch_then_request` の中間状態を観測） | rust unit | 2 つの store を入れ替える → red |
| R32 | tenant handoff で前 tenant の `measurement_invalid` が残る | クラッシュループした effect を差し替えて復旧しても、health が daemon 再起動まで「計測無効」を報告し続ける（診断・E2E オラクルの偽陽性） | `effect_replace_tests::replace_clears_the_previous_tenants_measurement_invalid_verdict` | rust unit | teardown の reset を削除 → red |
| R33 | latch と clear の store-buffering レース（Dekker パターン） | `Release`/`Acquire` では再検査が stale な `shutdown=false` を読みうる → 要求が消え ack 無し停止（R27 が防ぐと主張する事象がメモリモデル層に残る） | **検出器 = メモリ順序の指定**。4 アクセスを `SeqCst` にして単一全順序で閉じる。**論理インターリーブでは再現不能なのでテストは存在しない**（`loom` 相当のみが検証手段・§9-6） | 構造（テスト不能） | いずれかを `Release`/`Acquire` に戻す → テストは緑のまま（だから構造で閉じている） |

---

## 6. gated E2E の設計（FM-R26 の実体）

`tests/e2e/orbitstudio-mcp-gated.spec.ts` へ 1 シナリオ追加（`#618 E1-E6`＝`orbitstudio-mcp-gated.spec.ts:2260-2518` を手本）。**並行機構は新設しない**。

- 宣言は**カタログ名のみ**（`list_plugins` から動的取得・フルパス直書き禁止）。fixture は既存の symlink 機構（`replaceGatedPluginFixtureSymlink` = L164-）を再利用。#623 対策の「カタログ候補が全体で1件」guard（#618 PR で導入済み）も再利用する。
- オラクル素材: CLAP Test Effect は state = gain（ORE1 + f64 LE・L1825-1833 で確認）。VST3 gain oracle（`rust/crates/orbit-vst3-gain-oracle`）が対になる。**A = CLAP effect（state gain 0.25 を project.yaml states に事前登録）→ B = VST3 effect（gain 1.0）**とすれば差し替え前後の区間 RMS 比 ≈ 4x が音のオラクルになる。
- 手順（capture_wav 起動 → 区間タイムスタンプ方式は #618 E1-E6 と同じ）:
  - **R-E1** `seq.effect(clapEffectName)` + LOOP 再生 → 旧 child PID 記録・区間 RMS（減衰済み）
  - **R-E2** LOOP 中に `seq.effect(vst3EffectName)` → 新 PID 出現・旧 PID 消滅・ERROR 増 0・区間 RMS 比で音が変わったことを確認
  - **R-E3** 失敗注入: `seq.effect("/definitely/nonexistent/Issue625.vst3")` → エラーが surface（evaluate error or get_log ERROR 増）+ **B の音でも A の音でもなく dry**（区間 RMS が effect 無しの基準値と一致）+ 音は止まらない
  - **R-E4** 復旧: `seq.effect(vst3EffectName)` 再宣言だけで B の音へ戻る（再起動なし）
  - **R-E5** swap-back: `seq.effect(clapEffectName)` → project.yaml states の A identity（`<seq>/effect/<name>/0`）が存在し `[plugin-state] restoring '<identity>'` ログが出る + RMS が A の減衰値へ戻る
  - **R-E6** `seq.remove(clapEffectName)` → RMS が dry 基準へ + child PID 消滅 + `seq.output`/`send` routing がエラー無く継続（get_log ERROR 増 0）
  - **R-E7** master 経路の最小確認: `global.effect(catalogName)` → 異名へ差し替え → ERROR 増 0 + PID 交代（bus 系と slot が別物であることの実機確認・FM-R25 の実機面）
- ゲート env（`ORBIT_GATED_ORBITSTUDIO=1`）未設定時に skip されること（既存 `it.skipIf(!appAvailable)` 慣行）。

---

## 7. 実装手順（Codex 向け・ファイル単位）

> 各 Stage の終わりに記載の検証コマンドを回し、**新規テストは必ず変異検証**（該当 FM 行の変異を適用 → red 確認 → restore → green 確認、実出力を保存）してから次へ進む。変異のバックアップは `$TMPDIR` を使う（/tmp 直書き禁止）。

**Stage 0 — spec 更新（docs のみ）**
1. `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` **SC.3 規範4 括弧書きの差し替え + SC.5 v1 現在地の改訂 + 失敗モデル2型の明記**（§3.9-1,2 の文面案をそのまま使う）
2. `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` 該当節（§3.9-3）
3. `docs/research/ENGINE_DAEMON_PROTOCOL.md` に ReplacePlugin(role=effect)/UnloadPlugin 追記
- 検証: レビューのみ（ビルド不要）。remove() の表面は `remove("名前")` で確定済み（決定 5・owner 確認不要）

**Stage A — Rust daemon（engine_wrap.rs / outproc_effect.rs）**
1. `EffectSlotEntry`（`shutdown` latch 含む・§2.1.1）+ `OutProcControl` 拡張（`master_entry`/`bus_entries`/`replacements_in_flight`）。`grep -n "OutProcControl {"` で構築箇所を全列挙して埋める。`OutProcTeardownGuard::new` の第3引数化（🔴 呼び出し箇所は **6 箇所すべて**: `engine_wrap.rs:578, 2343, 2578` + `outproc_effect.rs:951, 967, 1403`。後3者はテスト。main が `grep -n "OutProcTeardownGuard::new" rust/crates/orbit-audio-daemon/src/*.rs` で全数確認済み — 初稿は `951` のみを挙げており列挙が不完全だった）
2. `replace_outproc_effect_plugin` / `teardown_outproc_effect_slot` / `clear_quiesce_unless_shutdown`（§2.1 / §2.1.1 / §3.1）
3. rust unit: FM-R5/R6/R7/R8/R16(rust)/R18/R25/R27（fixture は instrument 版 `engine_wrap.rs:7940-` の sleep-child 方式を effect 用に写す。quiesce 成功系は「requested を観測したら done を立てる」ヘルパスレッドで ack）
- 検証: `cd rust && cargo clippy --all-targets --features outproc-effect,outproc-instrument && cargo test --features outproc-effect,outproc-instrument`（🔴 feature 無しだと該当テストが 1 件も走らない）

> 🔴 **Stage B 実装者への申し送り**（#625 Fable 監査 C-3・実装前に読むこと）:
> 1. **Empty-ensure 分岐は in-flight 予約を取らない**（`replacements_in_flight.insert` より前に
>    return する）。同一 bus への ensure が並行すると slot の `Loading` で直列化はされるが、
>    2 発目のエラー文言は replace 用ではなく「load already in progress」になる。
>    **TS の per-key pending 直列化を守ること。daemon 側の直列化を過信しない。**
> 2. `ReplacePlugin` は session の read ループを **quiesce 500ms + attach（最大
>    `CHILD_READY_TIMEOUT` = 60s）** ブロックする。effect は「演奏中に差し替える」のが主用途
>    なので、DaemonClient のタイムアウトが 60s より短いと
>    client timeout → forget-and-ensure → 次宣言が `Loading` reject、という**見かけ上の
>    エラー連鎖**が起きうる（最終的には収束する）。タイムアウト値を確認すること。
> 3. `ReplacedPluginSummary.quarantined_slot` は **effect 経路では常に false**（隔離は `Err` で
>    表現する）。instrument の `onQuarantinedSlot` パターンを流用するとき、effect の隔離検知を
>    このフラグに期待しないこと（`OUTPROC_SLOT_CLOSED` への再宣言応答で知る）。
> 4. **宣言済み bus へ `LoadPlugin` を再送する形を作らないこと。** 失敗 rollback の
>    `active.store(false)`（`engine_wrap.rs` の初回宣言経路）に落ちると、当該 bus は RT stage を
>    スキップし**無音 + event retain**になり、以後の replace が quiesce ack を永遠に得られない
>    詰み状態になる。respawn replay は「fresh daemon にのみ `LoadPlugin`」を維持する。

**Stage B — wire + TS 差し替え**
1. `session.rs` ReplacePlugin role 分岐（§3.2-1）+ 既存 reject test 書き換え（FM-R4）
2. `protocol-types.ts` / `types.ts` / `daemon-client.ts`（§3.3。UnloadPlugin 型はここで先に足してよい）
3. `effect-slot.ts`: `failurePolicy` + `hasUncertain`（§3.4-1,2）+ 文言（§3.4-4）
4. `rust-engine-player.ts` catch の role 分岐（§3.7）
5. 3 manager + `Global.prepareEffectReplacement` + hooks 注入（§3.5）+ linkAudio ゲート（§3.6）
6. TS unit: T11 改（FM-R1）+ `tests/core/plugin-effect-replace.spec.ts` R2/R6/R9/R10/R11/R12/R13/R14/R15/R16/R17 + daemon-client.spec 追加（FM-R3）
- 検証: `npm run build && npm test`。既存 suite 全 green（FM-R24）

**Stage C — 削除（remove）**
1. `engine_wrap.rs` `unload_outproc_effect_plugin` + rust unit（FM-R20）
2. `session.rs` UnloadPlugin ハンドラ（§3.2-2）
3. `effect-slot.ts` `remove()`（§3.4-3）+ manager/`Global`/`Sequence`/`MixerBusHandle` の表面（§3.8）+ 語彙 3 セット（FM-R23）
4. TS unit: R19/R21/R22/R23
- 検証: Stage A と同じ cargo コマンド + `npm test`

**Stage D — gated E2E + 実機ゲート**
1. §6 のシナリオを `orbitstudio-mcp-gated.spec.ts` へ追加（FM-R26）
2. `npm run build:clean` → 起動中 OrbitStudio を終了 → `ORBITSCORE_MCP_PORT=39123` で起動 → `ORBIT_GATED_ORBITSTUDIO=1` で E2E 実行
3. マージ前ゲート: 実機で本 PR の DSL 表面（差し替え・remove）を `evaluate_orbitscore` し、`get_log` に ERROR が無いことを確認（`ok` だけで判断しない）
- 検証: E2E green + capture WAV のアサーション全通過。E2E 出力は tail で切らずファイルへ全文保存

---

## 8. 触ってはいけないもの

1. **`audio` シーケンスの `play()` 意味論**（一切変更しない — 全フェーズ共通規則 5）
2. **instrument 差し替えの挙動**（`replace_outproc_instrument_plugin` / `teardown_outproc_instrument_*` / T1-T9 の意味。failurePolicy 導入は instrument 側を現行値 `'retain-on-reject'` に固定して無変更に保つ）
3. **RT コード**: `orbit-audio-native`（`InsertBusStage` / render 経路）と `OutProcEffectPostProcessor::process` — 本設計は既存フラグの読み手を変えない
4. **`bus_actives` の意味論**: 差し替え・削除・失敗のどの経路でも「一度 true になった bus を false へ戻さない」（§3.1-5）。既存の初回宣言失敗 rollback（`engine_wrap.rs:2984-2990`)は現行のまま
5. **bus pool の簿記**: 差し替え・削除で `BusPool.release` を呼ばない（routing が bus 名を参照し続ける）
6. **既存判定の再実装禁止**: slot 検分は `load_outproc_plugin_impl` の Active 4 分岐を、冪等/ensure は instrument 版の分岐構造を、それぞれ**呼び出しまたは同型移植**で使う。新しい比較ロジックを発明しない
7. `.serena/` `.git` `.env` 系
8. WORK_LOG.md 更新をコミットごとに行う（プロジェクト規則）

---

## 9. 確信度が低い決定と反証方法

1. **quiesce ack timeout 時のロールバック（engaged=true 復帰）が安全か** — 確信度: 中。ack が返らない典型は RT callback の停止（device 喪失等）で、その場合 engaged 復帰は単に「dry のまま」で害はない、と推論している。反証方法: rust unit FM-R7 に「timeout 後に遅れて ack が来る」ケースを足し、遅延 ack 後に旧 tenant の process が再開しても transport 不整合が起きない（reset_control_run を呼んでいないので旧 child と transport は無傷）ことを確認する。
2. **`reset_control_run` と RT `process_block` の並行が実際に危険か**（= ack を必須にした根拠） — 確信度: 中。`orbit_audio_sandbox::transport` の実装（atomics のみか否か）までは精読していない。反証方法: `reset_control_run` と `PipelinedEffectHost::process_block` が触る共有ワードを列挙し、全て atomic なら「UB ではなく論理レースのみ」と格下げできる。**ただし反証されても設計は変えない**（instrument が確立した ack 付き teardown と同型を保つ方が安い・memory「既存機構を借りるなら不変条件も継承する」）。
3. **effect の failurePolicy「常に忘れる」が唯一の失敗で不利になるケース** — 確信度: 中〜高。忘れた後の収束は uncertain-ensure が保証する（§3.4-1 注記）が、「ユーザーが再宣言しないまま daemon respawn」した場合に旧 A が復元されない（dry のまま）のは仕様side effect。反証方法: R10 の変異検証と、E2E R-E3→R-E4 で「再宣言だけで復旧」を実機確認。owner がこの縮退を不可とするなら、respawn 台帳のみ温存する変種（loadedPlugins 温存 + pluginActiveByKey false）へ差し替え可能（1 箇所の変更）。
4. **dry 窓の長さが実用上許容か** — 確信度: 中。child spawn + dlopen + READY の実測を本設計では取っていない（instrument E2E の swap が音切れなく通っている事実からの類推）。反証方法: E2E R-E2 で差し替え要求〜新 PID 出現までの wall time を記録し、5 秒を超えるようなら設計注記へ実測値を残す（機構の変更は不要・期待値の明文化のみ）。
5. **shutdown latch の clear-復元プロトコル（§2.1.1 手順6）が競合窓を完全に閉じるか** — 確信度: 中〜高。「clear 後の再検査で復元」は guard の `shutdown=true → requested=true` の store 順序（Release）と、差し替え側の clear→再検査の順序に依存する。反証方法: R27 の変異検証に加え、`loom` 相当の順序列挙（または clear ヘルパへの人為的 sleep 注入）で「guard drop がどの位置に割り込んでも requested が最終的に true になる」ことを机上でなく実行で確認する。復元が遅延しても guard の実害は `TEARDOWN_TIMEOUT` 内の待ち増加のみ（安全側に倒れる）。

---

6. **`SeqCst` 化で store-buffering レース（R33）が本当に閉じたか** — 確信度: 高（C++/Rust
   メモリモデルの標準的帰結）だが、**実行では確認していない**。論理インターリーブでは再現
   できない層なので、既存のテスト（`after_clear` 注入・`latch_then_request` の中間観測）は
   この性質について何も言わない。反証方法: `loom` で「3 フラグ・2 スレッド」のモデルを書き、
   `Release`/`Acquire` 版で SB 実行が列挙され `SeqCst` 版で消えることを確認する。
   これを入れるかどうかは follow-up 判断（`loom` は現在この repo の依存に無い）。

## 10. 未解決の疑問（解釈で埋めていない）

1. **`active_plugin_notes`（`engine_wrap.rs:207`）— 解決済み（main が全参照を列挙・2026-08-26）**: 参照は宣言（:207）/ 初期化（:2650）/ note_on insert（:4133）/ note_off remove（:4163）の**4箇所で全部**であり、**reader は存在しない**。フィールド doc が主張する「live note がある間 state 保存を fail-closed に拒否」は実装されていない。帰結: 決定 3（差し替え直前の自動 state 保存）が演奏中に note で阻まれる懸念は無く、本設計は無変更でよい。doc と実体のずれ自体は #625 の範囲外（follow-up issue 扱い。修正するなら「実害を1文で書けるか」の基準で起票判断）。
2. **#623（重複プラグインの先勝ち/後勝ち不一致）**: 差し替えの同一性判定は resolvedPath ベースなので、重複インストール環境では「同名カタログ名の再宣言」が意図しない実体を指しうる。本設計は E2E setup の一意性 guard 再利用で防御するに留め、製品側の解決は #623 の owner 判断（spec 先行）を待つ。
3. **remove 後の `EffectSlotLimitError` の将来**: S4/#522 のチェーン実装時に duplicateMessage 経路が復活する。その際の文言はチェーン上限の文言として正しくなるため本 issue では触らない、という判断で良いか（#522 実装者への引き継ぎ事項）。

---

## Appendix: 根拠として参照した主な実ファイル位置

- TS: `effect-slot.ts:122-127, 153, 226-284, 286-375, 377-462` / `plugin-effect-manager.ts:23-56` / `sequence-effect-manager.ts:92-160` / `mixer-manager.ts:95-156, 330-359` / `daemon-client.ts:443-517` / `protocol-types.ts:18-56` / `types.ts:14-20, 100-117` / `rust-engine-player.ts:942-1027, 1100-1134` / `global.ts:62-77, 151-190, 366-378, 725-890, 1097-1140` / `signal-chain/runtime.ts:7-77` / `sequence.ts:660-680`
- Rust: `engine_wrap.rs:249-278, 426-529, 536-591, 954, 1016-1067, 1099-1160, 1479-1718, 1722-1743, 1820-1828, 2240-2350, 2926-2992, 3008-3115, 3119-3164, 3172-3335, 3343-3492, 3674-3771, 3774-3995, 5329-5355, 7940-` / `session.rs:1393-1651, 1654-1711, 2238-2295` / `outproc_effect.rs:310-395, 771-798` / `orbit-audio-native/src/output.rs:250-410`
- テスト: `tests/core/plugin-instrument.spec.ts:1-587（T1-T11）` / `tests/audio/rust-engine/daemon-client.spec.ts:270-380` / `tests/e2e/orbitstudio-mcp-gated.spec.ts:2260-2518`
- 仕様: `docs/specs-v2/SIGNAL_CHAIN_DSL_SPEC_v1.md` SC.5（L151-163）・SC.8 / issue #625 / #618 / #623
