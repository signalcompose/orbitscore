# γ latency policy fork — spike verdict（候補 A / in-process 対照 / 候補 B）

- **Issue**: #350（親 Epic #292 Post-2.0 Native Engine & OrbitStudio）
- **前段**: #348 / PR #349（γ Step0 feasibility spike・FEASIBLE・[`POST_2.0_GAMMA_SANDBOX_SPIKE.md`](POST_2.0_GAMMA_SANDBOX_SPIKE.md)）
- **正本（親）**: [`POST_2.0_NEXT_STEPS.html`](POST_2.0_NEXT_STEPS.html) γ セクション L181（段階分け: daemon CLAP 統合 → sandbox spike → **本フェーズ** → γ 本実装 → cutover #108）
- **実装**: `rust/crates/orbit-sandbox-spike`（`sandbox-host` に `--child-rt-priority` / `--in-process` / `--pipelined` を追加）
- **計測機**: MacBook Pro（Apple Silicon / arm64）, macOS, CoreAudio default output, 44100 Hz, stereo, release build
- **日付**: 2026-06-27

## 1. 目的とスコープ

Step0 spike は同期（synchronous）round-trip 設計のみを計測し、worst-case callback tail（~2〜4ms・
buffer 非依存・scheduling 由来）が同期設計に **≥256 frame の buffer 下限**を強制すると判定した。
本フェーズは Step0 verdict §6 の **latency policy fork を計測して決める**（"run before you plan"）。
**実装ではなく feasibility spike**（stop&report）。

owner 方針（[memory: DAW 並み小バッファ性能が目標]）により、64f / 32f の小バッファ viability は
edge case ではなく**性能ゴール**として扱う。「≥256f で妥協」を終着点にしない。

### 計測した 3 モード

1. **候補 A — synchronous + child RT 優先度**（`--child-rt-priority`）: child の spin スレッドを
   mach `THREAD_TIME_CONSTRAINT_POLICY`（RT）に上げ、tail が child プリエンプト由来なら縮むはず。
2. **in-process 対照**（`--in-process`）: child を使わず callback 内で直接トーンを合成する。
   sandbox round-trip を通さない経路（= **ネイティブ楽器が走る経路**）の floor を測り、候補 B の
   callback_max「tiny」基準を較正し、「この機材が 64f を in-process でクリーンに出せるか」を独立検証。
3. **候補 B — one-block-pipelined**（`--pipelined`）: host は spin せず block N を渡して N-1 を読む。
   tail を構造的に消す代わり 1 block の遅延 + child 遅延時の stale。判定軸は **stale 率**。

## 2. 判定軸（モード別）

- 候補 A / sync: **worst-case callback_max ÷ block budget**（Step0 と同じ。overruns ではない。
  CoreAudio は budget 超過で xrun を発火しない = #295 fence）。
- 候補 B（pipelined）: **stale 率**（host が出力すべき block を child が未完了だった割合）が主軸。
  callback_max は副軸（spin しないので本来 tiny。spike すれば host プリエンプトの証拠）。
- in-process: callback_max（floor の較正）。

## 3. 結果

### 3.1 候補 A — RT 優先度は tail を縮めず、むしろ不安定化（棄却）

64f（budget 1.45ms）・同一セッション比較:

| モード | worst callback_max | overruns | 備考 |
|--------|-------------------:|---------:|------|
| sync（RT 無し）| 2.21〜2.23ms（timeout 1 回で 5.0ms）| 0〜1 | Step0 と整合 |
| sync + RT-prio | 1.99〜2.75ms | 0〜**154** | run2 で 154 overruns（≈223ms 無音）に不安定化 |

RT は実際に有効化された（child が `RT thread enabled (period=1451us)` を出力）。それでも
**~2ms tail は縮まず**、ある run では大量 overruns で悪化した。連続 spin スレッドに time-constraint を
付けると macOS が computation 予算超過で demote しうる（既知）。
→ tail は **child プリエンプト由来ではない**（= host 側）。候補 A は棄却。

### 3.2 in-process 対照 — この機材は 64f を in-process でクリーンに出せる

64f（budget 1.45ms）・4 run: worst callback_max = **6µs = 0.41%**（典型 0.7〜1µs）。

- **~2ms tail は OS/driver の floor ではない**。in-process（round-trip 無し）では消える。
  → tail は **sandbox の round-trip 待ち固有**（host が child を spin で待つ時間 + その間の host
  スレッドプリエンプト）。
- **owner 向け主張「ネイティブ楽器 = in-process は小バッファ OK」を実機で裏付け**。ネイティブ音源の
  リアルタイム演奏は 64f でもクリーン（音源自体の DSP コストのみで決まる、DAW 内蔵音源と同等）。

### 3.3 候補 B — pipelined が 64f（32f まで）を解く（採用）

stale 率が判定軸。callback_max は副軸。

| buffer | block budget | callback_max（worst）| **stale 率** | stall | 判定 |
|-------:|-------------:|--------------------:|-------------:|------:|:-----|
| 256 f  | 5.80 ms | 4.1µs（0.07%）| **0%** | 0 | クリーン |
| 128 f  | 2.90 ms | 7.8µs（0.27%）| **0%** | 0 | クリーン |
| 64 f   | 1.45 ms | 6.8µs（0.47%・15s run）| **≈0.11%**（11/10330）| 0 | **feasible** |
| 32 f   | 0.73 ms | 3.5µs（0.48%）| **≈0.45%**（31/6861）| 9〜13 | feasible（要観察） |

- **callback_max は全 buffer で <0.5% budget** = ~2.7〜3.1ms の同期 tail が**完全に消えた**
  （host が spin しないため）。Step0 の「≥256f 下限」制約は pipelined では外れる。
- **stale 率は 64f で ≈0.1%・32f で ≈0.45%**。buffer が小さいほど child の 1 block 当たり時間が
  減るので増えるが、32f でも 0.5% 未満。stall（slot 再利用不可）は 64f 以上で 0、32f で数件。
- post-mix peak = 0.25（gain 0.5 × tone 0.5）= 音は正しく流れている。

## 4. Verdict — **候補 B（one-block-pipelined）を採用**

- 候補 A（RT 優先度）は tail を縮めず棄却。tail は host 側（in-process 対照で確証）。
- 候補 B は host の spin 待ちを無くし tail を構造的に消す。**32f まで小バッファで out-of-process
  sandbox を feasible にする**（callback_max <0.5% budget・stale <0.5%）。owner の DAW 並み小バッファ
  性能ゴールを、サンドボックス経路でも満たせる見込み。

### B の代償（γ 本実装で織り込む）

1. **1 block の出力遅延**（pipeline 固有）。64f で +1.45ms、32f で +0.73ms。「サンドボックス化した
   3rd-party を通した低レイテンシ演奏」の total latency = in-process 経路 + 1 sandbox block。
2. **stale（child が間に合わない）が <0.5% @32-64f**。本 spike は stale policy = silence。production は
   **直前 block の repeat**（クリック回避）を採るべき。
3. **stall（slot 2-outstanding 再利用圧）が 32f で数件** → 必要なら slot 数を 3 に増やす検討。

## 5. defer（本フェーズでやらない）

- event / param IPC のリッチさ（CLAP event を境界越しに RT 安全に渡す設計）。
- 複数同時 plugin、境界越え automation。
- 本番 daemon への pipelined sandbox host 統合（cutover #108 前の別フェーズ = γ 本実装）。
- plugin 内部状態の crash 復帰。
- stale policy（repeat-previous）/ slot 数調整 / RT 優先度を block/wake child に付ける案の本実装。

## 6. 次ステップ

1. γ 本実装で **pipelined（候補 B）を採用**し、stale policy = repeat-previous、slot 数の最終決定を行う。
2. event/param IPC 設計（CLAP event を境界越しに RT 安全に渡す）。
3. 本番 daemon への sandbox host 統合 → γ 本実装 → cutover #108。
