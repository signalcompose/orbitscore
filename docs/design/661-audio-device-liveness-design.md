# #661 PR-V4 — デバイス指定を「無音のまま放置しない」形にする

**起案**: Fable（effort high・2026-09-04） / **審査・実測検証**: main（同日） /
**実装**: Codex / **検証**: main（sandbox 外・実機）

> 🔴 本書の「テスト対応表」は**テスト対象の一覧**として読む。検証手段は CLAUDE.md
> 「テストの積み上げ規律」で決め直す（設計書は本規則を上書きできない）。

---

## 1. 背景

`orbitscore.audioDevice` を設定すると**音が一切出なくなる**（エラーも警告も無し）。
2026-08-31 の本番直前に踏み、**演奏が 1 時間以上止まった**。
daemon の CPU 0.0% ＝ オーディオコールバックが一度も回っていなかったのに、
ストリームは構築され `play()` も成功していた。

**PR-V3**（同ブランチ・実装済み）が計器を入れた: `StreamStats` に `callbacks` / `last_frames`、
`GetStatus` に `output.{device_name,sample_rate,channels}` と `callback.{count,alive,last_frames}`。

---

## 2. 🔴 main が実測したこと（2026-09-04・この機）

### 2.1 故障はこのハードウェアでは再現しない

PR-V3 の計器で 4 パターンを測った（起動 → 2 s と 5 s で `GetStatus` → Δcount）:

| 起動引数 | `output.device_name` | Δcount / 3 s | 判定 |
|---|---|---:|---|
| （引数なし） | MacBook Proのスピーカー | 281 | ✅ LIVE |
| `--audio-device "MacBook Proのスピーカー"`（＝既定を名指し） | 同上 | 281 | ✅ LIVE |
| `--audio-device "Pro Tools Aggregate I/O"` | Pro Tools Aggregate I/O | 282 | ✅ LIVE |
| `--audio-device "NoSuchDevice"` | MacBook Proのスピーカー（縮退・警告あり） | 282 | ✅ LIVE |

この機の出力 2 台はどちらも **48000 Hz**。issue の失敗デバイス「外部ヘッドフォン」は
**44100 Hz** で、残る仮説はサンプルレート不一致。**根本原因は手元で観測できない。**

⚠️ `ps -Ao pid,%cpu` では 4 パターンとも 0.0% で**判別できなかった**
（%cpu はプロセス生涯平均なので 6 秒の idle では潰れる）。**判定できたのは PR-V3 の計器だけ。**

### 2.2 🔴 新発見: 名指しデバイスからの切替で**旧ストリームが生き続ける**

| 実験 | 期待 callbacks/s | 切替後の実測 | 判定 |
|---|---:|---:|---|
| **名指し**で起動 → host 既定へ切替 | 93.8 | **188.0（2.01×）** | 🔴 旧ストリーム生存 |
| 対照: 引数なしで起動 → 名指しへ切替 | 93.8 | 94.0（1.00×） | ✅ 単一 |

**原因（cpal 0.15.3 の一次ソース）**:

- `build_output_stream_raw` は `!self.is_default` のとき `add_disconnect_listener` を呼ぶ
  （`macos/mod.rs:721`）
- `add_disconnect_listener` は `let stream_copy = stream.clone()` を closure に move し、
  その listener を **`stream_inner._disconnect_listener` に格納**する（`:456-470`）
  → **`StreamInner` → listener → closure → `Arc<StreamInner>`** の強参照循環
- `AudioUnit` の停止・破棄は `Drop` でしか起きない。cycle を切る `Drop` は無い
- `host.devices()` 由来の `Device` は**既定デバイスであっても `is_default: false`**
  （`enumerate.rs:86`）。つまり `--audio-device <既定の名前>` でもこの経路

**帰結**: 名指しデバイスから切り替えると、**同じ `engine` / `render_state` を 2 本の
コールバックが叩く**。doc 662 §5.3 が「窓は極小」と書いた二重レンダが**恒久化**する。

⚠️ **未検証**: 2 本が `RenderState.transport.cursor_frames` を両方進めるなら**時間が倍速**になる。
`render_contentions` は 0 のままだったが、アイドル時はレンダが数マイクロ秒なので衝突しないだけで、
二重ストリームの存在を否定しない。**実装後に必ず確かめること**（§6 の C-6 / D-3）。

### 2.3 起動前の daemon stderr は成功時に捨てられる（Fable の発見・main 未検証）

`daemon-client.ts:881-912` は ready line まで stderr を `stderrChunks` に**蓄積するだけ**で、
参照はエラー経路のみ。つまり既存の縮退警告（`output.rs` の `eprintln!`）は
**今日も `get_log` に出ていない**。issue「直すべきこと 2」は daemon 側だけでは達成できない。

🔴 **実装の最初にこれを実機で確かめること**（`--audio-device NoSuchDevice` で起動し
`get_log` に `[audio-device]` 行が無いこと）。無ければ Fable の読解が正しい。

---

## 3. 🔴 確定事項（再議論しない）

| 事項 | 決定 | 出どころ |
|---|---|---|
| **無音時の振る舞い** | **起動時 = host 既定へ縮退して起動成功**／**ライブ切替 = 元のデバイスへ復帰**。どちらも ERROR ログ + `GetStatus` に理由 | **owner 2026-09-04**（原則「利用者を無音のまま放置しない」） |
| **ライブ切替でレートが違う場合** | **拒否してエンジン再起動へ誘導**（device のノミナルレートは変えない） | `662-engine-visibility-and-limits.md` §6.1「サンプルレート = 🔴 再起動」 |
| **本 PR のスコープ** | 「44100 で死ぬ原因の修正」は**含めない**（再現できない）。**検出と縮退まで** | main 判断（§2.1）。根本原因は別 issue |

---

## 4. 設計

### 4.1 ゲートは「デバイス確定の前」に置く

```
resolve_output_device(request)                     -- 既存（eprintln! を撤去し理由を値で返す）
  → probe_output_device(device, config, deadline)  -- 新規: 最小 stream を build → 最初の callback を待つ → pause → drop
       dead → 起動時: host 既定を同じ手順で probe（1 回だけ）
              切替時: Err（呼び出し側が旧 stream を再開）
  → LiveOutputDevice { device, name, config, sample_format, requested, fallback }
  → Engine::new / ensure_buffer_len / capture ring -- 既存（確定済み rate で作る）
  → build_stream(&live, ...) → play()
  → confirm_first_callback(stats, deadline)        -- 事後条件。dead → StreamDead（再縮退しない）
```

🔴 **`play()` 直後だけに置いてはいけない。** `start_output_inner` は `insert_buses` / `sources` を
`RenderState` に **move** するので、dead 判定後に作り直すには回収が要る。§2.2 の参照循環により
**名指しデバイスでは `Arc::try_unwrap` が永遠に失敗し、回収できない**。
前置き probe は共有状態を持たないのでこの問題が起きない。

**副産物**: probe でデバイスを先に確定すれば、縮退でレートが変わっても
`Engine::new(sample_rate, channels)` は**確定後に 1 回だけ**作られるので作り直しが発生しない。

### 4.2 待ち時間

**`FIRST_CALLBACK_DEADLINE = 3000 ms`・poll 10 ms・最初のコールバックで即抜け**（定数は 1 箇所）。

- 正常系のコストは最初のコールバックまで（実測 Δ281/3 s ≒ 10.7 ms 周期）。**probe + 事後確認で +20〜40 ms**
- deadline の長さは**失敗時にしか効かない**
- 1500 ms を採らない理由: Bluetooth / Aggregate の初回 IOProc 遅延が**未実測**。
  false-dead は「設定したデバイスと違うデバイスから音が出る」＝ #661 と同じ型の混乱を
  **正常な環境で**作る。true-dead を 1.5 s 遅く検出する害は無い
- 予算: 起動は TS の ready timeout 10 s。probe 3 s × 2 候補 + 事後確認（再縮退しない）で収まる

### 4.3 縮退は固定長 2・再帰しない

| 場面 | 候補 | 全滅時 |
|---|---|---|
| 起動（`--audio-device X`） | `[resolve(X), host default]` | `ready:false` + `DEVICE_CONFIG_ERROR` |
| 起動（引数なし） | `[host default]` | 同上 |
| 切替 | `[resolve(X)]` のみ | `Err`・旧 stream 無傷 |
| 実 stream の事後確認 | — | 起動: `ready:false`／切替: 新を pause+drop → 旧を `play()` → `Err` |

- `X` が既定と同名でも 2 候補目を試す価値がある: 1 候補目は `devices()` 由来（**HalOutput**）、
  2 候補目は `default_output_device()` 由来（**DefaultOutput unit**）で **AudioUnit の種類が違う**
  （`mod.rs:474`）。#661 の失敗デバイスは `isDefault: true` だったので、
  **この 2 段が実際に #661 を救う可能性がある**
- 「host 既定すら鳴らない」で `ready:false` にする理由: owner 原則を満たす唯一の方法が
  **起動を loud に失敗させる**こと。`ready:true` + イベントでは #661 と同じ形に戻る

### 4.4 🔴 捨てるストリームは必ず `pause()` してから drop する

§2.2 の参照循環は cpal 側の問題で、こちらからは切れない。
**`pause()`（= `audio_unit.stop()`）を明示的に呼べばコールバックは止まる**（leak は残る）。

`impl Drop for OutputStream { let _ = self._stream.pause(); }` を置き、
`apply_device_switch` は **旧を pause → 新を build/probe → 成功なら差し替え / 失敗なら旧を `play()`** とする。
その処理全体の `Result` は成功・失敗とも `record_device_switch_result` へ合流させる。この関数だけが
切替結果のログと状態を記録し、成功時は実効構成を一括差し替えて `last_switch_failure` を消去、失敗時は
実効構成を保持したまま `StreamConfigSnapshot.last_switch_failure` に理由を残して `tracing::error!` を出す。
したがって RPC の一過性エラーを見逃しても、その後の `GetStatus.output.last_switch_failure` で直近の失敗を
観測できる。

### 4.5 ログの層

| 事象 | daemon | TS | `get_log` |
|---|---|---|---|
| 起動成功（縮退なし） | `tracing::info!` | `establishSession()` の `getStatus()` 後に `🔊 output: "N" @ 48000 Hz × 2ch (first callback 12 ms)` | INFO 1 行。**正常系で ERROR は増えない** |
| 起動時の縮退 | `tracing::warn!` | `❌ audio device fallback: requested "X" → using "N": <reason>` | **ERROR 1 行**（縮退時のみ） |
| 起動全滅 | `tracing::error!` + `ready:false` | `DaemonStartupError` に stderr 全文 | 既存経路 |
| 切替失敗 | `tracing::error!` + RPC error（`AUDIO_DEVICE_STREAM_DEAD` / `AUDIO_DEVICE_RATE_MISMATCH`） | `❌ live device switch to "X" failed: …` | ERROR 1 行。理由は以後も `GetStatus.output.last_switch_failure` に残る |

🔴 **native（`output.rs`）は一切 print しない。** `eprintln!` を撤去し、縮退理由を
`DeviceFallback { reason }` として値で返す。理由: (1) §2.3 で起動時は無意味
(2) `eprintln!` は subscriber 稼働後に panic しうる（#612）(3) native は `tracing` に依存していない。

⚠️ **daemon の stderr は engine 側で ERROR として分類される**（memory `stderr-is-classified-as-error`・
4 回再発）。**正常系では 1 行も増やさない**こと。

---

## 5. 実装手順（Codex へ）

前提: 触ってよいのは `output.rs` / `engine_wrap.rs` / `session.rs` / `protocol.rs` / `main.rs` /
`backend.rs` / `rust-engine-player.ts` / `repl-mode.ts` / `engine-view.ts` / 新 gated Rust test /
gated spec / WORK_LOG。**`Engine` / `Scheduler` / audio `play()` 意味論 / DSL には触らない。**

1. **`output.rs`: 縮退を値にする** — `DeviceFallback { requested, reason }`。
   `resolve_output_device` → `ResolvedOutputDevice { device, name, fallback }`。`eprintln!` 2 箇所を撤去
   （理由文字列は現行の文言を維持）
2. **`output.rs`: `OutputFault` と probe**
   - `OutputFault { None, DeadProbeRequested, DeadAllProbes, DeadRealStream }`（既定 `None`）
   - `OutputDeviceRequest { name: Option<String>, fault: OutputFault }`
   - `FIRST_CALLBACK_DEADLINE = 3 s`（**1 箇所**）
   - `probe_output_device(...)`: `build_output_stream_raw` で zero-fill + `AtomicU64` の最小 stream →
     10 ms poll → **必ず `pause()` してから drop**。`Ok(None)` = dead
     - 🔴 **共有の `StreamStats` を使わない**（ticker の `callbacks` を汚す）。probe 専用の counter
     - `config` は実 stream と**同一**（`BufferSize::Fixed(buffer_frames)` を含む）
   - `LiveOutputDevice`（全 private + getter）・`select_live_output_device(...)`（候補列 §4.3）
   - `OutputError` に `StreamDead { device, waited_ms }` / `SampleRateMismatch { device, device_rate, engine_rate }`
3. **`output.rs`: 型で配線を固定** — `build_stream(live: &LiveOutputDevice, ...)` にして
   `&Device, &StreamConfig, SampleFormat` を受け取れなくする（**ゲートを迂回した構築がコンパイルできない**）。
   `confirm_first_callback`。`OutputStream` に `requested / fallback / first_callback_ms` を足し
   **`impl Drop { pause() }`**。`rebuild_output_stream` は `expected_sample_rate` を受け取りレート不一致を拒否
4. **`engine_wrap.rs`** — `StartupOptions { device_name, fault }` と `from_env()`
   （fault は `ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1` のときだけ解釈。既存 `InjectFault` と同じ型）。
   `StreamConfigSnapshot` に `device_requested` / `device_fell_back` / `fallback_reason` /
   `first_callback_ms` / `last_switch_failure`。`apply_device_switch` を §4.4 の順序にし、成否を
   `record_device_switch_result` で一括記録する
5. **`session.rs` / `protocol.rs`** — `GetStatus.output` に上記 5 フィールド追加（既存は不変）。
   エラーコード 2 つを追加
6. **`main.rs`** — `set_var("ORBIT_AUDIO_DEVICE")` を撤去し `StartupOptions` を typed で渡す
7. **TS 3 ファイル（各 1〜3 行）** — §4.5 のログ
8. **テスト** — §6
9. **docs** — 本書の参照を `662-performance-and-visibility-design.md` §5.2/§5.3 に反映・WORK_LOG

🔴 **やってはいけないこと**: `StreamStats` を probe に流用 / 捨てる stream を pause せず drop /
`Engine` をレート変更で作り直す / `eprintln!` を残す / 事後確認で再縮退 /
`expectNoNewErrors` を `toBe` に書き換える / `dsl-e2e-coverage` の baseline を触る /
`npm run build` を走らせる / git 操作。

---

## 6. テストと受け入れ

**順序は CLAUDE.md の「E2E > 機能テスト > 変異」。変異検証は回さない**（C-6 が常設の代わりになる）。

### ユニット（hardware 不要）

`parse_output_fault` / `StartupOptions::from_args_and_env` / `SampleRateMismatch` の判定 /
`confirm_first_callback` の境界 / `GetStatus` の新フィールド（StubBackend）。

### gated Rust（実機・`--ignored`・新規 `tests/audio_device_gate_gated.rs`）

fault は **env ではなく `StartupOptions` に typed で**渡す。

| # | 検査 |
|---|---|
| C-1 | 正常: `device_fell_back == false`・`callbacks` 前進・`first_callback_ms < 3000` |
| C-2 | `DeadProbeRequested` → `device_fell_back == true`・reason に "no callback"・**縮退先が生きている** |
| C-3 | `DeadAllProbes` → `Err(StreamDead)` |
| C-4 | `DeadRealStream`（起動）→ `Err(StreamDead)`（**再縮退しない**） |
| C-5 | 切替失敗で**旧が止まらない**: `apply_device_switch` の前後で `callbacks` が途切れず前進し、`last_switch_failure` に理由が残る |
| **C-6** 🔴 | **切替成功で二重レンダにならない**: 名指し起動 → `apply_device_switch(None)` → 1 s の Δcallbacks が `sample_rate / last_frames` の **±30 % 以内**（2 倍なら旧 stream が生きている）。**`Drop` の `pause()` を外すと red になること**を main が 1 回手で確認し、実出力を貼る |

### gated MCP E2E（ユーザー動線・`orbitstudio-mcp-gated.spec.ts`）

| # | 検査 |
|---|---|
| D-1 | **縮退の報告（注入なし）**: `select_audio_device("NoSuchDevice-<uuid>")` → `get_log` に `❌ … fallback … not found` が**増える**（`toBeGreaterThanOrEqual(before+1)`）→ `🔊 … output:` が出る |
| D-2 | **dead device を指定しても音が出る（注入あり）**: 縮退後に `runScore(.., {capture:true})` で **RMS > 0** |
| D-3 | **切替失敗で音が止まらない**: 鳴っている状態で失敗する切替 → `ok:false` + reason → 要求名と理由を持つ ERROR が 1 行増え、その後は増えない |

🔴 **D-1 は実装前に書いて red を確認する**（§2.3 の実証を兼ねる）。

### 受け入れ

1. `cargo test -p orbit-audio-native -p orbit-audio-daemon` 全緑 + `clippy --all-targets` +
   **cfg 5 feature すべて**（`check-cfg-matrix.sh` の 4 象限 + `clap-host` / `link-audio` /
   `link-audio-verification`）
2. gated Rust C-1〜C-6 が緑。**C-6 の変異（`pause()` を外す）で red** の実出力
3. gated MCP D-1〜D-3 が緑。`ORBIT_GATED_ORBITSTUDIO` 未設定で skip
4. **既存 gated 全件が緑のまま**（ERROR 件数の巻き添えなし）
5. 実機（main・sandbox 外）: `--audio-device "Pro Tools Aggregate I/O"` で
   `get_log` に `🔊 output: … (first callback N ms)` が 1 行・**ERROR 増分 0**
6. `main.rs` から `set_var("ORBIT_AUDIO_DEVICE")` が消えている（grep）
7. 🔴 **§2.2 の「時間が倍速になるか」を実測して結論を書く**（capture の RMS 時系列か
   オンセット間隔で。倍速なら別 issue へ）

---

## 7. 確信度が低い箇所

| # | 主張 | 確信度 | 反証方法 |
|---|---|---|---|
| 1 | cpal は名指し stream を drop しても止めない | **高**（main が実測 2.01×・ソースも一致） | — 済 |
| 2 | probe が通れば実 stream も生きる | **中** | 事後確認の `StreamDead` が実運用で出たら不足 |
| 3 | deadline 3000 ms が妥当 | **中** | `first_callback_ms` の分布。全機種 < 300 ms なら 1 s に下げてよい |
| 4 | 起動前 stderr は成功時に捨てられる | **中**（Fable の読解・main 未検証） | 実装の最初に §2.3 の手順で確かめる |
| 5 | 根本原因（44.1 k で死ぬ理由）は未特定 | — | 44100 のデバイスで V4 を起動し、2 候補目（DefaultOutput unit）で鳴るなら **unit 種別 × 44.1 k** が原因域 |
