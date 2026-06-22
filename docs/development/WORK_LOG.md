# OrbitScore Development Work Log

## Project Overview

A design and implementation project for a new music DSL (Domain Specific Language) independent of LilyPond. Supports TidalCycles-style selective execution and polyrhythm/polymeter expression.

## Development Environment

- **OS**: macOS (darwin 24.6.0)
- **Language**: TypeScript
- **Testing Framework**: vitest
- **Project Structure**: monorepo (packages/engine, packages/vscode-extension)
- **Version Control**: Git
- **Code Quality**: ESLint + Prettier with pre-commit hooks

---

## Recent Work

### 6.160 feat(engine): A4-1 named-channel routing + sum-by-name on rust mixer (post-2.0 A4 / #322) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + cargo workspace 全緑（core 単体 5〔routing 分離 / sum 2x / unknown 無音 / unrouted skip / unfiltered 全混合〕+ verify harness 2〔routing 分離・sum-by-name +6dB を実 WAV + region_rms/db_difference で〕。TS 変更ゼロ = npm 影響なし）
**Branch**: `322-linkaudio-routing-sum`
**Parent**: #321（A4 meta）

**背景**: post-2.0 engine-first の parity gap 充填 #2（A3 = PR #320 マージ済の次）。`.orbs` の `outputChannel`（LinkAudio・#209）を Rust 経路で鳴らす A4 の **permissive-first 第1増分**。正本: `POST_2.0_NEXT_STEPS.html §3/§4`。

**Step0（3 偵察 + web spike + advisor + owner 決定）**:
- **parity か net-new か = net-new 確定**: 動く SC 音参照なし（#209 OPEN・`orbitPlayBufLink` SynthDef 未定義）+ scsynth UGen 経路は Rust 非適用 + Rust に tempo 概念皆無・`LinkAudioSink` 無し。Done は「SC 一致」にできず、層A 決定論受信が correct の定義。
- **GPL 面**: 既存 `packages/sc-link-audio` の `link_audio_facade.hpp` は型エイリアスのみ・`channel_registry.cpp` は SC ガード依存でそのまま FFI 不可。`rusty_link` は GPLv2+ かつ標準 Link（tempo）のみで LinkAudio(audio) を wrap しない。→ A4-2 で薄い SC-free C++ shim を新規し sum-by-name は permissive Rust 側に残す（advisor 指摘で GPL 面最小化）。
- **lock-free**: `PostMixSink`/`RingTapSink`/`rtrb` は `orbit-clap-spike`（S1 スパイク）に実証済だが本番未配線。A4-2 で本番へ移植（lock-free 化 + permissive↔GPL 境界を兼ねる）。
- **受信検証**: `LinkAudioSource`（in-process 受信 API）存在だが Link discovery は UDP multicast 依存で同一プロセス/CI 不安定（Ableton/link #50）・SC 側も headless 受信未検証。

**owner 決定（2026-06-22）**: ①検証境界 = 層A headless + **層B も headless 試行**（discovery 不成立なら手動 fallback を報告・stop&report）②GPL 隔離 = feature-gated 薄 crate in-process（default off）③staging = permissive-first 4 分割（PR1 routing+sum → PR2 GPL crate+shim+cargo-deny → PR3 tempo leader → PR4 across-respawn e2e）。

**本 PR（A4-1）の実装**:
- `orbit-audio-core`: event に `channel: Option<String>` タグ追加（`ScheduledSample`/`ActiveSample` + `with_channel`）。`render` を `render_filtered(out, channel_filter)` に refactor（filter=None で従来の hardware sum とビット同一）+ `render_channel(out, name)`（同名 channel は自然加算 = sum-by-name・DSL §8.1.2）。`Engine::render_channel` / `schedule_with_play_id` に channel を thread。
- `orbit-audio-daemon`: `EngineWrap::play_at` に `channel` 引数 + `render_offline_channel`（層A 決定論受信側・cpal 非依存）。wire（protocol channel_name 解析）は A4-2 へ（session.rs は `None` 固定）。
- 「耳」活用: 既存 verify ハーネス（#307/#311 の `region_rms`/`db_difference`）に per-channel PCM を通し routing 分離 + sum-by-name +6dB を実 WAV で検証。

**運用**: GPL/Ableton Link を一切導入しない permissive 増分。SC 既定経路 無改変・audio `play()` 意味論 無改変。Rust workspace は CI fmt/clippy 非 gate（追加コードは周囲スタイルに整合）。

**/simplify 適用（4観点並列）**: ① `render_offline`/`render_offline_channel` を `render_offline_inner(closure)` に共通化 ② `Engine::render`/`render_channel` を `with_scheduler` ヘルパに集約 ③ altitude 指摘で `Engine::render_channel` に `#[doc(hidden)]`・`Scheduler::render_channel` を `pub(crate)` に絞り「混在呼び出し禁止」の prose-only 不変条件を crate 外へ露出しない（本番 RT caller は A4-2 で追加）④ テスト `body` クロージャを `rms_avg` ヘルパに hoist。efficiency = クリーン。test 構造重複（reuse minor）は test 閾値で skip。

### 6.159 feat(engine): slice varispeed parity — chop rate≠1.0 on rust engine (post-2.0 A3 / #319) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + 全テスト緑（npm 全緑・cargo workspace 全緑。core 単体6 = varispeed 5〔rate=1.0 ビット同一 / 倍 / 半 / invalid / fade*rate〕+ stop_all 1、統合 varispeed 1、StopAll protocol 1、TS rate/stopAll/Gap5。PR レビューで fade*rate テスト + stopAll エラー可視化を追加）
**Branch**: `319-slice-varispeed`

**背景**: post-2.0 engine-first の次フェーズ（cutover #108 までの parity gap 充填の1つ目 = A3）。#304（PR #305）が「見かけの parity を作らない」ために rate≠1.0 を 1回 warn + 自然尺に倒した箇所を、実機で尺合わせ再生する。正本: `POST_2.0_NEXT_STEPS.html §4 A3`。

**Step0（2 spike + advisor + owner 決定）**: ① **Signalsmith Rust binding spike** = `signalsmith-stretch`(MIT) が存在し proceed 可（早期採用・production 実績は自前）。② **DSL 意味論 spike**（spec + SC 一次資料）で **核心の再構成**: slice rate≠1.0 の SC parity は SC `PlayBuf.ar(rate: sliceDur/slotDur)` = **純 varispeed（ピッチも動く）**で、pitch-preserving stretch は SC 経路に存在しない → **parity を埋めるのに Signalsmith は不要**。一方 `fixpitch()`/`time()` は SC 未実装の **net-new #213 機能**（Signalsmith FFI + license gate 新設 = 高リスク）。③ 前提誤り訂正: 「cargo deny / deny.toml 前例あり」は事実誤認（リポジトリに不在）。

**owner 決定（2026-06-22・blast radius が決め手）**:
- **Q1 = varispeed-only**。A3 = slice rate≠1.0 varispeed（Rust 内部完結・SC 経路/共有 DSL 表面に非接触・新依存ゼロ）+ 織り込み3件。**fixpitch()/time()/Signalsmith/cargo-deny は #213 follow-on へ分離**（手戻りゼロ: varispeed primitive を後で再利用）。
- **Q2 = time()=varispeed + 将来 stretch() 予約**（spec 方向を記録）。「rate 変化=varispeed」一貫。pitch-preserving は fixpitch+time の合成で得られる。

**varispeed 設計（advisor 承認）**: `ScheduledSample.rate` + 分数読み位置 `read_pos: f64` を導入し、core render を「source を `rate` 倍歩幅で分数走査 + 線形補間」に変更。**rate=1.0 で frac=0 → 元サンプルにビット同一**（既存 slice/pan/fade テスト無改変で通る厳密な一般化）。fade は出力時間（slice_len/rate）で数える。`rate = sliceDuration / eventSlotDuration`（SC `calculatePlaybackRate` と同形）を TS 側で計算し daemon へ送る。出力尺 = `effective_len_frames / sr / rate`（PlayEnded もこの出力終端）。

**seam（TS→daemon→core を一貫）**: `rust-engine-player.ts`（`resolveSliceRegion` を warn から rate 算出へ・`toDaemonParams`/`executePlayback` が rate を渡す・GapKind から `slice` 除去）→ `daemon-client.ts`/`protocol-types.ts`（PlayAt に rate）→ `session.rs`（rate 解析・pan 同様 reject せず 1.0 丸め）→ `engine_wrap.rs`（出力尺 /rate）→ `engine.rs`/`scheduler.rs`（varispeed render）。spec-first で `INSTRUCTION_ORBITSCORE_DSL.md`（slice-fit varispeed §3 + time()/fixpitch()/stretch() §12）と `ENGINE_DAEMON_PROTOCOL.md`（PlayAt rate + StopAll）を先に更新。

**織り込みフォローアップ3件**:
- **daemon hard-stop-all（global）**: core `Scheduler::stop_all()` + daemon `StopAll` コマンド + TS `stopAll()` 配線（disposed/respawning/未接続では skip）。varispeed の rate<1.0 長尺 voice が global stop を跨いで鳴り続けるのを断つ。**per-sequence selective stop（`clearSequenceEvents` の play_id 追跡）は明示 defer**（balloon 厳禁・要 owner 判断＝#319 コメント記録）。
- **Gap5**: quit-during-respawn の CI テスト（mock・respawn backoff 中の quit が clean に終わる）。
- **bot Finding 2**: connect 時 error の二重ログ修正（永続 onError を open 後に attach・connect once を open で detach）。

**検証（Done 基準＝offline 決定論 PCM）**: core 単体（rate=2.0 で倍勾配・rate=0.5 で補間・rate=1.0 ビット同一・invalid rate 丸め）+ **統合**（`verify_schedule_pcm.rs`: 同一 slice を rate=1.0/2.0 で実 `play_at`→render し rate=2.0 が半尺で終わることを PCM の信号終端比で確認）+ StopAll protocol + TS（rate 送信・stopAll・Gap5）。capture seam は含めない（offline で足りる・#300 Step0 の決定を維持）。

**明示 defer**: fixpitch()/time()/Signalsmith/cargo-deny → #213 / capture seam / A4 LinkAudio / γ / cutover #108 / per-sequence hard-stop。

### 6.158 feat(engine): recovery floor — daemon supervision + auto-respawn + 最小 recovery contract (post-2.0 α / #300) (Jun 22, 2026)

**Date**: 2026-06-22
**Status**: ✅ 実装 + 全テスト緑（npm 1162 passed / 27 skipped・cargo daemon 全緑）+ **gated kill-test 2/2 PASS**（SIGKILL hard-death / InjectFault panic clean-exit）
**Branch**: `300-recovery-floor-daemon-supervision`

**背景**: post-2.0 engine track の最初の `/goal2`。owner 決定（2026-06-21・「機能より fundamental を先に」）= α recovery floor（fault ①）。**CLAP/Rust daemon が落ちても TS engine / アプリ全体が引きずられて落ちない**ことを保証する。後続 in-process 楽器（β〜）の安全網でもある（fault ③ = 1st-party in-process crash は①の respawn でのみ捕捉）。pan/slice/per-slice gain は goal1 #304 で実装済 = 再実装しない。正本: `POST_2.0_ENGINE_AND_DISTRIBUTION.md §2.2/§2.5/§7`・アーキ決定 #298（fault 3層 §4）。

**接地した設計前提（コード調査で裏取り）**: 「active loops」を定義する状態は**全て TS 側に在る** — ループの再スケジュールは TS の `setTimeout`（`loop-sequence.ts`・daemon 非依存）、発火待ちキューは `RustEnginePlayer.scheduledPlays`+`liveSequences`。daemon が持つのは disposable な3つ（loaded samples / in-flight voices / transport clock）だけ。→ owner 前提（**権威保持者は TS・daemon は disposable**）が成立。よって supervisor は生存側 = `RustEnginePlayer` に置く（DaemonClient を所有し session 状態の権威を持つ唯一の自然な設置点）。

**Step0 owner 決定（4問・全て推奨案で確定）**:
1. recovery contract = #300 のまま確定（balloon させない）。replay すべき隠れ state は無く（global gain は rust 経路未使用・output device は default）、**active loops のみ replay + 再 anchor だけ**で満たす。
2. fault 注入 = **kill -9（hard-death）+ gated panic コマンド（clean-exit/panic-hook 経路）**。「misbehave synth を segfault に拡張」は daemon が CLAP を非ホスト（daemon CLAP 統合は明示 defer の後続段）なので daemon を殺せない → owner と再設計。supervisor から見れば kill -9 と C-ABI segfault は ws drop に収束。
3. kill-test = **ローカル実機 + 記録した手動 validation（gated・既定 skip）**。CI gate にしない（実プロセス kill は CI で flaky/危険・librosa cross-check と同パターン）。
4. PCM 可聴ギャップ数値化（play --capture seam）は **含めない・state-level Core のみ**（#307 で明示 defer の重い増分）。

**設計（advisor 承認）**:
- **検出（両系統が単一経路に収束）**: `DaemonClient` が「quit() 由来でない ws close」を `daemon-died` event で emit。`intentionalClose` フラグで意図的 quit と crash を区別、`wasRunning` で起動成功後の close のみを死と判定。clean exit（panic hook→exit1）も hard death（segfault/SIGKILL・hook 素通り）も**どちらも ws close に収束**。kill -9 時の ws `error`（ECONNRESET）は永続 listener で吸収し unhandled throw による TS 巻き込みを防ぐ。
- **supervisor（`RustEnginePlayer`）**: `daemon-died` → respawn（single-flight・backoff・上限5回）→ `establishSession`（getStatus 再 anchor + StreamStats off→on 再購読）。同一 DaemonClient を再利用し配線を安定化。
- **唯一 load-bearing な不変式 = 再 anchor の「順序」**: 死後 `clockAnchor` は死んだ daemon の transport（例 2s）を指す。再 anchor 完了**前**に dispatch すると新 daemon（transport=0）へ「2 秒先」を送り 2 秒の desync。→ `respawning` フラグで再 anchor 完了まで `executePlayback` を guard（dispatch を drop = one-shot drop / gap・catch に頼らず順序保証）。`sampleIds` は破棄して lazy 再ロード、`durations` は file 由来で保持。
- **active loops 復帰 = 構造的**: poll ループと TS の loop timer は死を跨いで生存 → respawn 後は自動的に新 daemon へ dispatch 再開。
- **上限到達時**: TS プロセスは落とさず（recovery floor の最終保証）poll ループだけ止め fatal を一度だけ出す。

**fault seam（gated）**: daemon に `InjectFault` コマンド（`ORBIT_DAEMON_ALLOW_FAULT_INJECTION=1` のときだけ受理・既定無効）。panic→panic hook→exit(1)+stderr DaemonError = TS が検出すべき clean-exit 経路を実プロセスで通す。hard-death は外部 SIGKILL（daemon コード0行・panic hook 素通り = C-ABI segfault の忠実な代理）。

**kill-test（#300 受け入れ gate・invariant ベース・実時間 kill は非決定的なので exact-match しない）**: `tests/audio/rust-engine/real-daemon-recovery.spec.ts`（PRODUCTION モード = player が daemon を spawn・所有し supervisor が実際に respawn する経路）。transport を ≥2s 進めてから kill（advisor: t≈0 だと stale anchor≈fresh anchor でバグが隠れる）。検証: (1) liveness=poll 生存・新 pid・loops 復帰、(2) **transport 再 anchor**=復帰後 daemonNowSec が kill 直前より大きく下がる（stale anchor を引きずらない・唯一 load-bearing）、(3) onset clip しない=lead≈lookahead、(4) daemon-side 状態クエリ=fresh uptime / sample 再ロード / active_plays 健全。CI-safe な supervisor 状態機械テスト（mock・respawn 成功/上限失敗の2本）も `rust-engine-player.spec.ts` に追加。

**主な変更**: `DaemonClient`（`intentionalClose`/`daemon-died`/`socket-error` 吸収/`childPid`・`injectFault` seam/handshake orphan-reject 修正）、`RustEnginePlayer`（supervisor: `respawning`/`disposed`/`respawnPromise`・`establishSession`・`respawnLoop`・guard・`onPlaybackError` を respawn 任せに変更・`daemonPid`/`injectDaemonFault`/`getDaemonStatus` seam）、`session.rs`（gated `InjectFault`）、`protocol-types.ts`（`InjectFault` method）、`mock-daemon-server.ts`（`dropConnections`）。

**/simplify（4観点並列）**: 適用 = ① respawnLoop を try/finally で `respawning=false` 単一リセット化 ② dead な `inflightLoads.clear()` 削除（rejected 時に `.finally` で自己削除済み）③ `delay()` inline 化 ④ `InjectFault` の kind 二重デフォルトを unit コマンドへ collapse（YAGNI）⑤ `socket-error` 診断 emit に house style 注記。altitude は構造（supervisor 配置 / detection seam / 同一 client 再利用 / 3フィールド / @internal seam / handshake catch）を affirm。skip = waitFor/定数抽出（gated 統合テストは兄弟 timing.spec と同じく self-contained が house style）・`delay`↔SC `sleep` 統合（SC 経路無改変）。

**/code:pr-review-team（4専門・round 1）**: **Critical 1**（code-reviewer opus + silent-failure-hunter が独立に同一指摘）= respawn の `establishSession` 中に新 daemon が即死すると、getStatus の DaemonConnectionError を anchor=0 で吸収して誤って成功宣言 → 再死の daemon-died が single-flight に吸収され respawnPromise 解決 → 二度と respawn されず dispatch 永久 drop（recovery floor が黙って死ぬ）。修正 = respawnLoop で establishSession 後に `!isRunning()` を確認し retry（`continue`）。Important = `onPlaybackError` に DaemonQuitError 追加 / `socket-error` ghost event を console.warn 可視化 / test gap（再 anchor 不変式・in-flight one-shot 非再発火・quit が respawn 抑制）。Minor = `void ensureRespawn` の安全網 catch / quit の空 catch ログ化。CI-safe mock テスト4本追加（再 anchor desync・one-shot 非再発火・**re-death 回帰**・quit 抑制）。code-reviewer は残りの状態機械（respawning stuck / double-respawn / quit during respawn / intentionalClose race / 順序）を sound と確認。CI（build + code-review bot）pass。**round 2（独立再レビュー）**: code-reviewer(opus) は Critical 修正を実証検証（該当行を revert → re-death テストが wedge/timeout → 回帰テストに牙があると確認）し **CLEAN**。test-analyzer も 4 新テストを非 vacuous と検証し Critical/Important 0。silent-failure の Important 1（`ws-close-error` emit が無 consumer = 実質 silent。round-1 の onError console.warn 化と整合させ console.warn へ）+ Medium 1（re-death `continue` の warn 追加）+ polish（one-shot テストに settle 猶予）を follow-up で解消 → **Critical/Important = 0 に収束**。

**`@claude` bot second-opinion（advisor 推奨・PR #294 前例で internal の blind spot を検出した実績）**: load-bearing seam に絞って起動。**Blocking issue なし**・load-bearing invariant 表は全 ✅（intentionalClose 判別 / wasRunning / handshake catch / respawning finally 順序 / re-death continue / sampleIds vs inflightLoads / single-flight / quit teardown / InjectFault gate）。Finding 1（actionable）= `request()` が CLOSING window で plain Error を投げ `onPlaybackError` の silent-drop を抜け misleading ログ1回（S2 既知 Finding F・correctness ではない）→ `DaemonConnectionError` 化で解消。Finding 3 = executePlayback ガードのコメントが post-guard TOCTOU は catch 任せである旨に触れていない → コメント精度化。Finding 2（connect 時 error の二重ログ・cosmetic）/ Finding 4（quit backoff latency・非問題）は bot 自身が後回し合理的と判断 → defer。

**検証の境界（正直な明記）**: 「active loops 復帰」は **RustEnginePlayer レベルの continuous-stream プロキシ（gated kill-test + mock テスト）+ 構造論**で検証している。loop の再スケジュールは `loop-sequence.ts` の setTimeout（純 TS・daemon 非依存）なので daemon 死の影響を受けず、生存した poll ループへ scheduleEvent し続ける → respawn 後に新 daemon へ自動的に dispatch 再開、が構造的に成立する。ただし **実 `loop()` を `createAudioEngine` 経由 full interpreter で respawn 跨ぎさせる end-to-end は未実施**（S2 の timing parity が「直接駆動・end-to-end 未実施」と境界を明記したのと同型）。閉じる場合は gated e2e テスト1本で足りる（optional・owner 判断）。

**follow-up note（非ブロック・code-reviewer round 2 で sound 確認済）**: Gap 5 = `quit()` が respawn の backoff 中（~150ms）に着地するケースの CI テストは未追加（`disposed` checkpoint + `await respawnPromise` で正しいと確認済・consequence は narrow window の cleanup race のみ）。

**明示 defer**: out-of-process per-plugin isolation（γ・fault ②）/ β audio DSL⊇pitch / time-stretch / LinkAudio(A4) / cutover #108 / play --capture seam（PCM 可聴ギャップ数値化）。

**post-#300 計画 doc + drift 監査（owner 依頼・本 PR 同梱）**: マージ前に「第1増分後の実装計画」を新規 `docs/development/POST_2.0_NEXT_STEPS.html`（snapshot 2026-06-22・MASTER_PLAN の前向きたたき台）に集約 = ①到達点（A0/S1/S1b/S2 + #304 + #300）②**cutover #108 までの parity gap**（#304 が warn/no-op に倒した time-stretch=A3 / LinkAudio=A4 / master effects=γ）③#300/#304 で意図的に defer した小粒の follow-up トラッカー（play --capture seam / Gap5 quit-during-respawn / active-loops e2e / daemon hard-stop-all / bot Finding 2・4）④次 /goal 候補（contained な A3/A4 を先に・γ は段階化、owner 判断）。仕様 drift 監査（agent）= **specs-v2 / core spec は engine/recovery 非言及で drift 無し**、recovery は DSL 意味論を変えないので core spec にセクション不要。事実 status の drift のみ本 PR で修正（done マーク）: ENGINE_AND_DISTRIBUTION §2.2「auto-respawn 未実装」→ 実装済 / §2.5・§7 第1増分=done / A0 §14 pan=done + Finding F 解消 / MASTER_PLAN.html §2・§3・§9 第1増分=done。既存正本の「次フェーズ=X」決定は書かず新 doc を参照（次の選択は owner にティーアップ）。Epic #292 本文 status はマージ後に gh で更新。

**owner 決定（2026-06-22・advisor 反映）を NEXT_STEPS.html に追記**: ① **次フェーズ順序 = A3 time-stretch → A4 LinkAudio**、各フェーズの自然な拾い所にフォローアップを織り込み A3+A4 完了で backlog 一掃（A3: daemon hard-stop-all〔stretch で長尺 voice〕+ Gap5 + Finding2 / A4 末: active-loops e2e〔capture 非依存の state-level〕）。残るは capture と Finding4 のみ（意図的）。② **capture seam は A3 に畳まない**（stretch 検証は offline で足りる・#300 Step0 の「含めない」決定を覆さない）。capture は 2 独立 trigger=（a）dog-food の可聴ギャップ実測〔前倒しうる〕/（b）耳なし実時間検証基盤〔cutover までに確実〕。③ **計測/耳なし検証レイヤ（#307/#308/#313 verify ハーネス + librosa grounding）を再利用資産として再ラベル**（新トラック発明せず）。④ **north-star: (C) score-following / アルゴリズム的「聴く」/ LLM 演奏計画は WCTM 別トラックの研究ビジョン**（engine スコープ外）。依存方向 = engine→計測語彙→(C)、責務境界 = engine は計測語彙をクリーンに保つだけ・(C) の alignment/入力/streaming は抱えない。共有=特徴抽出の語彙 / 用途別=配管。新規性は「DSL 譜面整合 + LLM 計画駆動」の統合部分に限定（score-following 自体は確立 MIR）。先回り実装はしない（投機的一般化の禁止）。

**Commit**: 7aabde7（実装 + /simplify cleanup）/ ff4259c（pr-review-team round 1）/ ff9bb72（round 2 → Critical/Important=0 収束）/ + bot follow-up + post-#300 計画 doc・drift 監査

### 6.157 verify(audio): retroactively self-verify #304 (examples/22 params) via harness — close #307 (#316) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 全テスト緑（cargo daemon verify_schedule_pcm 4 / verify 30 / npm 1161 passed）。#307 の受け入れ基準（examples/22 を耳なし PCM 検証）を達成
**Branch**: `316-verify-examples22-goal1`

**背景**: harness epic #307 の受け入れ基準に「examples/22（pan/slice/per-slice gain）を capture して PCM アサーションで #304 を遡及的に自己検証（耳に依存しない裏付け）」がある。phase 1〜3（#310/#312/#314）でハーネス・assertion lib・tier-c・librosa grounding は揃ったが、**#304 の実 deliverable を耳なし検証する最終増分が未達**だった。本増分でこれを満たし #307 をクローズ（完了済み phase-2 #311 も併せて）。

**examples/22 の制約**: `examples/22_rust_engine_parity.orbs` は 4 voice 同時並行の dog-food デモで、各拍に複数 voice が重畳し L/R RMS がミックスになり per-event の pan/gain を分離不能（研究 §4.4）。→ **生ファイルに per-event assert を当てない**。

**設計（advisor 承認・(A) offline）**: examples/22 と同じ素材（kick/snare/hihat/arpeggio）+ #304 の実パラメータ（pan -0.6/+0.6/0/+0.2・gain -3/-6/-9/-4・chop(1) 全体 と chop(2) 領域）を **de-overlap した検証 fixture** `examples22_parity.orbs` に組み、phase-2 の 2 本足で検証。tempo 120 / length 4 / 16 要素 → 0.5s grid（spec: length(2)→8要素 と同型・subdivision は play 要素数で決まり chop と独立）。kick@0s / snare@2s / hat@4s / chopd slice1@6s・slice2@7s（rate=1.0）。

**2 本足**: Leg 2（TS）= InterpreterV2 schedule vs **手書き独立オラクル**（onset/gainDb/pan/slice を .orbs+DSL 仕様から導出・トートロジー回避）。**length>1 を harness で初めて通したが独立オラクルと一致**（interpreter が length>1 を正しく処理）。Leg 1（Rust）= golden → 実 `EngineWrap::play_at` offline render → PCM で **pan を atan2 独立逆算（kick -0.6 / snare +0.6 / hat 0 / chopd +0.2）+ chop(2) 領域 + イベント間無音** を検証。

**gain の扱い（正直に）**: gain 値（-3/-6/-9/-4）は**異なるサンプル間で RMS 比較不能**（固有レベルが違う）ため Leg 1 では検証しない。gain は Leg 2（gainDb/linear の計算）+ phase-2 per_event_gain（同一サンプルの dB 差を実レンダで）でカバー済み。

**スコープ外**: 生 examples/22 の literal smoke（examples/ 配下・別パス・重畳で friction 高く弱い検証）は見送り、de-overlap fixture で acceptance を満たす。CLI `play --capture`（#307 ②・重い）は /goal2（#300）へ defer（#307 が「capture は respawn 後の可聴ギャップ計測に効く」と明記）。

**意義**: 以後の audio 増分（#239 slice / #213 time-stretch / effects）が「耳」でなく PCM で機械検証可能に。#307 が「capture は daemon respawn 後の可聴ギャップを PCM で測れる → goal2 検証に効く」と明記しており、goal2（#300 recovery floor）への橋にもなる。

**/simplify（4観点並列）**: reuse/efficiency は重複・無駄なし（既存 phase-2 パターン踏襲）。altitude の 1 件のみ適用 = Rust `tail_trim` を動的式 `(span/4).min(600)`（本 fixture では全 span≥2400 で常に 600）から既存 fixture と対称な固定 `600` に簡約（挙動同一）。chopd assert のループ化等は「明示の方が読みやすい」で leave-as-is。

**/code:pr-review-team（4専門・1 round 収束）**: Critical/Important=0。code-reviewer がオラクル全値（onset/gain linear+dB/pan raw+daemon/chop offset/sentinel）を .orbs+DSL 仕様から**独立再導出して一致確認**（循環でない裏付け）。Minor 3件適用: ① Leg1 ループ前に `assert_eq!(events.len(),5)` ガード追加（兄弟 per_event_gain テストと対称・golden truncation 時の vacuous green 防止）② `.orbs` の無音間隔表記を正確化（chopd slice1-slice2 間は 0.5s）③ slice 領域「内容」正しさは `chop_region_real_wav.rs` が担う旨の layering 注記。bot は新規外部主張なしで skip（advisor カリブレーション = verify 系は proportional）。

**Commit**: b763abc（実装）+ /simplify cleanup + pr-review-team follow-up

### 6.156 feat(verify): phase-3 — ground measurement primitives against librosa (blind cross-check) (#313) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 全テスト緑（cargo daemon+verify / npm 1159 passed）+ cross_check 3 fixture PASS（leader 独立再現）
**Branch**: `313-verify-phase3-librosa-cross-check`

**背景**: phase 1（#307/6.154）・phase 2（#311/6.155）の tier-c 検証が信頼してきたのは、ハーネス自身の**測定プリミティブ**（`orbit-audio-verify`: `region_rms` / `pan_from_lr_rms` の atan2 逆算 / `detect_onset_threshold`・`detect_onset_matched`）。これまでプリミティブは Rust 単体テスト（既知アンカー）でしか裏付けが無く、誰も**独立 MIR ツールと突き合わせていなかった**。tier-c の土台がプリミティブの正しさに乗っているため、librosa を独立 oracle に置いて**プリミティブ層で GRM 独立性を成立させる**（差分検証）。研究記録 = #308 / `docs/research/AUDIO_OUTPUT_VERIFICATION.md` §4.2/§4.4。

**独立性の質を正直に書き分ける（中核）**:
- **onset = アルゴリズム独立（本丸）**: librosa の spectral-flux peak-picking は ours（threshold / matched-filter）と別アルゴリズム。真の差分。librosa の検出値は ours とも scheduled とも異なる独立値（per_event_gain loud で librosa=4608, ours=scheduled=4800）。
- **level = 実装独立**: librosa も `sqrt(mean(x²))`（式は同じ）。捕まえるのは生 PCM 読み込み（`np.fromfile` の interleave/reshape）・channel 取り出し・dtype の**配管**。「RMS の数学を独立に再導出した」とは主張しない。
- **pan = 実装独立**: librosa 由来 per-ch RMS から atan2 逆算（atan2 は純粋数学・`analysis.rs` のアンカーで別途 pin 済）。grounding は per-ch RMS の一致に帰着。

**seam（WAV codec を検証対象に混ぜない）**: Rust example `export_verify_pcm`（`orbit-audio-daemon`・example は dev-dep `orbit-audio-verify` を使える唯一の置き場）が phase-2 fixture を本番 `EngineWrap::play_at` でオフライン決定論レンダ → `CapturedAudio.data` を**生 LE interleaved f32** でダンプ（`.gen/`・gitignore・再生成可能）+ 自プリミティブ測定値を `<fixture>.rust.json`（committed）に出力。Python `cross_check.py` が生 PCM を `np.fromfile(dtype='<f4')` で読み **librosa を numpy 配列に直接**かけて突き合わせ、`<fixture>.compare.json`（committed）を出力。

**onset 3-way**（ours / librosa / 既知スケジュール）: librosa 単独は hop=512≈10.7ms で弱いオラクル → scheduled を strong ground truth に据え librosa を独立 witness に。許容 = ours↔sched ±2ms(96fr) / librosa↔sched ±15ms(720fr) / level 相対 ≤3% / pan ±0.05。

**結果（全 fixture PASS・leader 独立再現 exit 0）**: level lRelErr=0.0（窓一致で配管確認）/ pan Δ=0.0（left/mid/right=−1/−0.5/+1）/ onset ours 0〜+9fr（attack fade 無しでほぼ sample-accurate）/ librosa −64〜−448fr 先行（spectral-flux+backtrack の系統傾向・全件許容内）。`chop_region` の spurious 4 は chop 内部境界の再立ち上がり（scheduled 全件マッチで verdict 不変）。**librosa デフォルト `frame_length=2048` は減衰信号で ~30% 系統ズレ**→窓長明示が必須（py-crosscheck が発見・修正）。

**CI 方針（owner 確定）**: **CI gate にしない**。版固定 `requirements.txt`（librosa==0.11.0 等）+ committed script + 本記録 + `tests/audio/verify/phase3/README.md` の Recorded validation。理由: librosa/numba は版脆弱・onset は frame 解像度で gate だと flaky・回帰は既存 Rust アンカーテストがカバー。self-test（`--selftest`）で機構の正常/異常検出を回帰ガード。

**委譲**: Opus = cross-check 設計（突き合わせ量・許容校正・onset 3-way・GRM 独立性の書き分け・export seam・README/契約・統合/再現確認）。Sonnet = Rust example（render+生f32ダンプ+自測定JSON）/ Python script（librosa 測定+比較）+ 版固定 requirements。leader が selftest cleanup の footgun（`.gen` rmtree で実 PCM 巻き添え）を修正。

**/simplify（4観点並列 + 適用）**: in-file の簡約を適用（named const 化 `BLOCK_FRAMES`/`BODY_HEAD_OFFSET`/`ONSET_SEARCH_MARGIN`・未使用 `panRaw` 削除・`play_span` ヘルパ抽出・matched 分岐コメント / Python: spurious 件数のベクトル化・冗長 `status` 変数と重複 `mkdir` 除去・`_rms` ヘルパ・異常系 selftest を `run_fixture` に統一）。値は不変（rust.json / compare.json バイト一致を確認）。**reuse 最大指摘 = `render_golden`/golden 型 ~80行が phase-2 test と逐語複製**は defer: dedup には merged phase-2 test 改変 + daemon 本体への feature flag + orbit-audio-verify の dev-dep→optional 昇格が必要で reviewed diff の外。両 harness を触る focused follow-up とする（追跡 = #315）。

**/code:pr-review-team（4専門エージェント並列 + 反復）round-1**: Critical 1 + Important 4 を反映。① **selftest 再設計**: 各検出器を 1 ケース 1 摂動で単独 flip 検証（level/pan/onset-ours/onset-librosa）+ spurious assert。従来は L/R 等倍摂動で **pan 検出器が未検証**（Critical）・librosa_matched/空 onset 経路も未駆動だった。② **`detect_onset_matched` を scheduled 真値と整合確認**（従来は Rust が出力するのみで Python 未消費＝「4 プリミティブ grounding」が過大主張）。③ **PCM frame 数を `rust.json["frames"]` と照合**（stale/truncated PCM の silent pass を防ぐ）。④ robustness: `onsetFrameThreshold=null` の TypeError ガード / near-zero RMS 相対誤差の分母 floor / `_selftest*` gitignore / コメント精密化。CI gate 無し方針ゆえ selftest が唯一の自動ガードなので各検出器の単独 flip 検証が要。**round-2**: ⑤ selftest の単独 flip を compare.json の **per-metric フラグで assert**（verdict bool は disjunctive で isolation を保証しない）、⑥ **matched-FAIL 経路を selftest でカバー**（`_selftest_onset_matched`）+ Rust 側で per_event_gain[0] の matched が None なら **expect で loud に**（silent null = grounding 消失を防ぐ）、⑦ burst2 コメント修正。**round-3** で両 reviewer が収束確認（Critical/Important=0）。収束推移: round-1 (C1+I1〜I4) → round-2 (I-A・I-B = round-1 の selftest 強化の深化) → round-3 (0)。

**CI 補足（owner 2026-06-21）**: 現状 CI gate にしないが**将来導入予定**。導入時は版固定 venv を job 化し `export_verify_pcm`→`cross_check.py`（exit code gate）を回す（生成物は決定論）。

**スコープ外（後続）**: 上記 render_golden dedup（両 harness 共有・#315）/ CLI `play --capture out.wav`（決定論 offline-clocking）/ madmom フルスイート / 広い DSL 機能網羅（polymeter/quantize onset）/ 知覚指標 / CI 導入。selftest の残 Minor（`ours=None`・空 onset の guard 分岐の edge path 未テスト・sev 2-3）は意図的に追わない（検証ツールの guard 分岐で収束に影響なし）。

**Commit**: 03c7088（実装）+ 4871fe6（/simplify）+ pr-review-team round-1 follow-up

### 6.155 feat(verify): phase-2 tier-c — interpreter schedule vs rendered PCM (two-leg) (#311) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 自動テスト全緑（cargo --workspace / npm）+ clippy clean。tier(c) を end-to-end で閉じる第2増分
**Branch**: `311-audio-verification-phase2-tier-c`

**背景**: phase 1（#307/PR#310・6.154）は core レンダラ（Scheduler）を直接検証した。phase 2 は **interpreter が .orbs から計算したスケジュール（native 経路）を2本足で検証**し、tier(c)（レンダリング音 ↔ DSL 意味的スケジュール）を engine 層から閉じる。研究記録 = #308。

**2本足（advisor 指摘で循環の罠を断つ）**:
- **Leg 2（interpreter の計算が正しいか）**: `RecordingScheduler` 注入の `InterpreterV2` で fixture .orbs を実行 → 生の構造スケジュール（onset/gainDb/pan/slice index・total）を **.orbs + DSL 仕様から手書きした音楽単位オラクル**と比較。解決済み daemon param 同士の比較はトートロジー（slice offset/duration が両者同式）になるため**生のまま**比較。`calculateEventTiming` + DSL→schedule を直接テスト。
- **Leg 1（renderer が忠実に再生するか）**: 構造スケジュール → 本番共有 `toDaemonParams` で解決 → golden JSON → Rust が実 `EngineWrap::play_at` でオフライン決定論レンダ → phase-1 analysis で PCM 検証。pan は atan2 独立逆算、**slice 領域は golden の offset/duration を再導出しない**（GRM 独立性）。

**seam（本番経路と共有・drift 防止）**:
- TS `RustEnginePlayer`: 発音変換を private `toDaemonParams` に lift（executePlayback と検証で**同一変換**: gainDbToAmplitude / pan÷100 / resolveSliceRegion）。`seedDuration` + `DaemonPlayParams` 型 + `ScheduledPlay`/`SliceSpec` export。behavior-preserving（rust-engine 24 + daemon-client 10 緑）。
- TS `InterpreterV2`: audioEngine 注入 option（既定不変・SC 経路無改変）。
- Rust `EngineWrap::render_offline`: cpal 不使用の block 駆動。play_at の sec→frame / resolve_slice_region を経た出力を捕捉（phase-1 が飛ばした層）。

**決定論化の発見**: `preparePlayback` が `scheduler.isRunning` を要求（RecordingScheduler.start で立てる）、`runSequence` が `baseTime = (Date.now()-startTime)+100`（RUN 先読み）→ **fake timers で Date.now() 凍結**し記録 time = musical onset + 100 を決定論化。

**fixture（3機能・判別力）**: `pan_three_voices`（hard-left/中間-50/hard-right・中間値が線形則を判別）/ `chop_region`（chop(2) grid 一致 rate=1.0・slice 領域の出力/無音）/ `per_event_gain`（gainDb -3/-9 の 6dB 差）。golden JSON は committed・staleness guard（`UPDATE_GOLDEN=1` で再生成）。

**検証**: TS Leg 2 **6 passed**（pan/chop/gain × 2）+ Rust Leg 1 **3 passed**（verify_schedule_pcm）。cargo --workspace 全緑 / npm test 1159 passed / **0 failed**（SC 既定 `SuperColliderPlayer` / `event-scheduler.ts` + daemon 実時間経路 + audio play() 意味論 無改変）。clippy clean。

**委譲**: Opus = seam（toDaemonParams lift / InterpreterV2 注入 / render_offline / 2本足構造）+ pan spine の end-to-end 疎通（決定論化の発見含む）。Sonnet = chop/gain fixture の複製。

**スコープ外（後続）**: CLI `play --capture out.wav`（daemon offline render-to-WAV）/ librosa 相当 blind cross-check / 広い DSL 機能網羅。

**Commit**: 301338e (spine) / 16e6434 (chop+gain)

### 6.154 feat(verify): audio output verification harness — capture + PCM assertion lib (#307) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 自動テスト全緑（cargo --workspace / npm）+ clippy clean。#304 の pan/領域/per-slice gain を **耳でなく PCM 解析で自動裏付け**
**Branch**: `307-audio-verification-harness`

**背景**: #304（PR #305）の native audio parity は OSC 値 parity と scheduler ユニットで固めた一方、「.orbs を end-to-end で鳴らした実レンダリング PCM」の確認は **owner の耳に依存**した。研究記録 #308（`docs/research/AUDIO_OUTPUT_VERIFICATION.md`）の tier (c)（レンダリング音 ↔ 静的スケジュールの突き合わせ）を **engine 層から着地させる第1歩**。

**設計（advisor 承認）**:
- **capture seam = `Scheduler` 直接駆動**。pan/領域/gain/末尾fade はすべて `orbit-audio-core::Scheduler::render` に入っており、それが DUT そのもの。`Engine` 経由（try_lock の理論上 drop）や daemon の `play_at`（sec→frame 変換 = tier(c) 射程外・protocol test で別途カバー）を通さず、最も決定論的な核を block 分割で回す。**実 WAV 要件は loader でロード→`Scheduler.schedule`→render で満たす**。
- **GRM 独立性（差分検証の成立条件）**: checker は core の `equal_power_pan` / `resolve_slice_region` を **import しない**。pan は L/R RMS から `atan2` で独立逆算（レンダラは cos/sin）、領域境界・gain 比の期待値はテスト側に手計算で直書き。同式を共有すると同一バグが両側に乗り差分が消えるため。

**新規 crate `orbit-audio-verify`**（lib 依存は core のみ / native は dev-dep）:
- `capture.rs` — `CapturedAudio` + `capture(scheduler, channels, total_frames, block_frames)`。block 分割で `dst_offset_frames`（実 cpal callback のイベント境界またぎ）も通す。core 無改変のため channels は引数渡し。
- `analysis.rs` — `region_rms` / `channel_rms` / `region_peak` / `channel_peak` / `linear_to_db` / `db_difference` / `pan_from_lr_rms`（atan2 独立逆算）+ tolerance 定数（`PAN_TOLERANCE=0.05` / `GAIN_DB_TOLERANCE=0.5` / `SILENCE_FLOOR_DB=-90`、本レンダラは完全線形ゆえ MPEG 系非線形校正不要）。
- `onset.rs` — `detect_onset_threshold`（閾値立ち上がり）/ `detect_onset_matched`（matched filter 相互相関・整数フレーム）/ `fade_slope_is_linear`（最小二乗の正規化 RMSE で線形 release 判定）。

**遡及検証テスト（#304 を PCM アサートで裏付け）**:
- `tests/pan_real_wav.rs` — 実 WAV `sine_440.wav` を hard-left/center/hard-right でレンダ → L/R RMS から pan 逆算（±0.05）。
- `tests/chop_region_real_wav.rs` — 実 WAV `arpeggio_c.wav` で領域 on/off（領域外は厳密 0）+ 合成 ramp で offset 同定（読んだ source フレーム == offset+local）。
- `tests/per_slice_gain.rs` — 同尺・同素材・中央パンで線形 gain だけ変えた 2 イベント、body 窓 RMS の dB 差 == 指令比（±0.5 dBFS）。
- `tests/onset_fade_capture.rs` — capture 経路で onset 検出（block 境界またぎ）+ 末尾 fade の線形性。

**委譲（§5/§7 規律）**: Opus が capture seam / analysis コア（pan 逆算・tolerance）/ GRM 独立性 / spine（実 WAV pan）を凍結 → Sonnet が onset/fade 本体・残り遡及テスト・フィクスチャを並列実装。

**検証**: orbit-audio-verify **23 unit + 7 integration = 30 passed**（PR #310 レビューで判別力強化 +4: 中間 pan 値・fade 終端値・db_difference 退化分岐・region_peak/should_panic）。cargo --workspace 全緑（core 23 / daemon 14+1 / native 16 / clap-spike 7・回帰なし）。npm test 1153 passed / 25 skipped / **0 failed**（SC 既定 `SuperColliderPlayer` / `event-scheduler.ts` 無改変・audio play() 意味論不変）。clippy clean。

**PR**: #310（`/simplify` + `/code:pr-review-team` 4 専門 → Critical/Important=0 収束。CI code-review pass）。

**スコープ外（後続増分）**: CLI `play --capture out.wav`（TS→daemon→render 全経路）/ DSL 静的スケジュールを GRM にした end-to-end tier (c) / librosa 相当の blind cross-check。

**Commit**: 8759187

### 6.153 docs(research): audio output verification — DSL static schedule vs rendered PCM (#308) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: 調査記録（論文化の可能性あり）
**Branch**: `308-audio-verification-research`

#304 の audio parity 検証が owner の耳に依存したことを発端に、「**DSL が静的計算したスケジュール（onset サンプル/レベル dBFS/pan/slice 境界）を golden reference とし、オフラインレンダした実 PCM を解析して自動突き合わせ**」する自己検証機構の deep research（4観点並列 + LLM 角度の追加1本）を実施し、`docs/research/AUDIO_OUTPUT_VERIFICATION.md` に記録。

- **枠組み**: golden-model conformance testing（GRM=DSL スケジュール / DUT=レンダラ / scoreboard=突き合わせ）。手法は HW/DSP 検証・MPEG conformance で成熟。
- **新規性**: tier (c)（レンダリング音 ↔ DSL 意味的スケジュールのエンジン内蔵突き合わせ）は先行事例未発見。最近接の学術先行研究 = Antescofo/IRCAM のモデルベーステストだが**イベント時刻層で止まり PCM 非到達**。
- **上位フレーミング**: これは **LLM の自己 PDCA（Plan-Do-Check-Act）の Check を audio で人間不在に成立させる機構**。agentic 自己修正は客観 oracle が必須（CRITIC / Huang et al. ICLR 2024）で、本機構は「audio の客観 oracle」を提供。`[LLM agent + 音楽 DSL + PCM 解析 + 静的 symbolic スケジュール + 推論時自律ループ]` の組み合わせは未発見。
- 実装は #307（capture backend + assertion lib + CI gate）。本研究は #308。

**Commit**: bc6f76a

### 6.152 feat(engine): native audio parity increment — pan / slice / per-slice gain (#304) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ 実装 + 自動テスト全緑（cargo --workspace / npm）+ owner ear verdict 取得（pan/slice/per-slice gain いずれも rust で SC 同等に可聴）+ OSC 実値 parity 観測
**Branch**: `304-audio-parity-increment`

post-2.0 engine-first の第1増分（最初の `/goal`）。S2 で defer した audio gap のうち **pan / chop 領域再生 / per-slice gain** を native daemon 経路に実装し、`ORBITSCORE_ENGINE=rust` opt-in の裏で dog-food 可能にした。SC 既定経路は無改変。

- **pan**（SC `Pan2` と同じ equal-power 則・中央 = -3dB / 1√2）: core scheduler render に等パワー定位を実装。daemon PlayAt の `pan`（既に protocol 仕様化済み・実装が追いついていなかった）を配線。TS は DSL の -100..100 を daemon の [-1,1] へ変換して送る。`scheduleEvent` の「pan 未対応」warn を撤去。
- **chop 領域再生**（region-only・rate=1.0）: PlayAt に `offset_sec` / `duration_sec` を追加（spec 先行で `ENGINE_DAEMON_PROTOCOL.md` 更新）。core は ActiveSample に slice 領域（start/len）を持ち、領域だけを読む。SC `orbitPlayBuf` と同じ末尾 fadeout（`min(8ms, dur×4%)` 線形 release）でクリック防止。TS `scheduleSliceEvent` を実装（slice 領域は lazy load 後に `executePlayback` で解決）。物理 slice ファイル（`audioSlicer`）は live 未使用の dead path のため native では再現しない（startPos 領域読みのみ）。
- **per-slice gain**: 各 slice event の gainDb が daemon PlayAt の gain に独立反映され、core render の per-event `active.gain` で適用される（新機構不要）。
- **rate≠1.0（slice 尺→スロット尺の varispeed = time-stretch）は本増分の対象外**。検出時は 1 回 warn し、slice は自然尺（rate=1.0）で鳴らす（time-stretch 増分 #213/#239 へ defer）。`chop()` は「現状 scsynth 仕様をそのまま採用」（owner）が、rate フィットは roadmap の time-stretch 境界に従い defer。

**用語整理（owner 確認）**: `chop()` = n 等分（既存・本増分）。`slice()`（`recycle()` でも可）= Re-Cycle 型のトランジェント/無音検出による文節切り = #239（将来 β）・本増分対象外。

**主な変更ファイル**:
- Rust: `orbit-audio-core/src/scheduler.rs`（pan equal-power + slice 領域 + fadeout）, `engine.rs`, `orbit-audio-daemon/src/engine_wrap.rs`（slice 出力尺で PlayEnded 補正）, `session.rs`（offset/duration parse + 検証）
- TS: `rust-engine/daemon-client.ts`, `rust-engine/rust-engine-player.ts`（pan/slice 配線 + `resolveSliceRegion`）
- docs: `docs/research/ENGINE_DAEMON_PROTOCOL.md`（PlayAt に offset_sec/duration_sec）
- tests: core に pan 4件 + slice 3件、`rust-engine-player.spec.ts` を pan/slice 新仕様へ更新

**テスト結果**:
- cargo --workspace: 全緑（core 21 / daemon protocol 13 / smoke 1 / native 16 / clap 7）
- npm test: 1153 passed, 25 skipped, 0 failed（回帰なし・SC 既定無改変）

**並行成果**: DAW 標準機能リサーチ（`docs/research/DAW_AUDIO_ARCHITECTURE.md`）= 基礎後の routing/effects 層 roadmap 入力（insert 順序 = engine core の graph 管理 / EQ 等 = CLAP plugin / PDC が insert 順と不可分）。

**SC parity 検証（owner）**: `ORBITSCORE_ENGINE=rust` で examples/22・pan sweep（-60→+60 等パワー）・per-slice gain 階段を ear 確認 → いずれも SC 同等（「パワー感も変わらない」= equal-power 一致）。さらに SC 既定経路を `ORBIT_SCSYNTH_PATH` で起動し、SC が scsynth に送る `/s_new`（amp/pan/startPos/duration）と rust が daemon `playAt` に送る値が**バイト一致**することを OSC ログで観測（耳の A/B 以上に厳密なパラメータ parity）。

**Done のスコープ線引き（owner 確認 2026-06-21）**: audio parity（pan/slice/per-slice gain）は **CLI 経路**（`node cli-audio.js` + `ORBITSCORE_ENGINE=rust`）で実証。CLI と .vsix は同一の `RustEnginePlayer`→daemon コードを通るため音は同等だが、**パッケージ済み .vsix からのゼロ設定 daemon 解決は未対応**（`resolveDaemonBinary` は repo 相対パス + `ORBIT_AUDIO_DAEMON_PATH` を探索。.vsix は env 未設定だと未解決。build:copy-engine も daemon 未同梱）。これは distribution 課題として **#306** へ分離（最終形 OrbitStudio/VSCodium の配布で扱う。.vsix は途中の dog-food シェル）。暫定 dog-food は `ORBIT_AUDIO_DAEMON_PATH` 設定で可能。

**残**: time-stretch / LinkAudio / α recovery floor は後続増分。daemon の .vsix/OrbitStudio 解決は **#306**。examples/22 が `RUN`（one-shot ≈2秒）で audition しづらい点は polish 候補（本増分の Done には非該当）。

**post-review cleanup（/simplify）**: 4観点 cleanup agent の指摘を behavior-preserving に適用 —
slice 長 clamp を core の `resolve_slice_region` に集約し scheduler の render 尺と daemon の
PlayEnded 尺の単一情報源化 / 等パワーパンを `schedule()` で precompute して RT render から
trig（sin/cos）と output_channels 分岐を排除 / render の `gain*env` を frame 単位へ hoist /
session.rs の PlayAt param 抽出を `param_f64` ヘルパーで集約 / 旧 spec の `Math.pow` を
`gainDbToAmplitude` に置換。SKIP: TS slice 数式/pan の SC `event-scheduler.ts` との共通化（保護対象の
SC 経路を触るため follow-up）。検証: cargo --workspace 58 緑 / npm 1153 緑 / 変更ファイル clippy クリーン。

**pr-review-team（round 1）修正**: code-reviewer の Important（engine_wrap が生 `requested_len_frames` を
scheduler へ渡していた → clamp 済 `effective_len_frames` を渡し render/PlayEnded の一致を call site で保証）/
silent-failure-hunter（`ensureLoaded` が sampleRate 不正時に無言で slice→全体再生 degrade → ソースで warn）/
comment-analyzer（slice の旧「skip」コメントを領域再生実装済みへ更新）/ pr-test-analyzer（`resolve_slice_region`
境界・ステレオ slice の channel stride・`duration_sec<0` 拒否の3テスト追加）。検証: cargo 61 緑 / npm 1153 緑。

**pr-review-team（round 2）**: round-1 修正を独立再レビュー。code-reviewer/comment-analyzer/pr-test-analyzer は
0 件（#R1 の effective_len_frames は全ケースで render/PlayEnded 一致・3 新テストも算術的に正しく load-bearing と確認）。
silent-failure-hunter が sibling edge を 1 件検出（`ensureLoaded` が sample_rate のみ検証し `frames` 未検証 →
`frames=NaN` だと `NaN<=0===false` で fallback guard 素通り）→ `frames` 有限・非負も検証 + `resolveSliceRegion`
guard に `!Number.isFinite` を defense-in-depth 追加。検証: npm 1153 緑。

**Commit**: d3be514（実装）, 9282e6c（log ref）, +simplify cleanup, +pr-review fixes（round 1/2）

### 6.151 docs(post-2.0): correct roadmap to engine-first (supersede OrbitStudio-first framing) (#302) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ docs/spec のみ（HTML タグバランス検証済・残存矛盾なし）
**Branch**: `302-roadmap-engine-first`（PR 予定・docs-only）

6.150（#298/#299）で記録したアーキ §2.1–2.4（楽器=in-process / effects+3rd-party=plugin / audio DSL⊇pitch / egress）は**不変**。だが #299 のロードマップ框（土台2本・OrbitStudio 先・2.0.0 parity on scsynth）が **SUPERSEDED** となったため engine-first に訂正。

- **振り子の収束（advisor 整理）**: 「OrbitStudio 2.0.0 parity 先決」を「scsynth を Studio に同梱」と誤読（2.0.0 の*体験*と*実装 scsynth* を混同）したのが原因で engine-first ⇄ OrbitStudio-first を往復した。**確定 = engine-first**（master plan 本来の方針）。
- **緊張を解く鍵**: `ORBITSCORE_ENGINE=rust` opt-in が既にある（S2）→ native を opt-in の裏で育て **今の .vsix で dog-food**（scsynth 同梱なし・throwaway ゼロ）→ cutover #108 → OrbitStudio が native を載せる。「使える」と「無駄ゼロ」が両立。
- **確定ロードマップ**: ① native を opt-in 裏で育てる（第1増分 = pan/slice/per-slice gain + α recovery floor #300）→ time-stretch/LinkAudio/γ sandbox/δ 3rd-party → cutover #108 → ② OrbitStudio(VSCodium) on native（scsynth 載せない・CLI+Claude 拡張必須・#301）→ ③ β audio DSL⊇pitch / audio 機能は後。engine の Studio 向け範囲 = サンプラー(in-process)+plugin host(effects)・scsynth 同等ではない。
- **更新ファイル**: POST_2.0_ENGINE_AND_DISTRIBUTION.md（§2.5 / §7 / status banner）, POST_2.0_MASTER_PLAN.html（banner / spine / §3 / Track A 表 / Track B / §9）。
- **関連 issue 再整理**: #301（OrbitStudio）= native の上・cutover 後・最初の /goal でない / #300（α）= engine 第1増分の構成要素 / #302（本訂正）。
- **最初の `/goal`** = engine 第1増分（pan/slice/per-slice gain + α recovery floor）。owner が /goal セット済。

**Commit**: dd5412b（PR #302）

### 6.150 docs(post-2.0): record engine architecture decision — in-process instruments + sandboxed plugins + audio egress (#298) (Jun 21, 2026)

**Date**: 2026-06-21
**Status**: ✅ docs/spec のみ（コア実装なし）。HTML タグバランス検証済
**Branch**: `298-post2.0-engine-arch-decision`（PR 予定・docs-only レビュー）

post-2.0 engine track（A0+S1+S1b #294 / S2 #297 MERGED）後の**次フェーズ設計を owner と確定**し、`POST_2.0_MASTER_PLAN.html` / `POST_2.0_ENGINE_AND_DISTRIBUTION.md §2` の確定決定を再訪して接地し直した。決定は owner 主導 + advisor 2回 + CLAP 一次情報（context7 `/free-audio/clap`）で検証。

- **決定軸 = 「DSL 表現力の着地点に flatten 境界を作らない」**。§2 の結論「楽器系 DSP は engine 内」は**維持**するが、*根拠*を「MIDI 駆動 hosted plugin では表現が落ちる」→「楽器は DSL 表現力の着地点だから flatten 境界を経由させない」に**置換**（ホスト対象は CLAP≠MIDI 1.0 で旧根拠は崩れた）。
- **配置**: 楽器（サンプラー/audio DSL）= **in-process（crown jewel・非交渉）** / effects + 3rd-party = **out-of-process sandboxed plugin**。判定 = DSL が per-note/per-slice 制御を要する→楽器側 / 純 audio→audio→plugin 側。
- **protocol ≠ placement**: 「MIDI を経由しない」はプロトコル（CLAP リッチイベント / `com.orbitscore.*` 超集合拡張）の話で in/out いずれでも可。in-process の真の利点は「表現力が自由に進化 + 税ゼロ」。
- **audio DSL ⊇ pitch DSL**（DSL 設計制約）: pitch モデル(C1)を audio DSL の真部分集合として設計。pitched synth は MIDI/MIDI2.0 で足りる（超集合投資はサンプラーが正当化）。
- **fault 3層**: ①app が daemon 死を生存（recovery floor）②daemon が 3rd-party crash を生存（out-of-process sandbox・未構築）③1st-party in-process crash は①でのみ捕捉。
- **egress（楽器でなく音を出す）**: (A)楽器 egress=standalone 出荷は劣化（別製品）/ (B)音 egress 無劣化 = **b1 薄い bridge プラグイン + standalone エンジン（主案・transport は free-running/follower/leader は standalone 専用）** / b2 engine 埋め込み（後付け）/ LinkAudio は非DAW 補助。制約: engine を clean に埋め込み可能に保つ。
- **ロードマップ（owner 再優先順位化・同セッション後半）= 土台2本 → 改良層**: 土台 = **① VSCodium化（OrbitStudio・2.0.0 parity が先決・最初の /goal = issue #301）+ ② ネイティブ音声エンジン（α #300 → γ sandbox → δ 3rd-party → cutover・①と並行可）**。改良層（土台の後・集中して）= **β audio DSL⊇pitch（+#213）/ audio 機能（slice/stretch）**。master plan の「Track B は engine の後（A1–A2 後）」を撤回し VSCodium を土台前倒し。β は改良層へ後置。旧 advisor 枠組み（"大転換"/"note 毎 IPC tax"）は overstated として棄却。
- **更新ファイル**: `POST_2.0_ENGINE_AND_DISTRIBUTION.md`（§2 全面書き換え + §6 に「2.0.x patch は v2.0.0 タグから分岐」+ §7/§8 をシーケンス/caveat 更新）、`POST_2.0_MASTER_PLAN.html`（Start-here バナー + 依存スパイン + §3 最初の1手 + Track A 表 + §6/§9/§10）。
- **持ち越し to-do 消化**: 「2.0.x patch は v2.0.0 タグから分岐」を §6 に明記。
- **最初の `/goal`（α か β）は別 issue で起草**（本 issue は docs/spec のみ）。

**Commit**: 494b1a7（PR #298）

### 6.149 feat(engine): S2 — daemon dispatch seam parity proof (SC stays default) (#296) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ TS 1144 pass / cargo test --workspace 全緑 / 実機 timing verdict = PASS
**Branch**: `296-daemon-dispatch-seam-parity`（PR 予定）

post-2.0 **S2**（master plan §4-A）。TS interpreter の音声ディスパッチを SuperCollider `OSCClient` seam から **Rust daemon（orbit-audio-daemon WebSocket）駆動**へ差し替え可能にし、timing parity を実証。**SC は出荷既定のまま**、Rust は `ORBITSCORE_ENGINE=rust` で opt-in（master plan §6 .vsix feature-freeze）。

- **スコープ確定（advisor×2 + ユーザー確認）**: posture = **parity proof（SC default 維持）**。#108「デフォルトを Rust に（cutover）」は後続フェーズへ defer（pan/slice/LinkAudio/time-stretch を欠く engine に出荷既定を移すのは時期尚早）。pan は S2 から defer（ファンダメンタル vs 機能詰め込みの分離）。
- **seam（Opus 判断・確定）= バックエンドレベル**: `AudioEngineBackend`（`Scheduler` + AudioEngine 面）を新設し、`SuperColliderPlayer` と新規 `RustEnginePlayer` が**ともに**満たす。`InterpreterState.audioEngine` を具象型→interface 化、`createAudioEngine()` が env で分岐。**既存 SC 経路は無改変**（1129 既存テスト無傷）。
- **lean daemon scheduler**: SC EventScheduler は LinkAudio/bufnum/`/s_new` 結合が重いため再利用せず、独立の最小スケジューラ（1ms poll を mirror）を新設。
- **timing モデル = poll-and-fire-now + 定数 lookahead**: SC=fire-now / daemon=schedule-ahead（自前 transport clock）を、poll 発火時に `playAt(daemonNowSec + lookahead)` で繋ぐ。clock anchor は StreamStats(1Hz) の transport now_sec で継続補正。
- **実機 timing verdict（ground-truth = observer 接続の StreamStats）**: lead `time_sec − trueNow` ≈ **min 38–48ms / max 48–58ms（全て正 → onset clip しない）**、anchor drift max ≈ **3–12ms**、inter-onset 誤差 max ≈ **2–7ms（相対 timing 保存）**、xruns **0**、transport rate ≈ **1.00**（複数 run の幅・gated は境界 assert）。→ load-bearing unknown を retire。
- **polymeter 実証**: 同 gated spec で seqA=400ms / seqB=300ms（3:4）を同時走行 → 各 inter-onset 誤差 ≤7ms・xruns 0 で**独立に保存**（parity を by-construction でなく demonstrated に）。境界: `.orbs` の full interpreter end-to-end は未実施（DSL→Sequence の周期計算は不変 TS 層・MIDI↔audio 同期は startTime/TransportClock 無改変で by-construction 維持）。
- **feature gap は boundary で明示**（見かけの parity を作らない）: pan≠0 → 1回 warn + 中央定位 / slice → 1回 warn + skip / outputChannel(LinkAudio) → 1回 warn + hardware fallback / master effects → 1回 warn + no-op。内部 `ScheduledPlay` は pan を保持（param-complete）。
- **テスト**: 新規 unit 22件（MockDaemonServer）+ gated 実機 spec 2件（timing / polymeter・`ORBIT_REAL_DAEMON=1`）。cargo test --workspace 全緑（core 14 / daemon protocol 13 + smoke 1 / native 16 / clap-spike 7）。
- **観測 hook**: `RustEnginePlayer` に `onDispatch`（telemetry / timing 計測・送信前に wallMs/daemonNowSec を coherent 採取）を追加。
- **PR レビュー（/simplify + /code:pr-review-team）反映**: getStatus 失敗の空 catch に warn 追加 / daemon 切断時は poll を停止し単一通知（console.error flood 回避・teardown race は isRunning ガードで抑制）/ master effects の silent no-op を warn 化 / ロード中 clear の再チェック追加。
- **A0 doc §14 に S2 verdict を記録**。DSL/MIDI 意味論は無改変（core spec 変更不要）。

### 6.148 review(spike): @claude bot second-opinion 対応 + PR レビュー規則を CLAUDE.md 化 (#294) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ #3 fix + S2/A4 carry-forward 記録 / build+test 緑 / 再レビュー不要（advisor 判断）
**Branch**: `293-clap-hosting-a0-s1`（PR #294）

internal pr-review-team（4観点×複数周）+ /simplify 通過後、**advisor に相談 → `@claude` bot に RT/clack correctness を scoped second-opinion 依頼**。bot が **internal が拾わなかった CLAP-spec-subtle な Important 3件**を検出（Critical 0）。いずれも spike の PASS verdict に無影響（テストシンセが当該パスを踏まない）:
- **#1 teardown スレッド**: `drop(stream)` で `stop_processing()` が main thread から呼ばれる（CLAP は audio thread 要求）→ S2 で `deactivate_and_stop_stream()` パターン。
- **#2 `request_callback` の `mpsc::send`**（alloc+lock）: プラグインが `process()` から呼ぶと RT 違反 → S2 で lock-free 通知。
- **#3 `EventBuffer` realloc 不変条件**: spike に `debug_assert!(len <= 1024)` regression guard 追加（**唯一の即時 fix**）。
- **advisor 判断**: S2 は daemon 統合の fresh 実装でこの spike binary のコピーではない → #1/#2 は spike を patch せず **A0 §13 に S2/A4 carry-forward として記録**（正しいパターンを残し S2 が一度で正しく作る）。**再レビュー不要**（debug_assert + doc 記録は docs-only 例外）。
- **CLAUDE.md（project + user）に PR レビューワークフロー規則を追記**: コード変更時は `/simplify` → `/code:pr-review-team`（Critical/Important=0 まで反復）を **MUST USE SLASH COMMAND**、通過後 advisor 相談 → bot review、docs のみは advisor とレビュー方法相談。
- **discontinued な `/code:autopilot` セクションを project CLAUDE.md から削除**（hook bypass の precedent は PR レビュー規則の「理由」に salvage）。

### 6.147 refactor(spike): /simplify 指摘を適用（behavior-preserving cleanup） (#294) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ build clean / unit test 7 pass / static+hot 実走回帰なし
**Branch**: `293-clap-hosting-a0-s1`（PR #294）

`/simplify`（reuse / simplification / efficiency / altitude の 4 cleanup エージェント並列・Skill tool 経由）の指摘を Phase 2 で適用:
- **A** `discovery.rs`: bundle ロードの unsafe FFI を `open_bundle()` に抽出（2関数の重複解消・unsafe 集約）。
- **D** `sink.rs::CountingSink::commit`: peak を per-sample `fetch_max`（2048回/callback）→ local fold して 1 atomic。
- **G** `audio.rs`: hot-install path を `self.install(msg)` に統一（install ロジックの重複解消）。
- **I** `buffers.rs`: channel count を既存 `total_channel_count()` 利用（dead_code 解消）。
- **J** `host.rs`: 未読の dead state（`PluginCallbacks` / `OnceLock`）削除・`initializing` を trait default に。
- **K** `audio.rs`: 未読の dead field `sink_frames` 削除（per-callback fetch_add も除去）。
- **L** `main.rs`: pump の `else` を共通後続に hoist。
- **H** `PostMixSink::commit` の「format は構築時固定」設計意図を doc 化（A4 向け）。**M** テスト名を sample 数に整合。
- **skip（理由付き）**: config fallback 統合（input/output の asymmetry が意図的）/ parse_args helper（clap 依存回避が意図的・borrow 複雑化）/ muxed 2パス（altitude が mux 構造を妥当と確認・RT 検証済）。
- RT hot path（`audio.rs::process`）はクリーンと 4 エージェントが確認。全変更 behavior-preserving。

### 6.146 fix(spike): pr-review-team 指摘対応（Critical 1 + Important 6） (#294) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ Critical/Important = 0 / unit test 7 追加 pass / 実走回帰なし
**Branch**: `293-clap-hosting-a0-s1`（PR #294）

`/code:pr-review-team`（code-reviewer / silent-failure-hunter / pr-test-analyzer / comment-analyzer 並列）の指摘を一括修正。**RT hot path の実バグは無し**（latent alloc は Fixed buffer / port rescan 非対応 / 低イベント率で防御済）:
- **Critical**: `hist_us` フィールド doc が stale（1µs/63µs → 50µs/51.2ms に修正・S2 監視の根拠数値）。
- **Important**: ① `plugin.process` のエラーを `process_error_count` で可視化 ② `event_scratch` 容量を event ring（1024）に合わせ comment を正直化 ③ driver thread panic を fatal 化（無効計測を握り潰さない）④ パース不能な plugin id を log（誤解を招く "No plugins found" 回避）⑤ `p99_ns()` 境界 unit test 4 件 ⑥ `ensure_buffer_size_matches` の RT eprintln を `cfg(debug_assertions)` gate。
- **Minor**: `buffers.rs` doc メソッド名 / config fallback log + is_input 型修正 / `_=>{}` 防御 fill / pump Disconnected log / request_callback コメント / hot-install≥measure 警告 / installed_at off-by-one コメント。
- **追加 unit test**: p99 境界 4 / CountingSink abs-peak + RingTapSink drop / add_to_cpal_buffer の ADD-mix 不変条件（A4 差し替え点）= 計 7 件 pass。
- security: secrets なし・`unsafe` は plugin loading の inherent・network/auth なし・全 deps permissive。

### 6.145 feat(spike): S1b — 低レイテンシ + release + dynamic hot-install を実証 (#295) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ S1b 完了（3 caveat retire）/ 既存テスト緑
**Branch**: `293-clap-hosting-a0-s1`（PR #294 に追加）
**Issue**: #295（Epic #292）

S1（PR #294）が retire していなかった3項目を `orbit-clap-spike` に CLI を足して実証:
- **S1b-1 低レイテンシ + release**: `--buffer-frames` 追加。128/256 フレーム（2.9/5.8ms budget）で xrun 0・resize 0・発音。**release + 128 frame で callback max 10.8µs（budget の 0.37%）**。小バッファほど相対余裕が大きい。
- **S1b-2 dynamic hot-install**: `--hot-install-after-secs` 追加。engine-only で stream 開始→稼働中に主スレッドで `activate`+buffers→`StartedPluginAudioProcessor`(Send) を **wait-free rtrb ring で audio thread に move→callback が一度 pop して install**（A0 §8 の所有権ハンドオフ）。install at callback #862(256f)/#1722(128f)=期待値、**move は alloc/lock なし・install callback で時間スパイク無し（max 45–49µs）**・install 後に発音。static 経路も回帰なし。
- **実装**: `OrbitAudioProcessor` の plugin/buffers を `Option` 化し static/hot を統一。`InstallMsg` は全 Send。
- A0 doc §13 に結果記録・§12 caveat を retire 更新。**残る未実証**: ノードグラフ / OutputEvents / sample-accurate offset / F32 のみ / hot-uninstall。

### 6.144 feat(spike): S1 — CLAP hosting を orbit-audio cpal callback に RT 統合（verdict=PASS） (#293) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ S1 verdict = **PASS（feasibility→proof）** / 既存テスト緑（Rust lib 16 + TS 1129）
**Branch**: `293-clap-hosting-a0-s1`
**Issue**: #293（Epic #292）

post-2.0 クリティカルパス先頭 S1 を実走し RT 安全性の verdict を確定。A0 §4 のアーキ（同一 cpal callback / プラグイン Mutex 外 / rtrb event seam / PostMixSink tap / static-load）を実装。
- **実装**: `rust/crates/orbit-clap-spike`（host・ワークスペース member・`publish=false`）= clack 公式 cpal example を headless 移植 + orbit-audio `Engine` 合算 + rtrb note seam + `PostMixSink`(Counting/RingTap) + 計測モード。`rust-spike/clap-test-synth`（独立 crate・自作 CLAP synth・良性/`CLAP_TEST_SYNTH_MISBEHAVE=1` で 4MB alloc+50ms lock の故意違反）。clack を `f874e85` git pin。
- **委譲（§7）**: synth と host 実装を Sonnet subagent 2 本に並列委譲（A0 §4 = 固定 interface）。**実走・計測・verdict は Opus が実ゲートで実施**（計測バグ 2 件を Opus が修正: p99 ヒスト域 64µs→51ms、発音証明 peak 出力追加）。
- **結果**: good 60s 持続 = **xruns 0 / callback max 509µs（budget 23ms の 2.2%）/ peak 0.25 発音 / resize 0**。misbehave 12s = callback 数 2594→**24 崩壊**・mean **494ms**・max **1.94s** で違反を決定的に検知。→ good の clean は実証検知できる計測上の clean。
- **★重要知見**: macOS CoreAudio + cpal は callback が 2 秒ブロックしても **err_fn xruns が発火しない**（good/bad 両方 0）。→ **xruns 単独は RT 違反検知に使えない**。production 監視は callback duration ベースにする（S2 以降・`StreamStats` に callback-time 分布追加）。A0 §12 に記録。
- **license gate（Opus・§1）**: 新 deps（clack-host/extensions/common/clap-sys/libloading/objc2/rtrb）全 permissive。closure に純 GPL/AGPL 無し（MPL=symphonia 既存・r-efi は MIT/Apache 選択）。
- **Caveat（S1b/S2 へ）**: 1024 フレーム（高レイテンシ）・debug build・static-load のみ・F32 のみ・単一プラグイン。dynamic hot-install / 低レイテンシ厳格テストは未実証。
- Stop&Report 条件（clack breaking / RT 不能 / tap 不成立）いずれも非該当。

### 6.143 chore(docs): WORK_LOG ログローテーション（2026-05 末尾 + 2026-06 前半をアーカイブ） (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ 整合のみ（`PROJECT_RULES.md §1a` 準拠・欠落/重複なし検証済）
**Branch**: `293-clap-hosting-a0-s1`

main WORK_LOG が 140K（100KB 閾値超）に肥大したため月別アーカイブを実施:
- **最新 20 セクション（6.123–6.142）を main に保持**、古いものを月別に退避。
- **`docs/archive/WORK_LOG_2026-06.md` 新規**: 6.90–6.122（33 セクション）。
- **`docs/archive/WORK_LOG_2026-05.md` に追記**: 6.87–6.89（May 09–10 分・newest-first で 6.86 の上に挿入）。
- main footer に 2026-06 リンク追加。連続性検証で 6.64–6.142 が全て1回ずつ存在を確認。
- 結果: main 1424 行/140K → **325 行/32K**。

### 6.142 docs(post-2.0): A0 RT 統合設計 + Epic #292 / Issue #293 起票 (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: 🟡 A0 設計完了 / S1 は Rust toolchain 未インストールで実行ブロック（Stop & Report）
**Branch**: `293-clap-hosting-a0-s1`
**Issue**: #293（親 Epic #292）

post-2.0 のクリティカルパス先頭 A0+S1（CLAP hosting）に着手。`POST_2.0_MASTER_PLAN.html` + 探索ノート + research を一次ソースに、既存 `rust/` エンジン（cpal callback / Scheduler / daemon）の実コードを照合して A0 設計 doc を作成。
- **Epic #292**「Post-2.0 Native Engine & OrbitStudio」+ 子 **#293**「A0+S1 CLAP hosting」を起票（B/C 子は投機的なので未作成）。
- **A0 doc** (`docs/development/POST_2.0_A0_RT_INTEGRATION_DESIGN.md`): スパイクの仮説＋kill-criteria として記述（「音が出た」では verdict 不可）。主要決定:
  - process() = **同一 cpal callback**（clack 公式 cpal example が同形）。プラグインは **Mutex 外**所有で silent-drop 回避。
  - イベント seam = **`rtrb`** lock-free SPSC ring。tap = **`PostMixSink` trait**（S1=stub / 実 LinkAudio=A4）。
  - **LinkAudioSink の解釈確定**: goal 文言「tap→`LinkAudioSink::commit`」は Rust LinkAudio が A4（S1 下流）のため成立不能 → S1 は tap 点＋RT-safe sink trait（stub）を証明、実体は A4。
  - ブロックサイズ: cpal `BufferSize::Fixed` 要求 + 事前確保（`activate()` の max_frames 整合）。
  - 受け入れ: ≥60 秒持続で xrun=0 + CPU 時間軸計測 + **故意 RT 違反プラグイン**で計測自体の有効性検証。
- **clack-host 実物検証**（GitHub 一次・2026-06-20）: v0.1.0 / MIT OR Apache-2.0 / deps 全 permissive・GPL なし / edition 2024・**MSRV 1.85.0** / cpal host example 同梱。
- **Stop & Report**: ローカルに `rustc`/`cargo`/`rustup` が無い（`~/.cargo`・homebrew・login shell いずれも不在）。S1 実装には **Rust ≥1.85 のインストールが前提** → ユーザー判断待ち。
- advisor 1 回相談（設計 + 委譲 + ambiguity の扱い）。

### 6.141 docs(post-2.0): post-2.0 マスター計画ドキュメント（HTML）(#289) (Jun 20, 2026)

**Date**: 2026-06-20
**Status**: ✅ ドキュメントのみ（レビュー反映済・HOLD: Epic/実装 Issue は承認後）
**Branch**: `289-post2.0-master-plan`

新規セッションが post-2.0 を実行に移せるよう、探索ノート3本（`POST_2.0_ROADMAP_NOTES` / `..._ENGINE_AND_DISTRIBUTION` / `..._PITCH_MODEL_NOTES`）+ research を一次ソースに統合した `docs/development/POST_2.0_MASTER_PLAN.html`（手書き HTML）を作成。`specs-v2/IMPLEMENTATION_INSTRUCTIONS.html` を範にコールドスタート実行可能な形（Start here → §1 不変条件 → §2 依存スパイン → §3 最初の1手 A0+S1 → §4 3トラック → §5 ゲート/停止条件 → §7 Delegation Profile → §8 運用規則 → §9 Epic 提案 → §10 Open Questions）。
- **確信度勾配を保持**（engine=DECIDED / hosting=FEASIBILITY / pitch=SPEC-FIRST / song=TENTATIVE）。advisor 2 回相談（構成 + Opus/Sonnet 切り分け）。
- **§7 Delegation Profile（Opus/Sonnet）**: 判定ルール1つ（Sonnet=IF 確定＋検証容易 / Opus=seam・判断 or 誤答が検証をすり抜ける）+「**委譲は Opus が実ゲートで検証**」を本セッションの実例（Sonnet 監査 5 件見落とし→bot 6 件目）で裏付け。
- **レビュー反映**: (a) Track A スコープ境界（MIDI/IAC は engine 非依存・接点は `TransportClock` のみ）/ (b) ライセンス節（自コード=コンポーネント別自由 / 依存=permissive が不変条件 / 現状 Source-Available v1.0 維持 / 名称統一は横断 TODO・#ops 共有済）。
- WCTM(#224) とは別トラック・締切なし。

### 6.140 docs(user): VitePress MIDI ピラー6ページを英訳 (#287) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメントのみ（`vitepress build` 緑・dead link 無し）
**Branch**: `287-translate-midi-en`

#237(PR #286) で追加した JA MIDI ピラー6ページに対し、EN スタブ（`sites/user/en/midi/` の「Translation pending」）を**実英訳に置換**。EN サイトの他10ページは翻訳済みで、かつ `en/reference/methods.md` §6 が `/en/midi/` を full documentation として参照していたため、その穴を解消。
- 翻訳6ページ: index / pitch-dsl / mode-scale / voicing / link-audio / quantize（計 902 insertions）。sonnet agent に委譲 → main がレビュー。
- 既存 EN（`en/reference/methods.md` §6・`en/basics/`）の用語・スタイルに整合。**DSL コード構文は不変**、コード内コメントのみ EN 化。frontmatter・`:::` admonition・内部リンク（`/midi/`→`/en/midi/`）・post-2.0 VOLATILE 警告を保持。
- 監査済みの技術事実（gate 0–1 クランプ / `^r`=-1/0/+1 / `.open()`=close→drop2 / `.mode()`+`.root()` 併用不可 / `^N` の degree 7 例）が翻訳でも正しく保持されていることを spot-check で確認。日本語残り0行・stale `/midi/` 絶対リンク無しも検証。

### 6.139 docs(user): bot second-opinion で gate(1.2) の誤記を修正 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメント修正のみ（`vitepress build` 緑）
**Branch**: `237-doc-reconciliation-2.0.0`

PR #286 に @claude bot を docs↔実装の精度スコープで second-opinion レビュー依頼。内部監査（6.138）が見落とした **1 件**を検出・修正:
- **index.md gate 表**: 「`1.2`＝次の音と重なる（レガート寄り）」とあったが、`seq.gate()` は `[0,1]` クランプ（`sequence.ts:487` `Math.max(0, Math.min(1, value))`）で `gate(1.2)` は無言で `1.0` になる。`1.2` 行を削除し、「上限 1.0・オーバーラップは `{ }` レガート」を案内する `::: info` 注記に置換。
- bot は他の全照合項目（メソッドシグネチャ・度数式・`^N`・voicing 演算・comp セル名・quantize 挙動・LinkAudio 制約）+ 6.138 の修正4件を実装一致と独立確認。
- bot の任意プロセ提案（`comp()` のチェーン評価順の注記）は未検証のため見送り（精度パス中に未確認記述を足さない方針）。

### 6.138 docs(user): VitePress ピラーページの正確性監査で 4 mismatch を修正 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメント修正のみ（`vitepress build` 緑・dead link 無し）
**Branch**: `237-doc-reconciliation-2.0.0`

sub-agent が 6.136 で書いた VitePress 6 ページをエンジン実装と突き合わせる正確性監査（sonnet agent + main の二重チェック）を実施し、**4 件の乖離を修正**:
1. **pitch-dsl.md `^N`**: degree 8 の構造的 +1 オクターブを見落とし、sticky シフト例の音名が 1 オクターブ誤り（`8=C5`→実際 C6、`8^0=C4`→実際 C5）。構造的オクターブの罠を避けるため例を degree 7／degree 1 に書き換え（`sequence.ts:917-927` + `degree-resolution.ts:96-102` で裏取り）。
2. **mode-scale.md**: 例が `.mode(dorian).root(2)` を使用していたが、`.mode()` と `.root()` は同一グループに併用不可（`resolveScopeToContext` で相互排他・`seq.mode()` 既定も無い）。「グループごとのモード切替」と「`.root()` 単独のルート移動」の 2 例に分割。
3. **voicing.md `^r`**: 実装は `Math.floor(random*3)-1`＝`{-1,0,+1}` 一様（約 1/3 で移動なし）だが「±1 oct 上 or 下に移動」と記載 → 「-1/0/+1（0=移動なし）」に訂正。
4. **voicing.md `.open()`**: 実装は close→上から 2 番目の声部を 1 oct 下げる（Drop 2、`resolve-chords.ts:314-318`）だが「オープンポジション」のみ → 正確な定義に。
- 残り 30+ クレーム（drop/invert/shell/rootless/voicelead/comp/cell/density/quantize/linkAudio 等）は実装と一致を確認（mismatch 無し）。「ビルド成功 + リンク解決」は正確性の代理指標にすぎず、挙動クレームの実装照合が本質という advisor 指摘に基づく監査。

### 6.137 docs(user): reconcile README.md + 拡張 README を 2.0.0 へ整合 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 整合のみ（コード変更なし・テスト 1129 緑）
**Branch**: `237-doc-reconciliation-2.0.0`

ルート `README.md` が 2.0.0 と正面衝突する drift を解消（spec より drift が深かった）:
- MIDI を「Migration Notice（MIDI→audio 移行中）」「Legacy MIDI-Based (Deprecated)」「CoreMIDI/IAC Bus = not implemented」の **3 か所で死んだ機能扱い** → 2.0.0 の現役ピラーへ訂正。
- ヘッダを audio+MIDI 両出力に。Core Features に「🎹 MIDI & Pitch (2.0.0)」節追加（MIDI output / Pitch DSL / comp / LinkAudio / quantize）。「DAW Integration: VST/AU (planned)」→ LinkAudio 実装済に。
- Current Implementation Status を「2.0.0 is released」+ ピラー一覧に。歴史的詳細（audio phases / ICMC v1.1.0 / Phase 6-7 achievements / legacy MIDI phases）は `<details> Development history` へ退避。
- Technology Stack に MIDI(CoreMIDI/IAC)・Ableton Link を追加し「not implemented」行を削除。USER_MANUAL を canonical→**deprecated**（学習サイトを正規リンクに）。テスト数を「1129 passed, 23 skipped (1152) — 2.0.0」に更新。`v3.0`/`2.0.0-dev` の version label を一掃。
- `packages/vscode-extension/README.md`（.vsix の顔・最終更新 5/6 で 2.0.0 ピラー記載 0）: 「New in 2.0.0」節（5 ピラー）追加、`v1.x`→`2.0.0`、User Learning Site リンク追加。
- ライセンス節・examples 音楽内容は不変。#138 cold-install は実状況不明のため `⏳ Pending` 保持。

### 6.136 docs(user): VitePress user site に 2.0.0 ピラーページ追加 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ ドキュメントのみ（`vitepress build` 成功・dead link 無し）
**Branch**: `237-doc-reconciliation-2.0.0`

`sites/user/` に 2.0.0 の 5 ピラー解説を追加（JA 6 ページ + EN 6 スタブ）:
- `midi/` (JA): index（MIDI 出力・IAC 準備・`seq.midi/octave/vel/gate`・`global.key/midiLatency`）/ pitch-dsl（度数・変音記号・`^N` スティッキー・`[ ]` コード・`*n`・パターン/セクション変数・`{ }` レガート・`_` タイ・`@v`/`@g`）/ mode-scale（`mode()` ラティス・グループ適用・`.root()` スコープ）/ voicing（drop/invert/open/close/shell/rootless・ランダム・`.voicelead()`・`.comp()`/`.cell()`/`.density()`）/ link-audio（`linkAudio()`・`output()`・テンポリーダー・MIDI 共存）/ quantize（`global/seq.quantize()`・RUN は常に即時）。
- EN は `en/midi/` に「翻訳保留・JA 参照」スタブ 6 件。
- `reference/methods.md`（JA/EN）に §6 MIDI 出力を追加。`sidebar.ts` に「MIDI とピッチ表現（v2.0.0）」節（JA/EN）追加、「困ったときは / Help」を 15/16 に繰り下げ。
- root/key/scale 関連ページに「post-2.0 で見直し予定」警告ブロック。session-log は opt-in（dormant）の一行注記のみ。

### 6.135 docs(user): deprecate USER_MANUAL ja/en → VitePress (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ deprecate バナーのみ（本体は履歴保持）
**Branch**: `237-doc-reconciliation-2.0.0`

`docs/user/ja|en/USER_MANUAL.md` は完全に pre-2.0（audio-only・新ピラー 0・en は `brew install supercollider` のまま）。先頭に **DEPRECATED バナー**を追加し VitePress user site（`sites/user/`）へ誘導。本体は履歴として保持（削除しない）。

### 6.134 docs(spec): SoT spec を 2.0.0 実態へ整合 (#237) (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 整合のみ（コード変更なし）
**Branch**: `237-doc-reconciliation-2.0.0`

post-2.0 の前提として、3観点ドリフト監査（Pitch DSL / core+LinkAudio+session-log / version+status）の結果を `docs/core/INSTRUCTION_ORBITSCORE_DSL.md` に反映（75+/34-）:
- **version**: ヘッダを「OrbitScore 2.0.0 — DSL Specification」+ `ENGINE_VERSION 2.0.0 / DSL_VERSION 1.1` 明記。
- **§12/§13**: Completed に quantize・session-log(dormant) 追加 / Not-Yet に slice(#239)・audio `[ ]` stack(#238) 追加 / 「Deferred: @v expression」は stale 削除（E5 実装済）/ テスト数を脱ハードコード。
- **構造**: 重複していた `## 8.` を解消し §9–§13 へ renumber（cross-ref も更新）。P.11/P.12 の番号順を修正。
- **core §1–§8**: §7 underscore methods を「2.0.0 未実装」明記 / §1 singleton（変数名でreuse）/ §2 key()=実装済・tick()=未 / §6 formats に aif・flac 追加・48k/24bit ハードコード削除 / §5 `global.start()` は即時 / §8.1.2 MIDI 除外(#282) + warn 毎回 / §8.1.3 fallback warn は再生時 / §8.1.4 **Live→OrbitScore tempo は未実装**（leader-push のみ #283）。
- **VOLATILE（post-2.0 redesign pending）**: P.1/P.5 root/key/scale に注記 + `POST_2.0_PITCH_MODEL_NOTES.md` ポインタ。P.5 の `seq.root(C)` 誤例を `seq.root(1)`+「seq は数値のみ・#280」へ。`seq.mode()` は group のみと訂正。P.4 mode period=highest element、`.r`=per-slot を明記。

### 6.133 chore: @claude bot レビューの low 指摘対応 + 初回ノート遅延を #285 で追跡 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

PR #281 の `@claude` bot レビュー（結論「マージブロッカー無し・round-1/2 fix を追認」）の非ブロッカー指摘に対応:
- `packages/engine/supercollider/setup.scd`: 末尾改行追加（cosmetic・複数回指摘）
- `scripts/qa-midi-smoke.sh`: `perl -e "sleep ${DWELL}"` → `perl -e 'sleep $ARGV[0]' -- "${DWELL}"`（env 値が perl コードとして展開されるのを回避）
- **[Medium] 初回ノート最大2秒ブロック**（plugin-present の lazy probe・`timeoutMs=2000`）は **#285 で post-release 追跡**（2.0.0 ブロッカーではない。plugin-absent は boot 配線済みで回避済み）。

### 6.132 chore(deps): npm audit fix — resolve shipped `ws` (high) before 2.0.0 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

2.0.0 リリース前の dependabot 対応。**.vsix に出荷される production 依存**を切り分けて非破壊修正:
- `npm audit fix`（semver 互換のみ・`package-lock.json` のみ変更）で production の **`ws`(high: memory disclosure / DoS)** 等を解消。
- 修正後の production audit: **6 moderate のみ**（すべて supercolliderjs(alpha) の transitive。非破壊では直せず upstream 待ち。攻撃面は localhost scsynth 接続のみで実リスク低）。**出荷物の high/critical は 0**。
- 残る critical 1 / high は **devDependency（vitest/eslint/build 等・.vsix 非同梱）**。`--force`（破壊的）を要しリリース toolchain を不安定化させ得るため post-release / dependabot PR で追跡（2.0.0 はブロックしない）。

### 6.131 release(2.0.0): drop -dev, finalize 2.0.0 — last feature .vsix (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped / simplify + pr-review-team(Critical=0/Important=0) + security PASS
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

`2.0.0-dev` → `2.0.0` に確定。v1.1.1 以降の新ピラー（MIDI 出力 / Pitch DSL / comp / session-log / LinkAudio）を束ねた**最後の機能 .vsix リリース**（post-2.0 は専用アプリ OrbitStudio へ移行。`docs/development/POST_2.0_ROADMAP_NOTES.md`）:
- `packages/engine/src/version.ts`: `ENGINE_VERSION` `2.0.0-dev` → `2.0.0`
- `packages/vscode-extension/package.json`: version `2.0.0-dev` → `2.0.0`（= .vsix 版）
- 配布は **GitHub Release のみ**（marketplace は後日・#197 PAT 未登録）。merge 後に tag + Release。
- session-log は dormant（既定 off・#229 redesign は post-2.0）/ #280（`seq.root(note-name)`）は known issue（post-2.0 の root 後置一本化で解消予定）。
- 残 QA（実音 H 項目・学習サイト walkthrough）は OrbitStudio へ defer（Epic #278 disposition）。

### 6.130 fix(link-audio): pr-review-team round 2 — clear in-flight probe map on stopAll + log best-effort catches (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1129 passed | 23 skipped
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

round-2 再レビュー（code-reviewer + silent-failure-hunter）で round-1 の Critical/Important が全解消と確認。round-1 の並行ガード fix が導入した新規 Important 1 件 + minor を修正:
- **Important**: `stopAll()` で `resolvingChannel`（in-flight probe memo）が未クリア → stop-then-play の狭いレースで stale 結果共有 → `this.resolvingChannel.clear()` 追加。
- minor: `stopAll()` で `warnedAboutMissingPlugin=false` リセット（次セッションで plugin 不在 warn 復活）/ `setLinkTempo` の空 catch → warn（global.ts の round-1 fix がこの層で握り潰されていた）/ `ensureLinkAudioChannelRegistered` の空 catch → warn（防御的）。

→ pr-review-team は **Critical=0 / Important=0** に収束（round 1 fix → round 2 verify → round 2 新規 Important を本コミットで修正）。

### 6.129 test(link-audio): pr-review-team round 1 — close test-coverage gaps (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 1129 passed | 23 skipped（+18 tests・regression 0）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

pr-test-analyzer の Critical/Important カバレッジギャップを補完:
- TA1 `OSCClient.registerLinkAudioChannel`: /done→true / timeout→false / transport error→rethrow（`tests/audio/osc-client-register.spec.ts`）
- TA2 `loadLinkAudioSynthDef`: file 不在→false/送信0 / 両在→`/d_recv` 2回順序 / keepalive 欠如→1回+warn（`tests/audio/synthdef-loader.spec.ts`）
- TA3 session-log gate: `shouldEnableSessionLog()` を `cli/session-log-gate.ts` に抽出（play/repl から使用・挙動不変）+ 全分岐 test（`tests/cli/session-log-gate.spec.ts`）
- TA4 `output()→registerLinkAudioChannel` 配線（`sequence-output.spec.ts` の mock + assert）
- TA5 `resolveLinkAudioChannel` が transport error で throw せず hardware fallback（`link-audio-dispatch.spec.ts`）
- TA6 `boot()` が load 失敗時に `setLinkAudioPluginAvailable(false)` + warn（`supercollider-player-boot.spec.ts`）

### 6.128 fix(link-audio): pr-review-team round 1 — correctness/robustness fixes (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1111 tests passed / C++ cmake compile 検証済
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

`/code:pr-review-team`（code-reviewer/silent-failure-hunter/pr-test-analyzer/comment-analyzer）の Critical/Important を修正（テスト追加は別コミット）:
- **Critical**: `orbit_link_audio_out.cpp` の `g_beatAnchorSet`/`g_anchorBufCounter`/`g_anchorMicros` を `PluginLoad` でリセット（scsynth プロセス内再起動時の符号付きアンダーフロー → beat 破綻を防止）。
- **Important**:
  - `event-scheduler.stopAll()`: `linkAudioPluginAvailable=null` リセット（次セッション再 probe）。
  - `supercollider-player.boot()`: `loadLinkAudioSynthDef()` 戻り値を `setLinkAudioPluginAvailable(false)` に配線（plugin 不在時の 2000ms lazy timeout 解消）。
  - `event-scheduler.resolveLinkAudioChannel()`: per-channel 並行ガード（in-flight memo）+ 2本目以降の登録 boolean 捕捉（timeout は warn + fallback）。
  - `osc-client.registerLinkAudioChannel()`: catch を timeout（`false` latch）と transport error（rethrow → `null` 維持で再 probe）に分離。
  - `synthdef-loader`: keepalive `.scsyndef` 欠如時の warn。
  - `event-scheduler.stopAll()`: `void freeNode` → `.catch`+warn。
  - `global.pushLinkTempoIfLeading`: 空 `.catch(()=>{})` → warn。
  - stale コメント（"boot pipeline が flip" 系）を実態（null=未 probe / boot は load-fail 時のみ false / lazy probe が true）に修正。

### 6.127 refactor(engine): /simplify pass の挙動不変クリーンアップを適用 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / 1111 tests passed
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

2.0.0 finalize 前の `/simplify`（4 agent: reuse/simplification/efficiency/altitude）の**挙動不変な品質 fix のみ**を適用:
- `diagnostics-analysis.ts`: `.output()` と `.midi()` の重複スキャン2パスを**単一パス**に統合（keystroke ごとの hot-path コスト削減・分類結果は不変）。3 agent 一致指摘。
- `synthdef-loader.ts`: 4箇所の inline `setTimeout` を private `sleep(ms)` に抽出（delay 値据え置き）。

**skip（simplify スコープ外＝挙動変更/correctness → pr-review-team へ回送）**:
- altitude #1: `g_beatAnchorSet`(C++) が scsynth 再起動で未リセット → 負オフセットの恐れ。
- altitude #2: `stopAll()` で `linkAudioPluginAvailable` 未クリア（セッション跨ぎの stale state）。
- altitude #4: boot の `loadLinkAudioSynthDef()` 戻り値未配線 → plugin 不在時に初回 dispatch で 2000ms timeout。
- C: event-scheduler の冗長 `has()` ガード（agent 間で見解割れ・リスク回避で保留）。
- D: `removeEffect` の `/n_free` 直送 → 新 `freeNode()` 置換（diff 外の既存行のため保留）。

### 6.126 docs(post-2.0): engine/pitch/song/distribution 方向 + Rust hosting research を記録 (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ 記録のみ（実装なし・探索段階/未確定・post-2.0）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**内容**: 2.0.0 以降の方向性を大和さんと議論し durable 化（WCTM とは別トラック）。
- `docs/development/POST_2.0_ROADMAP_NOTES.md` — engine-first / 全体方向 / features deferred / session-log redesign 北極星。
- `docs/development/POST_2.0_PITCH_MODEL_NOTES.md` — root/key/scale + song(arrange) 層の再設計（root=後置一本化〔絶対=音名/相対=大文字ローマ〕, key=2軸カスケード頂点, conductor 等）。
- `docs/development/POST_2.0_ENGINE_AND_DISTRIBUTION.md` — engine=Rust(既存 `rust/`) 方向 / 薄いホスト+DSPプラグイン / Fair Trade 内部基盤 / freemium⟺permissive / 層構造 monetization / Steam+notarize 配布 / OrbitScore=言語・OrbitStudio=アプリ。
- `docs/research/NATIVE_ENGINE_TRACKTION_VSCODIUM.md`（結論は ENGINE_AND_DISTRIBUTION が更新）/ `docs/research/RUST_PLUGIN_HOSTING.md` — Rust 3rd-party ホスティング feasibility（CLAP>AU>VST3・VST3 は SDK 3.8 で MIT 単独化・engine=Rust 確定方向、残る証明は CLAP 統合スパイク+RT 統合設計）。

### 6.125 fix(session-log): make .orbslog dormant (opt-in) for 2.0.0 finalize (Jun 19, 2026)

**Date**: 2026-06-19
**Status**: ✅ build 緑 / session-log ユニット 26 件緑
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**背景**: 6/18 ライブで `.orbslog` が生成されない / LinkAudio 送出トラックが記録されない不具合。原因は現行が **file-scoped**（`<basename>.<stamp>.orbslog`）で、複数ファイルをまたぐ1セッションに合わない**設計ミスマッチ**。finalize 中にパッチせず dormant 化し、redesign（session-scoped・全トラック捕捉・L2 replay #241/分析 #242 対応）は post-2.0 へ（`POST_2.0_ROADMAP_NOTES.md`）。

**変更**:
- `cli/play-mode.ts` / `cli/repl-mode.ts` の `enableSessionLog()` を **`ORBITSCORE_SESSION_LOG=1` の opt-in 裏に退避**（既定 off・既存 `ORBITSCORE_DEBUG` と prefix 整合）。
- writer (`core/session-log/`) / API / 26 ユニットは**保持**（resurrect 可）。

### 6.124 feat(link-audio): OrbitScore を Link テンポリーダーに (#283) (Jun 18, 2026)

**Date**: 2026-06-18
**Status**: ✅ 実装・テスト済（実機受け入れは大和さん: `global.tempo(72)` eval → Ableton BPM 追従を目視）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**要望（大和）**: `global.tempo()` を設定すると Ableton が追従してほしい = OrbitScore を Link テンポリーダーに。

**設計（advisor 承認・「軽い方の道」）**: plugin が tempo を push する → `global.tempo == Link tempo`
が構造的に保証 → MIDI(global.tempo 自走) と Audio(Link beat) が**自動で揃う**。scheduler を
Link beat 駆動に作り変える必要がない（その逆方向 follower 強化の方が重い）。

**実装**:
- C++ `ChannelRegistry::setLinkTempo(bpm)`: app スレッドの `captureAppSessionState()` →
  `setTempo(bpm, clock().micros())` → `commitAppSessionState()`。audio スレッドの
  `captureAudioSessionState` と並行安全（Link の app/audio session-state 分離の正規用法）。
- C++ `/cmd /orbit/setLinkTempo <bpm>` ハンドラ（同期・/done 不要、bpm を 20..999 で検証、
  `getf` が int/float 両対応）。PluginLoad で登録。
- engine: `OSCClient.setLinkTempo` → `EventScheduler.setLinkTempo` → `SuperColliderPlayer.setLinkTempo`、
  `AudioEngine.setLinkTempo?`、`Global.pushLinkTempoIfLeading()` を tempo()/linkAudio()/start() から呼ぶ
  （ファイル順 tempo→linkAudio を吸収するため3点）。

**制約（重要・本番ルール）**: Link は last-setter-wins。OrbitScore が唯一のテンポ設定者である間だけ
MIDI/Audio が揃う。**Live 側でテンポを動かすと Link tempo が global.tempo と乖離し MIDI がドリフト**
（scheduler は Link に追従しない）。本番は「テンポは OrbitScore のコードで設定、Live のテンポは触らない」。

**検証**: unit（global.tempo→setLinkTempo 送信 / linkAudio off は非送信 / ファイル順吸収 /
start 再アサート / 任意能力欠如で throw なし、EventScheduler 委譲）。全 1111 passed（+7）。
.scx に `/orbit/setLinkTempo` シンボル + vsix 同梱を確認。**実機受け入れ（Ableton BPM 追従の目視）は大和さん**。

**Commit**: fdbfc10

### 6.123 fix(link-audio): MIDI シーケンスを LinkAudio strict-mode から除外 (#282) (Jun 18, 2026)

**Date**: 2026-06-18
**Status**: ✅ 修正・テスト済（実機再テストは大和さん）
**Branch**: `279-qa-2.0.0-matrix-smoke-examples`

**発見**: IAC(MIDI) + LinkAudio(Audio) 共存サンプル（examples/19）の MIDI 部分を
`LOOP(piano, inner, bass)` した時点で runtime error:
`Sequence 'piano' has no .output() channel set, but global.linkAudio() is enabled.`

**原因**: `Sequence.run()`(sequence.ts:1205) と `loop()`(1249) が `resolveDispatchChannel()`
を **`isMidi()` ガード無しで** eager 呼び出し。schedule 経路(1115/1185)は MIDI で早期
return するが eager validation は通らず、LinkAudio strict-mode の「`.output()` 必須」が
MIDI シーケンスにも誤適用されていた。VS Code 診断 `analyzeLinkAudioMissingOutput` にも同型バグ。

**仕様（共存は正本で支持済み・spec 変更不要）**:
- DESIGN_DISCUSSION_RECORD #14「MIDI と SC オーディオは併走可 / 排他にする技術的理由がない」
- IMPLEMENTATION_INSTRUCTIONS「MIDI に LinkAudio 型の排他は適用しない」
- core spec §8.1.2「全ての**発音** sequence が `.output()`」← 発音=オーディオ限定

**修正**:
1. engine `resolveDispatchChannel()` 冒頭に `if (this.isMidi()) return undefined`（全4呼出点を一括で MIDI 安全化）。
2. vscode-extension `analyzeLinkAudioMissingOutput` で `.midi(` を持つ名前を orphan から除外。

**検証**: ユーザーの throw を正確に再現する unit test（MIDI+linkAudio+no output →
`resolveDispatchChannel()` が undefined / audio は throw 継続）+ 診断テスト（MIDI 非 flag /
混在ファイルで audio のみ flag）。全 1104 passed（+5）。engine dist と extension dist
（vsix 同梱）の両方に反映を確認。

**Commit**: 5dc2975

## Archived sections

Older entries have been archived by month for readability:

- [2025-09](../archive/WORK_LOG_2025-09.md)
- [2025-10](../archive/WORK_LOG_2025-10.md)
- [2026-02](../archive/WORK_LOG_2026-02.md)
- [2026-04](../archive/WORK_LOG_2026-04.md)
- [2026-05](../archive/WORK_LOG_2026-05.md)
- [2026-06](../archive/WORK_LOG_2026-06.md)
