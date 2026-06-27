# γ out-of-process sandbox — Step0 feasibility spike verdict

- **Issue**: #348（Epic #292 Post-2.0 Native Engine & OrbitStudio）
- **正本（親）**: [`POST_2.0_NEXT_STEPS.html`](POST_2.0_NEXT_STEPS.html) γ セクション
- **実装**: `rust/crates/orbit-sandbox-spike`（2 binary: `sandbox-host` / `sandbox-child`）
- **計測機**: MacBook Pro（Apple Silicon / arm64）, macOS, CoreAudio default output, 44100 Hz, stereo, release build
- **日付**: 2026-06-27

## 1. 目的とスコープ

γ（out-of-process sandbox）は effects + 3rd-party plugin を**プロセス境界で隔離**し、daemon が
3rd-party の crash を生存させるフェーズ（C-ABI segfault はプロセス境界でのみ封じ込め可能）。
正本の staging 指示に従い、γ は単一 /goal にせず「daemon CLAP 統合（#340/#341 完了済）→
**sandbox feasibility spike**」と段階化する。本 spike はその Step0。

**実装ではなく feasibility spike**（S1 / Signalsmith spike と同様、stop&report ゲート付き）。
2 つのゲートのどちらかが fail なら γ は現仕様では infeasible → 設計見直しを報告して停止する。

### この spike が測ったこと・測っていないこと

- 測った: **同期（synchronous）round-trip 1 設計**のみ。host RT スレッドが child の結果を
  bounded spin で待つ。child は **stateless**（gain のみ）。
- 測っていない（= 結論を主張しない）:
  - **one-block-pipelined** 設計（block N を渡し block N-1 を読む。RT は spin しない。1 block 遅延・
    遅延した child = 1 block の stale）。
  - **child の RT スケジューリング優先度引き上げ**（mach time-constraint / SCHED_FIFO）。
  - plugin の**内部状態**（preset / automation / 内部バッファ）の crash 復帰。

## 2. 方式

- file-backed mmap(MAP_SHARED) を親子双方が map し同一物理ページを共有（`SharedRegion`）。
- 同期は `seq_request` / `seq_done` atomic の **SPSC Acquire/Release ハンドシェイク**。新規 sync
  crate 不要（macOS に futex は無いが atomic + bounded spin で足りる。`ClapTeardownGuard` と同型）。
- host RT callback: input にテストトーンを書く → `seq_request` を Release で +1 →
  **timeout 付き** spin で `seq_done >= req` を待つ → 取れたら output をコピー、timeout なら
  **glitch-to-silence**（RT は無制限ブロックしない）。
- watchdog（別スレッド）: child の `try_wait` を 2ms 周期で polling。死亡を検知したら
  **crash arg 無しの clean child** を respawn（→ audio 復帰）。
- 計測ハーネスは `orbit-clap-spike`（#295 baseline）の cpal callback + callback_max + bucket
  histogram を流用。

## 3. Gate 1 — RT round-trip が block budget に収まるか

crash 無し・warm-up（child attach + page fault を計測前に消化）後・各 5 秒・synchronous。
tail はノイジーなので各 buffer **3 回**実行し、RT 安全の判定軸である **worst-case callback_max** を取る。

| buffer | block budget | rt_mean (典型) | rt_p99 (3 回幅) | **callback_max (3 回 worst)** | **worst / budget** | overruns | 判定 |
|-------:|-------------:|---------------:|----------------:|------------------------------:|-------------------:|---------:|:-----|
| 512    | 11.61 ms     | 6〜21 µs        | 30 µs 〜 1.15 ms | **2.15 ms**                   | **18.5 %**         | 0        | **PASS** |
| 128    | 2.90 ms      | 12〜16 µs       | 0.14 〜 0.43 ms  | **2.79 ms**                   | **96.1 %**         | 0        | 余裕ゼロ（reliably safe とは言えない） |
| 64     | 1.45 ms      | 9〜16 µs        | 50 〜 102 µs      | **4.15 ms**                   | **286 %**          | 0        | **違反** |

### 判定軸は callback_max ÷ budget（overruns ではない）

`overruns` は host 側の timeout trip しか数えない。**RT 安全性の真の判定軸は
`callback_max > budget` か否か**。CoreAudio は budget 超過で `StreamError`(xrun) を発火しない
ため（#295 で確立した fence）、`overruns: 0` を「64 frame も pass」と読んではならない。

### tail は buffer サイズに依存しない（= 同期設計が強制する buffer 下限）

最重要の観測: **worst-case callback_max は buffer サイズに依らず ~2〜4ms でほぼ一定**。
mean / p99 は µs オーダー（mean 6〜21µs・p99 大半 <0.5ms）で**プロセス境界の通常コストは安い**が、
worst-case tail は warm-up 後も残る steady-state で、**scheduling jitter（child および／または host
スレッドのプリエンプト）**由来。round-trip タイマは host スレッド上で回るため tail には host 自身の
プリエンプトも含まれる（どちらのスレッドかは本データから分離不可。p99≪max が「algorithmic ではなく
scheduling 由来」であることは確か）。

tail が buffer 非依存の ~2〜4ms 定数なので、**RT 安全であるには block budget がこの tail を上回る必要**
がある → 同期設計は実質 **≥256 frame（budget ≥ ~5.8ms）の buffer 下限**を強制する。512 は余裕（18.5%）、
128 は worst-case が budget の 96% で余白ゼロ＝信頼できる安全とは言えない、64 は恒常的に違反（180〜286%）。

**重要**: この tail は**プロセス隔離そのものの代償ではなく、同期 round-trip 設計の代償**。
host RT が child を spin で待つ限り worst-case は scheduling latency に縛られる（§6 の代替案で解消しうる）。

## 4. Gate 2 — daemon が child segfault を生存するか

child を `--child-crash-after-blocks` で自発 segfault（misbehaving plugin の模擬）させた。

### 4.1 default buffer（512）/ timeout 5ms / crash@200

```
child exited: ExitStatus(unix_wait_status(11))   ← SIGSEGV
[watchdog] respawning clean child
child_respawns:        1
roundtrip_overruns:    0
roundtrip_max_ns:      3562959   (= 3.6 ms)
recovered_after_crash: true
post_mix_peak:         0.25000
```

- **host プロセスは生存**（結果を出力＝親は落ちていない）→ C-ABI segfault がプロセス境界で
  **封じ込められた**。
- recovery が 3.6ms で完了し、影響を受けた callback すら budget(11.6ms)内 → **無音落ちすら無し**
  （`overruns: 0`）。

### 4.2 低 buffer（64）/ timeout 800µs / crash@2000

```
child exited: SIGSEGV → respawn
child_respawns:        1
roundtrip_overruns:    35        ← glitch-to-silence(respawn 窓 ≈ 35×1.45ms ≈ 51ms)
callback_max_ns:       800750    ← timeout で頭打ち = deadlock しない
recovered_after_crash: true
post_mix_peak:         0.25000
```

- crash gap 中、bounded spin が各 callback を timeout(800µs)で頭打ちにし **deadlock しない**。
- 35 callbacks が glitch-to-silence（≈51ms = process respawn 窓: spawn + dlopen + mmap + attach）。
  この無音窓は `roundtrip_overruns × block 周期`で読む（誤解を招く派生メトリックは持たない）。
- watchdog respawn 後に audio 復帰。

### Gate 2 で**証明したこと・していないこと**

- 証明: daemon（親）が child の segfault を生存し、無音落ちは bounded（deadlock 無し）で、
  **音の流れ（audio-flow）が復帰**する。
- **未証明**: plugin の**内部状態**復帰。本 spike の child は stateless（gain）。実 plugin の
  respawn は preset / automation / 内部バッファを失う。`recovered_after_crash: true` は
  「daemon 生存 + 音再開」を意味し、「plugin が中断点から継続」ではない。

## 5. Verdict — **FEASIBLE**（両ゲート PASS）

- **Gate 1 PASS**（条件付き）: プロセス境界 round-trip は mean/p99 が µs で安く、deadlock しない
  （bounded spin → glitch-to-silence）。worst-case tail は ~2〜4ms の buffer 非依存定数（scheduling
  由来）なので、同期設計は **≥256 frame（budget ≥ ~5.8ms）の buffer 下限**で RT 安全。512=18.5% で余裕、
  128=96% で余白ゼロ、64=286% で違反。低レイテンシは latency policy の決定（§6）が要る。
- **Gate 2 PASS**: C-ABI segfault をプロセス境界で封じ込め（host 生存）、watchdog respawn で
  audio-flow 復帰。degradation は bounded glitch-to-silence（512 は budget 内 recovery で無音落ち無し・
  64 は ≈51ms 無音窓）。

γ の前提（「3rd-party をプロセス境界で隔離し daemon を crash から守る」）は**実現可能**。
低 buffer の latency tail は既知・対処可能な設計制約であり、blocker ではない。

## 6. latency policy の fork（spike の output — 事前に決めない方針どおり計測してから決める）

低 buffer での budget 違反を解く道は 2 つ。**どちらも本 spike では未計測の candidate**:

1. **synchronous + child RT 優先度引き上げ**（mach time-constraint / SCHED_FIFO + core pin）:
   tail を縮める。実装は単純だが RT 優先度の plugin に万一暴走されると host を巻き込むリスク。
2. **one-block-pipelined**: host は block N を渡して block N-1 を読む。RT は spin しない →
   tail を構造的に消す。代償は 1 block の遅延と、child が遅れたとき 1 block の stale。

γ 実装フェーズで両者を計測して決める（"run before you plan"）。

## 7. defer（ゲート外・本 spike でやらない）

- event / param IPC のリッチさ、複数同時 plugin、境界越え automation。
- 本番 daemon への統合（cutover #108 前の別フェーズ）。
- plugin 内部状態の crash 復帰（preset/automation 再適用）。

## 8. 次ステップ

1. latency policy の fork（§6）を計測する spike 拡張（synchronous+RT-prio vs pipelined）。
2. event/param IPC 設計（CLAP event を境界越しに RT 安全に渡す）。
3. 本番 daemon への sandbox host 統合 → γ 本実装 → cutover #108。
