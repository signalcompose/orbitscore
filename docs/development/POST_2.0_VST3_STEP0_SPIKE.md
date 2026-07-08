# VST3 Hosting Phase 0 (Step0 spike) — Verdict

**Issue**: #381 / Epic #292
**正本 plan**: [`POST_2.0_VST3_HOSTING_PLAN.md`](POST_2.0_VST3_HOSTING_PLAN.md) §Phase 0
**日付**: 2026-07-08
**推奨**: 🟢 **GO 推奨（最終判定は owner）** — 手書き COM で実市販 VST3 をホストできることを実証。GO なら Phase 1（production OOP effect）へ。
**判定**: ⬜ owner 判定待ち（この spike は STOP 条件に非該当・下記エビデンスに基づき owner が GO / NO-GO / 保留を決定する）。

---

## 1. サマリ

VST3 の最大リスク =「Rust で COM を unsafe に手書きしてホストする」を、最小・offline・device 不要の spike で retire した。

- **0a（license 監査）= PASS**。deny.toml 無改変で通過。
- **0b ①（sample-exact oracle）= PASS**。自作 gain VST3 の出力が bit-exact 一致。
- **0b ②（実市販プラグイン ABI 適合）= PASS**。実 Steinberg-SDK 製プラグインが load→process→drop。
- **compatibility sweep**: 実市販 VST3 コレクション 333 個を best-effort で probe。**最小ホストで 56%（188/333）が load+process 成功・71% が load 成功**。真の crash は 11%（36/333）で**ほぼ全て Native Instruments フレームワーク**に集中（均一な ABI バグではない）。

feasibility は十分に立証された。カバレッジを上げる道（host context + bus arrangement 調停）は Phase 1 の明確な作業項目。

---

## 2. 0a — license 監査（PASS）

- `orbit-vst3-host` に `vst3 = "0.3"` を追加し `cargo tree` を実測。
- **全 transitive 依存 = `vst3 v0.3.0` → `com-scrape-types v0.1.1` の 2 crate のみ**（bindgen/clang-sys 系なし）。
- 両者とも **`MIT OR Apache-2.0`**（展開済み Cargo.toml source で一次裏取り・vst3 は LICENSE-APACHE/MIT 同梱）。deny.toml allow list 内。
- host 実装で追加した `libloading = "0.8"` = **ISC**（allow list 内）。
- `cargo deny check licenses` = **licenses ok**。**deny.toml は無改変**（STOP 条件の allow list 改変は発生せず）。

---

## 3. 0b ① — sample-exact oracle（PASS）

- **oracle**: `vst3` crate 同梱 `examples/gain.rs`（`out = gain × in`・smoothing なし・純 Rust）を vendored した `orbit-vst3-gain-oracle`。`package-oracle.sh` で macOS `.vst3` バンドル生成（C++ SDK 不要）。
- **test**（`tests/offline.rs::gain_oracle_is_sample_exact`・通常 `cargo test`・skip なし）:
  - param 変更なし → `output == input`（恒等・bit 一致）
  - param id 0 = 0.5 → `output_l/r[i].to_bits() == (input[i] * 0.5).to_bits()`（**厳密 bit-exact**）
- **独立再検証済み**（呼び出し側 Opus が実 dylib に対し再実行）: 512 frames stereo で PASS。

> ★ 注意: ① は「Rust plugin ↔ Rust host が同じ `vst3` crate の ABI 解釈を共有」するため、これ**だけ**では ABI の対 SDK 適合を証明しない。② がその load-bearing 検証（下記）。

---

## 4. 0b ② — 実市販プラグイン ABI 適合（PASS）

- `tests/offline.rs::real_vst3_abi_loads_processes_and_drops`: `/Library/Audio/Plug-Ins/VST3/` の優先候補→全件から**最初に load できた実プラグイン**を probe subprocess で load→setupProcessing→process（無音 + 既知入力）→drop。全滅なら panic（loud STOP gate・silent-skip 禁止）。
- **独立再検証済み（非サンドボックス）**: `V-Pan` / `ARC 4`（IK）/ `AmpliTube 5`（IK）が **load+process 成功**（`processed:true`・出力の NaN/Inf/発散なしを probe が検証）。
- 実 Steinberg-SDK 製プラグインが我々の手書き COM ホスト経由で実際に process() を通し kResultOk + 妥当出力を返した ⇒ **binding ABI は実 SDK と適合**（owner 提起の「相互一貫的に間違い」懸念をクリア）。

---

## 5. compatibility sweep — 実コレクション互換マトリクス

`sweep.sh`（1 プラグイン = 1 サブプロセスで crash 隔離・timeout 20s）を `/Library/Audio/Plug-Ins/VST3/` 全体に実行。JSON から精分類:

| 分類 | 件数 | 割合 |
|---|---|---|
| **effect 処理OK**（load + process 成功） | **188** | 56% |
| instrument（load成功・audio_in=0・Phase 0 は正常に未 process） | 49 | 15% |
| host-limit fail（load できたが setProcessing 失敗 / load=false・非 crash） | 59 | 18% |
| **genuine crash**（signal 死） | 36 | 11% |
| hang | 0 | 0% |
| （JSON 未パース） | 1 | — |

**load 成功（effect_ok + instrument）= 237 / 333 = 71%。**

### 🔴 重大な計測上の注意（サンドボックス汚染）

初回 sweep は codex のコマンド**サンドボックス下**で走り、crash=220（66%）と出た。これは **artifact**:
- サンドボックスが `/bin/ps`・`/Volumes` 読み・helper spawn 等プラグイン init の正当な動作を SIGKILL → 偽 crash 化（例: `V-Pan` は sandbox で crash・非サンドボックスで PASS / `ARC 4`・`AmpliTube 5` も同様に反転）。
- **非サンドボックスで再走した結果が上表**（真の crash は 220 → **36**・約 6 倍の水増しが解消）。
- 教訓: **VST3 sweep はサンドボックス外で計測する**（プラグイン init は環境依存動作を伴う）。raw 結果は `target/vst3-sweep-*.txt`（gitignore・非コミット）。

### genuine crash 36 件の内訳

**ほぼ全て Native Instruments フレームワーク**: Kontakt(7/8) / Massive(X) / FM8 / Reaktor 6 / Guitar Rig(6/7) / Maschine 2 / Komplete Kontrol / Battery 4 / NI Solid 系（EQ/Bus Comp/Dynamics）/ VC 系（160/2A/76）/ Replika / Raum / Phasis / Flair / Choral / Bite / Dirt / Driver / Freak 等。
→ 単一ベンダーの共通ランタイムに集中 ⇒ **均一な host ABI バグではなく、NI ランタイムが最小ホストに欠けている前提（host context / IHostApplication 等）を要求している**と推定。Phase 1 の host context 実装で多くが解消する見込み（要検証）。

---

## 6. spike で判明したホスト制約（= Phase 1 の作業項目）

最小 spike ホストは意図的に以下を省いた。これが host-limit fail(59) / 一部 crash(36) の主因:

1. **null host context**: `IComponent::initialize(null)` を渡している。IHostApplication / IComponentHandler を context から query するプラグインは null を掴んで fail/crash する（NI 群が該当と推定）。→ Phase 1 で**最小 IHostApplication を実装**。
2. **bus arrangement 未調停**: `IAudioProcessor::setBusArrangements` / `IComponent::activateBus` を呼んでいない。これを要求するプラグインは `setProcessing` が失敗（iZotope `setProcessing: 3` が該当）。→ Phase 1 で**宣言 bus を query→arrange→activate**（[[orbitscore-engine-fundamental-effects-as-plugins]] の I/O サーフェス完全カバー要件とも一致）。
3. **単一 stereo 固定**: multi-out / sidechain / mono 等の bus 構成は未対応（現 M1 と同じ既知 gap）。

これらは正本 plan の Phase 1（1a-1d）で対称実装する。**Phase 0 gate（① + ② + sweep）には非該当**（gate は代表実プラグインで通過済み）。

---

## 7. 工数見積り（Phase 1 — production OOP effect）

正本 plan §Phase 1 の 1a-1d に加え、本 spike で判明した host context / bus 調停を織り込む。

| 項目 | 規模感 | 備考 |
|---|---|---|
| 1a `orbit-vst3-host` production 化（spike を公開 API 整理・`PostProcessor` 実装） | 中 | spike が土台済み |
| host context（最小 IHostApplication）実装 | 中 | crash 36 の主因解消・**NI カバレッジ回復の鍵** |
| bus arrangement 調停（setBusArrangements/activateBus） | 中 | host-limit 59 の主因解消 |
| 1b effect/instrument 判定（getBusCount・spike で実装済み） | 小 | overwrite/add-mix の取り違え注意 |
| 1c `orbit-vst3-effect-child`（`orbit-clap-effect-child` 対称コピー） | 中 | transport 無改変流用 |
| 1d daemon supervisor format 汎化（`ORBIT_EFFECT_FORMAT`） | 小 | spawn/watchdog/respawn は format 非依存 |
| offline oracle parity + gated 実機 harness | 中 | CLAP 側パターン複製 |

委譲: 1a-1d は codex（file-anchored）。host context の COM 設計は Opus checkpoint 推奨。

---

## 8. 成果物（Phase 0 で追加/変更したファイル）

- `rust/crates/orbit-vst3-host/`（Cargo.toml・`src/lib.rs` = 手書き COM host・`src/bin/vst3_probe.rs`・`tests/offline.rs`・`sweep.sh`）
- `rust/crates/orbit-vst3-gain-oracle/`（vendored gain.rs oracle・`package-oracle.sh`）
- `rust/Cargo.toml`（member 追加）・`rust/Cargo.lock`
- `docs/development/POST_2.0_VST3_HOSTING_PLAN.md`（Phase 0 受け入れ基準を 2 系統 + sweep に強化）
- 本 verdict doc

検証: `cargo fmt --check` / `cargo clippy --workspace --all-targets --locked -- -D warnings` / `cargo deny check licenses` / `cargo test -p orbit-vst3-host`（①② とも skip なしで PASS）を独立再実行し全 green。
