# #739 PR-O2a — キャプチャ窓を音に追従させる（測定器の設計）

**起案**: Fable（effort high・2026-09-04） / **審査**: main（同日・一次ソースで 3 訂正を検証） /
**実装**: Codex / **検証**: main（sandbox 外・実機 gated）

> 🔴 本書の「テスト対応表」は**テスト対象の一覧**として読む。検証手段は CLAUDE.md
> 「テストの積み上げ規律」で決め直す（設計書は本規則を上書きできない）。

---

## 1. 何が壊れているか

実機 gated E2E の「名前つき区間 RMS」測定器に、独立した欠陥が 2 つある。

### 1.1 固定 settle が音より早い

`captureSegment(name, durationMs=2000, settleMs=400)` は
`sleep(settle)` → `from=Date.now()` → `sleep(duration)` → `to=Date.now()`。

E2E-1 の実測時系列 RMS（`ORBIT_KEEP_CAPTURES` で残した WAV）:

```
capture 5.013s
0.00–3.00s  0.0000   ← 完全な無音
3.00s       0.1195   ← ここで初めて音が出る
3.75–5.00s  0.0886   ← 定常
```

`global.start()` → `LOOP()` の小節量子化（120 BPM 4/4 = 2000 ms）＋ プラグイン attach で
音は約 3 秒後。`unity` 窓は 0.4–2.4 s なので**丸ごと無音**であり、
`global.gain(-6)` は 2.4 s ＝ **楽器が一度も鳴る前**に適用されている。
実測 half/unity = 1.36（下げたのに大きい）。

### 1.2 区間マッピングが壁時計からの逆算で、黙ってクランプする

```ts
fromSec: Math.max(0, analysis.durationSec - (stopWall - segment.from) / 1000 + guardSec)
```

`stopWall` = `stop_engine` が返った壁時計。キャプチャ実長が壁時計より短いと `fromSec` が負 →
**0 にクランプされてファイル先頭を指す**。

🔴 **反証済み**: settle を 400 → 2600 ms にしたら unity が 0.0632 → **0** と悪化した。
**窓を後ろへ動かすと逆に前を測る。固定値で追いかける修正は効かない。**

### 1.3 🔴 同じ逆算が **5 箇所**に複製されている

| # | 場所 | 使うテスト | 独自パラメータ |
|---|---|---|---|
| 1 | `tests/e2e/helpers/run-score.ts:341-347` | #668 helper 経由の新しい E2E | settle 400 / 窓 2000 / guard 0.15 |
| 2 | `tests/e2e/orbitstudio-mcp-gated.spec.ts:574-578`（`captureInstrumentScenario`） | **E2E-1 を含む #643 の 7 シナリオ** | 同上 |
| 3 | 同 `:3374-3378` | #618 E1-E6 | guard 0 |
| 4 | 同 `:3780-3786` | #625 R-E1-R-E7 | `SEGMENT_GUARD_SEC` |
| 5 | 同 `:4355-4361` | #628 R28 | `SEGMENT_GUARD_SEC` |

加えて **E2E-3 は `segments.transition` を `Date.now()` で直接書く**（`:1523-1526`）ので、
区間の単位を変えるとここも触る。

🔴 **E2E-1 は #2 を使う。** `run-score.ts` だけ直しても段 1 の受け入れ条件は動かない。

---

## 2. 前提の訂正（main が一次ソースで検証済み）

| # | 当初の想定 | 事実 | 根拠 |
|---|---|---|---|
| A | 複製は 2 箇所 | **5 箇所**（§1.3） | 上表の `path:line` |
| B | 受け入れは「各窓のオンセット数」（issue #739） | **正弦系（CLAPTestSynth）にはヒットごとのオンセットが無い。** `gate(1)` は `offTime = onTime + slotDur × 1.0` ＝ note-off が次の note-on と同時刻で**連続音**。さらに `onsets` の閾値は**全体の中央値 × 4**なので、正弦が録音の半分を超えると閾値が最大バケットを上回り**最初のアタックさえ検出されない**。オンセット数は**打楽器 fixture（kick.wav = PR-O0 の 4 本）にだけ意味を持つ** | `packages/engine/src/core/sequence.ts:1521` / `packages/vscode-extension/src/wav-analysis.ts:162-163` / #649 実測（3.25 s = 0.1767 = 0.25/√2、以後 0.0886 = その −6 dB・途切れ無し） |
| C | √(8/7) は写像の量子化 | **guard の非対称**。`rms()` は guard 0.15 の範囲、`onsets()` は guard 0。窓 4000 ms → RMS 範囲 3700 ms = 7.4 周期なので位相によって 7 発か 8 発が入る。kick のエネルギーは先頭 100 ms に集中するので比は √(8/7)=1.069 ちょうど。**窓幅を整数倍にしても guard を非対称に引けば再発する** | `tests/e2e/helpers/run-score.ts:353-357` vs `:363-366` |

---

## 3. 採用する時計 — **キャプチャファイルのバイト長**

各区間の境界で `fs.statSync(capturePath).size` を読み、

```
captureClockSec = (size − 44) / (channels × 4) / sampleRate
```

でキャプチャ時刻（秒）に写す。**`stopWall` からの逆算を捨てる。**

「音が出たか」の待ち（§4）は**いつ窓を開けてよいかを決めるだけ**で、時計には使わない。

### 3.1 却下した案

| 案 | 却下理由 |
|---|---|
| **A: header をポーリングして (壁時計, header 長) をアンカーにする** | `sync_header` は 96,000 サンプル（48 kHz stereo で 1 s）ごと（`rust/crates/orbit-audio-native/src/capture.rs:38`, `:229-232`）。検出した瞬間の対は「その長さが書かれたのは 0〜1 s 前のどこか」という不定性を持ち、**全区間が同じ量（実行ごとに違う）だけずれる系統誤差**になる。2 s 窓に対し最大 50% |
| **B: PR-V3 の `GetStatus.callback.count × last_frames`** | daemon には出るが **MCP の `get_engine_state` は `{running, liveCoding}` しか返さない**（`packages/vscode-extension/src/mcp-server.ts` の `EngineState`）。daemon → engine TS → 拡張 → MCP の **4 層配線**が要り、測定器 PR に PR-V3 依存の横棒が入る。`last_frames` は「直近 1 回」の値で厳密な時計でもない。さらに render 側の時計なので ring → drain → BufWriter の遅れを別途取る必要があり、案 C より情報が増えない |

### 3.2 残差誤差（一次ソース）

| 要因 | 値 | 根拠 |
|---|---|---|
| ring → drain の poll | ≤ 2 ms | `capture.rs:27` `DRAIN_POLL_INTERVAL` |
| RT callback 1 ブロック | 5〜11 ms（256〜512 f） | ring は callback 単位で push |
| BufWriter のバッファ | 0〜21 ms（8 KiB = 1024 stereo f @48k） | `capture.rs:55` `BufWriter::new`（std 既定 8 KiB）。1 s ごとの `sync_header` の `flush()`（`:87`）で位相がリセット |
| **合計** | **遅れ L ∈ [約 5, 約 35] ms・一方向**（ファイルは render より遅れる） | |

**区間ごとに独立**（各境界で読むので系統オフセットではなく境界ごとの ±15 ms 程度のジッタ）。
2 s 窓に対して ≤ 1.8% で、既定 guard 150 ms が吸収する。

打楽器系のヒット数には効く（幅 n·P ± 30 ms → 境界近くにヒットが来る確率 ≈ 6%/窓）ので、
打楽器系は §5 の「最初のオンセットにスナップ」で決定論化する。正弦系は位相に依存しないので不要。

---

## 4. 「音が出た」の判定

```
soundStarted(buf) := analyzeWavBuffer(buf, { windowMs: 20 }).windows.some(w => w.rms >= 0.01)
```

- **`windows` を使い `onsets` は使わない。** `onsets` の閾値は全体中央値 × 4 なので、
  ポーリングが遅れて音が半分を超えた瞬間に閾値が跳ね、**待ち続けてタイムアウトする**経路がある。
  絶対値の床のほうが安全
- **床 0.01（−40 dBFS）** = 既存 `STEADY_CAPTURE.audibleFloorRms`（`tests/e2e/output-line-expectations.ts`）を再利用する
- **ノイズフロアと区別できる**: キャプチャは post-mix の f32 で、無音は**厳密に 0.0**
  （#649 実測の 0.00–3.00 s が 0.0000）。最初の音は kick アタック ≈0.27 か正弦 0.177 で床の 17〜27 倍
- **poll 250 ms・timeout 20 s**（LOOP の 1 小節 2 s + attach の揺れ）
- 🔴 **timeout 時は `{durationSec, peak, maxWindowRms, stat.size, capturePath}` をメッセージに含める**
  （無音ハーネスと attach 失敗を区別できるように。**将来「初回区間が意図的に無音」のテストが
  現れたとき、20 秒の謎のタイムアウトではなく原因が読める形で落ちること**が要件）
- **run ごとに 1 回だけ**（`captureSegment` の初回のみ）。以後の遷移は従来どおり呼び出し側の
  `settleMs` の責務。「音 A → 音 B」の遷移は音だけからは検出できないので、ここに機構を足さない
- **stale ファイル対策**: `start_engine` の前に同名の capture を `fs.rmSync(path, {force:true})`

---

## 5. 窓幅とヒット周期

周期は**テストが宣言する**（DSL を書いたのはテスト自身）。観測したオンセット間隔から導くと
「エンジンが違うテンポで鳴っていても窓に n 発入る」自己参照になる。

```
P_ms = (60000 / bpm) × beatsPerBar / slotsPerBar = (60000/120) × 4/4 = 500
```

（既存 `HIT_PERIOD_MS = 500`（`tests/e2e/output-line-expectations.ts`）がこれ。上式を脇にコメントで置く）

### 5.1 打楽器系（kick.wav）の測定範囲 — PR-O0 の `steadyRms` に置く（ハーネス API は増やさない）

```
search  = [from + g, to − g)                   // g = guard 0.15
o₁      = min{ t ∈ onsets : t ≥ from + g }     // 無ければ fail
measure = [o₁ − 0.02, o₁ − 0.02 + n·P)         // 0.02 = 1 バケット（アタックを含める）
require measure ⊂ search                        // 短ければ fail「n 発に足りない」
assert  |onsets ∩ measure| === n
assert  median(gaps in measure) ≈ P (±10%)      // テンポの取り違えを別に検出
rms     = quadraticMean(windows ∩ measure)      // 幅が厳密に n·P なので位相非依存
```

必要な録り幅: `durationMs ≥ 2g + P + n·P`。n=8 なら **4800 ms 以上**（現在の 4000 では足りない）。
`STEADY_CAPTURE` を `{ captureMs: HIT_PERIOD_MS × (expectedOnsets + 1) + 300, expectedOnsets: 8 }`
の形にする。**golden の値は変えない**（整数周期なら RMS = √(E_hit / P) で n に依らない）。

### 5.2 正弦系（CLAPTestSynth・E2E-1〜7）

`measure = [from + g, to − g)` のまま。位相に依存しないので整数倍の要件は無い。
判定は**連続性**（§6 の S1）。

---

## 6. 受け入れ基準

🔴 **すべて「計器が正しい」ことの検査であり、E2E-1 の比は含めない**（循環を切るため）。

| ID | 検査 | どこで | 何を守るか |
|---|---|---|---|
| **A1** | 最初の区間の `fromSec ≥ soundStartSec`（最終解析で最初に RMS ≥ 0.01 になったバケットの `startSec`） | ハーネス | **#739 の主訴そのもの**。窓が音より前に開いていれば red |
| **U1** | 各区間の `windows(name).length` = `round((toSec − fromSec − 2g)/0.02)` ± 2 | ハーネス | 写像の幅が要求と一致する（旧クランプは幅を変えた） |
| **U2** | `\|(toSec − fromSec) − (toWall − fromWall)/1000\| ≤ 0.12` | ハーネス | ファイル時計と壁時計の整合。stream が止まる（#661 の症状）・drop でファイルが伸びない場合にここで落ちる |
| **U3** | 区間はファイル時間で単調・非重複、`toSec ≤ durationSec`。**`Math.max(0, …)` を書かない** | ハーネス | 黙ってファイル先頭を指さない |
| **K1** | 打楽器系: snap 範囲のオンセット数 `=== n`、gap 中央値 ≈ P | O0 `steadyRms` | 「窓のヒット数が期待どおり」 |
| **K2** | O0-1 を 2 セッション: `relativeDelta ≤ 0.02`（今日は 0.069 が出る） | O0-1 | √(8/7) が消えたことの実証 |
| **S1** | 正弦系: `windows(name)` の全バケット ≥ 0.01 | E2E-1〜7 に 1 行ずつ | 「窓の中に無音が無い」＝正弦系での「期待どおり」 |
| **S2** | E2E-1 の `unity > 0.15`（理論 0.177） | E2E-1 | 比の assert（PR-O2 の仕事）とは独立に「0 dB を一度は測った」を固定 |

> **U2 の許容が 0.12 である理由**（main 判断）: U2 の目的は **stream の死**（差は O(秒)）を
> 捕まえることであって、境界ジッタ（§3.2 で ±30 ms）を測ることではない。0.05 では
> 負荷時に偽陽性を出し、ハーネスが揺れる方が損失が大きい。

### 6.1 red 化（決定論的なものだけ・実出力を報告に貼る）

| 変異 | 期待する red |
|---|---|
| **R1** `waitForSound` を外す（settle 400 のまま） | E2E-1: **A1** ／ O0: snap が「search 先頭 1 周期にオンセット無し」で fail |
| **R2** `captureClockSec` を旧逆算に戻す | E2E-1: **A1**（settle 2600 で unity=0 になった実測と同型）。クランプが効けば **U1/U3** |
| **R3** テスト定数 `HIT_PERIOD_MS` を 400 に | O0: snap 範囲 3.2 s に 6〜7 発 → **K1** `≠ 8` |
| **R4** DSL の tempo を 100 に | O0: gap 中央値 600 → **K1**（gap 検査） |
| **R5** `STEADY_CAPTURE.captureMs` を n·P ちょうど（4000）に | O0: `measure ⊂ search` 違反で fail |

「窓を意図的にずらす」に直接答えるのは **R2**（時計をずらす）と **R1**（開く時刻をずらす）。
なお snap があるため「**打楽器区間の窓を後ろへ 1 s 動かす**」変異は red にならない
（定常なら 1 s 後も同じ音）— これは意図どおりで、位置の正しさは A1 と U3 が担保する。

---

## 7. 統合方針

**写像を 1 つの純関数モジュールに寄せ、5 箇所すべてがそれを呼ぶ。
区間の意味（sleep・guard・assert）は一切変えない。**

新規 `tests/e2e/helpers/capture-windows.ts`（純関数・`vscode` 非依存）:

| export | 役割 |
|---|---|
| `readCaptureFormat(path)` | 44 byte header から `{sampleRate, channels}`（`capture.rs:21` の固定 44 が前提。最終 `analysis` と `stat.size` の整合を assert して前提を毎回検証する） |
| `captureClockSec(path, fmt)` | `(stat.size − 44) / bytesPerFrame / sampleRate` |
| `waitForSound(path, {floor, intervalMs, timeoutMs, label})` | §4 |
| `captureWindowsFrom(analysis, segments, label)` | 既存 `CaptureWindows` インターフェース（`run-score.ts:99-115` からここへ移動）を返す。`rms / windows / onsets / channelRms` の計算は現行と同一 |
| `quadraticMeanRms` | export（O0 の snap が使う） |

`segments` の型を `{fromSec, toSec, fromWall, toWall}` にする。壁時計は **U2 の整合検査にだけ**使う。

### 7.1 既存 20 本を壊さない保証

1. **意味の不変**: `captureSegment(name, durationMs, settleMs)` のシグネチャと、各テストの
   sleep / guard / 閾値 / 比の assert は変更なし。変わるのは (a) 初回区間が「音が出てから」開く
   （**遅れるだけ**）、(b) 写像が壁時計逆算からファイル時計へ（**正確になるだけ**）
2. **機械の保証**: 合成 WAV のユニット（逆算のオフセットが 0 のとき現行 `range` と同じ
   バケット集合を返す性質）＋ hygiene 規則
3. **実機**: `npm run test:e2e:gated` 全件（**main の担当**）

### 7.2 main が事前に検査したリスク（実害なしを確認）

- 🔴 **「初回区間が無音を期待するテスト」があると A1 が誤爆する** → **今日は存在しない**。
  `#618 E3`（`rest pattern must be silent`）は **3 番目**の区間。
  `#625 dryRms` は **`toBeGreaterThan(0.01)` のみ**で、比の基準は既に `removedDryRms` へ
  移されている（`orbitstudio-mcp-gated.spec.ts` の当該注記が
  「`dryBaseline` が低いのは 3 秒窓の先頭 1 秒が LOOP 開始レイテンシで無音なため。
  待ちを 1 バー分足せば busDry と一致するはず」と**本 PR の修正を予告している**）。
  したがって本 PR で `dryRms` は**上がる**が assert の向きと同じで緑のまま
