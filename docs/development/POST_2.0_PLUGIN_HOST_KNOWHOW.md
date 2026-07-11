# プラグインホスト実装ノウハウ — フォーマット共通のホスト責務（VST3 / AU / CLAP）

**日付**: 2026-07-08
**由来**: VST3 hosting Phase 0（#381）で得た実証知見を、将来の **CLAP/VST3/AU 併用パイプライン**（正本 §format-neutral substrate・`POST_2.0_PLUGIN_STRATEGY.html`）に効く形で一般化したもの。
**エビデンス強度**: VST3 の節は本セッションで**非サンドボックス実測**した一次事実（commit 参照）。AU / CLAP への対応づけは**構造的推論**（CLAP は本 repo の `orbit-clap-host` で一部裏取り・AU は未実装ゆえ推論多め）。推論箇所は明記する。

---

## 0. なぜこの doc があるか

VST3 を「最小ホスト」で叩くと、実市販コレクションの多くが crash / fail した。だが原因を一次調査すると、**プラグイン側の問題ではなく「ホストが VST3 契約を守っていない／厳しすぎる」だけ**だった。同じ責務は AU/CLAP にも存在する。ここで責務を抽象化しておけば、フォーマットを足すたびに同じ轍を踏まずに済む（owner 要望: 「AU/CLAP を混ぜるとき良いことがある」）。

**中核原則（最重要・全フォーマット共通）**:

> **商用ホストは、optional / advisory なメソッドが「非 OK」を返しても致命扱いにしてはいけない。**
> プラグインは仕様上の optional メソッドを実装しない自由がある。DAW（JUCE 系ホスト含む）はこれを許容して続行する。ホストが `kResultOk` 以外を一律エラーにすると、正常なプラグインが「動かない」と誤判定される。

---

## 1. フォーマット共通のホスト責務（対応表）

| 責務 | VST3（本セッション実証） | AU（推論） | CLAP（`orbit-clap-host` 参照） |
|---|---|---|---|
| **モジュールのロード** | `.vst3` を **CFBundle として** load し、**実 `CFBundleRef` を `bundleEntry` に渡す**（raw dlopen + null は不可） | `.component` を `AudioComponent` 経由でインスタンス化（バンドルは OS が管理） | `.clap` を dlopen し `clap_entry` シンボル → `init(path)` |
| **host context の提供** | `IComponent::initialize` に **`IHostApplication`**（`getName` + `IMessage`/`IAttributeList` を createInstance で供給） | `AUAudioUnit` に host 情報 / `AUHostCallbacks` | `clap_host` struct（name/version + 拡張 query コールバック） |
| **component/controller の生成・接続** | IComponent と IEditController を生成 → `setComponentHandler` → **`IConnectionPoint` で双方向 connect** → state 同期 | AU は単一オブジェクト（分離なし・パラメータは AUParameterTree） | 単一 plugin オブジェクト（分離なし） |
| **I/O バスの query→調停→activate** | `getBusCount`/`getBusInfo` → `setBusArrangements` → `activateBus` | `AUAudioUnit.inputBusses/outputBusses` に `AVAudioFormat` を設定 → `allocateRenderResources` | `audio-ports` 拡張で port 構成を query |
| **optional/advisory 戻りの非致命化** | `setProcessing`=`kNotImplemented(3)` / `setBusArrangements`=`kResultFalse(1)` を**成功扱い** | AU の非対応プロパティ / `kAudioUnitErr_*` の一部を許容 | 拡張が null（未対応）でも続行 |
| **process データの完全性** | 非 null の空 `IEventList`/`IParameterChanges` + 有効な `ProcessContext` | `AURenderPullInputBlock` / timestamp | `clap_process` に in/out events・steady_time |
| **teardown の順序と単一スレッド** | processor→component→factory→bundle の**宣言/drop 順**・home thread 単一スレッド | `deallocateRenderResources`→release | `stop_processing`→`deactivate`→`destroy` を home thread |

---

## 2. VST3 で実証した具体的教訓（本セッションの一次事実）

最小ホスト（56% load・crash 36）から **arm64 商用 VST3 の 99.7%（329/330）load・crash 0** まで到達した。効いた 4 修正:

1. **バンドルロードを CFBundle 正規経路に**（`CFBundleCreate`→`CFBundleLoadExecutable`→`CFBundleGetFunctionPointerForName`・**実 `CFBundleRef` を `bundleEntry` に渡す**）。
   - **効果**: Native Instruments 全群（Kontakt/Massive/FM8/Reaktor 等）の **SIGSEGV が消滅**（36→0）。NI ランタイムは `CFBundleRef` から resources/frameworks/license path を解決するため、`null` を渡すと null deref でクラッシュしていた。
   - ★ 最重要教訓: **macOS プラグインは「実バンドル参照」を entry point が要求しうる**。raw dlopen で symbol だけ取る近道は商用プラグインで壊れる。
2. **`setProcessing` の `kNotImplemented(3)` を許容**。
   - **効果**: iZotope 全群（Ozone/RX/Neutron/Vinyl/Vocal Doubler/Relay 54個）が回復。iZotope は `setProcessing` を実装せず `kNotImplemented` を返すだけで、これは VST3 的に合法。ホストの `is_ok()` が `kResultOk` しか通さなかったのが唯一のバグ。
3. **`setBusArrangements` の `kResultFalse(1)` を advisory 扱い**（プラグイン既定 arrangement で続行）。
   - **効果**: ARIA Player（Garritan 音源）等が load。`setBusArrangements` は host 提案であり、拒否するプラグインは自分の既定構成で動く。JUCE も致命扱いしない。
4. **host context（`IHostApplication`）+ component-controller ハンドシェイク**の実装（土台）。単独では NI/iZotope を救わなかったが、正しいホストに必要な基盤。

**tresult マッピング（vst3-rs / com-scrape・macOS）**: `kResultOk=0` / `kResultTrue=0` / `kResultFalse=1` / `kInvalidArgument=2` / `kNotImplemented=3`。**非 OK を一律 error にせず、`kInvalidArgument` 等の真のエラーとだけ区別する。**

commits: `c0bd90c`(CFBundle) / `ee4d3bd`(kNotImplemented) / `eaa21d0`(setBusArrangements) / verdict=`POST_2.0_VST3_STEP0_SPIKE.md`。

---

## 3. AU / CLAP への対応づけ（推論・未検証を含む）

同じ責務が別 API 名で現れる。フォーマットを足すとき「§1 の各行を新 API で埋める」作業になる。

- **AU（AudioUnit v3 / AUAudioUnit）** — 未実装ゆえ推論:
  - バンドルは OS（AudioComponent registry）が管理するので CFBundleRef 問題は起きにくいが、**entitlement `com.apple.security.cs.disable-library-validation`** が必要（OrbitStudio Phase 3 で見込み済み）。
  - optional プロパティ / render error の一部を許容する必要（VST3 の kNotImplemented 教訓と同型のはず）。
  - bus/format は `AVAudioFormat` を input/output busses に設定 → `allocateRenderResources`。VST3 の setBusArrangements に対応。
- **CLAP** — 本 repo `orbit-clap-host` で一部裏取り済み:
  - host struct のコールバック（拡張 query）が VST3 の IHostApplication に相当。拡張が null（未対応）でも続行する設計＝「非対応を致命にしない」原則の CLAP 版。
  - effect/instrument 判定は `audio-ports`（VST3 の getBusCount に対応）。CLAP は `has_audio_input`（`orbit-clap-host/src/processor.rs`）で判定していた。★ **フォーマットごとに判定 API が違う**ので取り違え注意（VST3 は `getBusCount(kAudio,kInput)>0`）。

**設計含意**: format-neutral substrate（M1 `EffectChildSupervisor` / `orbit-audio-sandbox` transport）は既にフォーマット非依存。各フォーマットの host アダプタが §1 の責務を自分の API で満たせば、同一 substrate に載る。

---

## 4. 計測のノウハウ（重要・再現時の落とし穴）

- **サンドボックスは crash を大幅に水増しする**。コマンドサンドボックス下で sweep すると、プラグイン init の正当な動作（`/bin/ps`・`/Volumes` 読み・helper spawn・license 通信）が SIGKILL され**偽 crash** になる。本セッションで crash が **220（sandbox）→ 36（非サンドボックス）→ 0（修正後）** と動いた。**プラグイン互換の計測は必ず非サンドボックスで**行う。
- **1 プラグイン = 1 サブプロセスで隔離**（segfault/hang が sweep 全体を巻き込まない・Obj-C グローバル class namespace 汚染も回避）。exit code を `256 - signal` で crash/hang/fail に分類。
- **アーキ判定**: `lipo -archs` で `arm64` を含まない Intel-only プラグインは「ホストの fail」でなく「arch 除外」に分類（Rosetta 終息前提で arm64-native が対象）。
- **委譲分担**: 重い実装・広い探索は codex（サンドボックス下でも可）、**実測はサンドボックス外で呼び出し側**が行う（[[delegate-heavy-work-to-codex-verify-from-answer]]）。

---

## 5. 未解決 / Phase 1+ への申し送り

- **厳密な buffer 整合**: `setBusArrangements` を advisory 化した分、実際の process buffer チャネル数はプラグインの `getBusArrangement` 実値に合わせるべき（現 spike は stereo 仮定）。multi-out / sidechain / mono も同様（既知 gap）。
- **instrument 経路**: audio_in=0 のプラグイン（Kontakt/Massive 等）は Phase 0 では load のみ。note-in→audio-out の add-mix は Phase 3（M2 instrument IPC 後）。
- **Komplete Kontrol**（NI host-in-host ラッパー）は sweep で変動（単独 probe では load）。重い wrapper 系は個別対応が要るかもしれない。
- 正本の I/O サーフェス完全カバー要件（audio bus multi-out/sidechain・note/MIDI in+out・CC・note expression/MPE/MIDI2）は Phase 1-2 で honor する（[[orbitscore-engine-fundamental-effects-as-plugins]]）。

---

**要約**: プラグインホスティングの成否は、派手な DSP でなく **「契約の細部（実バンドル参照・optional 戻りの許容・バス調停・host context）を守るか」** で決まる。この責務は VST3/AU/CLAP 共通であり、VST3 で確立したチェックリスト（§1）を各フォーマットに横展開すれば、混在パイプラインへの道が最短になる。
