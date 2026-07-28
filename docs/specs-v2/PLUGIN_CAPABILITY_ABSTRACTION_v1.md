# 形式中立プラグイン能力抽象 v1

owner 確定（2026-07-28・Epic #546 Phase 0 / #547）。プラグイン能力（state・パラメータ・
preset・UI）を **VST3 / CLAP / 将来の AU で同一の UX** として提供するための規範。
上位原則は [`../core/DESIGN_PRINCIPLES.md`](../core/DESIGN_PRINCIPLES.md)。

本仕様は [`PLUGIN_UI_HOSTING_SPEC_v1.md`](PLUGIN_UI_HOSTING_SPEC_v1.md) と
[`PROJECT_FILE_SPEC_v1.md`](PROJECT_FILE_SPEC_v1.md) の共通土台であり、両者から参照される。

> **なぜ独立ファイルか**: Epic #546 の成果物定義では「上2本に共通の章」とされていたが、
> 同一内容を2ファイルに複製すると drift する。単一の正本を両者が参照する形に変更した
> （内容の増減はない）。

---

## CAP.0 なぜ抽象が先か

現状の実装は **VST3 instrument 専用の縦割り**になっている（2026-07-28 コード確認）:

| 能力 | VST3 | CLAP |
|---|---|---|
| state 復元 | instrument child のみ | `--state` を明示 `bail!` |
| state 取得 | host 関数はあるが IPC 未接続 | `CLAP_EXT_STATE` 未使用 |
| effect の state | 引数自体が無い | 同左 |
| param 列挙 / 設定 | 未実装（テストスタブのみ） | `clap_plugin_params` 未使用 |
| GUI | 未実装 | `CLAP_EXT_GUI` 未使用 |

加えて `orbit-vst3-effect-child` が `scripts/copy-daemon-bin.sh` のバンドル対象から漏れており、
**VST3 エフェクトは out-of-process で動かせない**。

形式ごとに機能を足していくと、この縦割りが固定化する。**能力を先に定義し、各形式をその
実装として揃える**。とりわけ、CAP.2 最終行（UI closed 通知 — CLAP にはあり VST3 には無い）の
ように**規格間で到達面が非対称**な箇所は、抽象を先に置かないと「先に実装した形式の都合」が
設計に混入する。

## CAP.1 能力の一覧

| 能力 ID | 意味 | 必須 / 任意 |
|---|---|---|
| `CAP-STATE-GET` | プラグインの不透明な内部状態をバイト列として取得する | **必須** |
| `CAP-STATE-SET` | 取得した状態をプラグインへ復元する | **必須** |
| `CAP-STATE-DIRTY` | プラグイン起点の「状態が変わった」通知 | 任意（CAP.3） |
| `CAP-PARAM-LIST` | パラメータの列挙（ID・名前・範囲・既定値・フラグ） | **必須** |
| `CAP-PARAM-GET` / `CAP-PARAM-SET` | パラメータ値の取得 / 設定 | **必須** |
| `CAP-PARAM-TEXT` | 値 ↔ 表示文字列の相互変換 | 任意 |
| `CAP-PRESET-LIST` / `CAP-PRESET-LOAD` | 規格側 preset / program の列挙・選択 | 任意 |
| `CAP-UI-OPEN` / `CAP-UI-CLOSE` | プラグイン UI の開閉 | 任意（UI を持たないプラグインがある） |

**必須**の能力が欠けている形式は、その形式のサポートを名乗らない。
**任意**の能力は、欠けていても **CAP.4 のループが閉じなければならない**。

## CAP.2 規格対応表

セルは一次ソースで確認した API 名。`—` は「規格に該当機能が存在しない」。

| 能力 | VST3 | CLAP | AU（v1 では非目標） |
|---|---|---|---|
| `CAP-STATE-GET` | `IComponent::getState` | `clap_plugin_state.save` | `AUAudioUnit.fullStateForDocument` |
| `CAP-STATE-SET` | `IComponent::setState` (+ `IEditController::setComponentState`) | `clap_plugin_state.load` | 同上（同プロパティへ代入） |
| `CAP-STATE-DIRTY` | `IComponentHandler2::setDirty`（+ `performEdit`） | `clap_host_state.mark_dirty` | **—**（CAP.3a） |
| `CAP-PARAM-LIST` | `IEditController::getParameterCount` / `getParameterInfo` | `clap_plugin_params.count` / `get_info` | `AUAudioUnit.parameterTree` |
| `CAP-PARAM-GET/SET` | `getParamNormalized` / `setParamNormalized` | `get_value` / パラメータイベント | `AUParameter.value` |
| `CAP-PARAM-TEXT` | `getParamStringByValue` / `getParamValueByString` | `value_to_text` / `text_to_value` | `AUParameter` の value/string 変換 |
| `CAP-PRESET-LIST/LOAD` | `IUnitInfo` program list | `clap_plugin_preset_load.from_location` | `factoryPresets` / `userPresets` / `currentPreset` |
| `CAP-UI-OPEN` | `IEditController::createView` → `IPlugView::attached` | `clap_plugin_gui.create` → `set_parent` → `show` | `requestViewControllerWithCompletionHandler`（`AUViewController.h:83`） |
| `CAP-UI-CLOSE` | `IPlugView::removed` | `clap_plugin_gui.hide` → `destroy` | view controller の破棄 |
| UI closed 通知 | **—**（`IPlugFrame` は `resizeView` の1メソッドのみ） | `clap_host_gui.closed(was_destroyed)` | **—** |

> **AU 列の扱い**: AU の**実装**は v1 の非目標だが、**到達面は macOS SDK ヘッダで一次確認済み**
> （`AudioToolbox.framework/Headers/AUAudioUnit.h`・`CoreAudioKit.framework/Headers/AUViewController.h`）。
> CAP.5 の境界条件を満たす限り、後から実装を差し込める。

### AU が `fullState` ではなく `fullStateForDocument` である理由

AU も **preset 用の state と ドキュメント用の state を規格として区別する**:

> `fullState`: *"A persistable snapshot of the Audio Unit's properties and parameters,
> suitable for saving as a **user preset**."*（`kAudioUnitProperty_ClassInfo` にブリッジ）
>
> `fullStateForDocument`: *"...suitable for saving in a **user's document**. This property is
> distinct from fullState in that some state is suitable for saving in user presets, while
> other state is not. ... **Hosts saving documents should use this property.**"*
> （`kAudioUnitProperty_ClassInfoFromDocument` にブリッジ）

`project.yaml` の `states:` は**ドキュメント側**に対応するため、AU では
`fullStateForDocument` を使う。この区別は CLAP の
`CLAP_STATE_CONTEXT_FOR_PROJECT` / `FOR_PRESET` と同型であり、**3形式のうち2つが規格として
持っている**（PRJ.7）。

## CAP.3a AU に dirty 通知は無い

AU のホスト通知面を全列挙した結果（`AUAudioUnit.h`）:

| 経路 | 意味 |
|---|---|
| KVO on `parameterTree` | パラメータ**集合**の変化 |
| KVO on `allParameterValues`（疑似プロパティ・`:588`） | *"issued in response to certain events where potentially all parameter values are invalidated. This includes changes to currentPreset, fullState, and fullStateForDocument."* → **キャッシュ無効化** |
| KVO on bus properties / render observer | 無関係 |
| v2 `AudioUnitAddPropertyListener` | 汎用のプロパティ変化監視 |

`allParameterValues` は VST3 の `kParamValuesChanged` と同型の**無効化通知**であり、
「再保存せよ」の要求ではない。加えて **`dirty` という語は AudioToolbox のヘッダ全体に
現れない**。

→ **AU には `CAP-STATE-DIRTY` に相当するものが無い。** これにより、
**dirty 通知に依存しない離散セーフポイント方式が3形式すべてで成立する唯一の共通解**である
ことが確定する（CAP.3 の設計判断を AU 側からも支持する）。

> **確信度: 中〜高。反証条件**: v2 の `kAudioUnitProperty_ClassInfo` に対する property
> listener が「プラグイン起点の state 変化」を通知する契約だと Apple が別途明記していた場合。
> ヘッダ内には該当記述が無いことを確認した。

## CAP.3 state dirty 通知 — 両形式に存在するが、いずれも「任意」

**VST3 / CLAP のどちらにもプラグイン起点の dirty 通知がある。ただし双方とも
プラグインが呼ぶ義務を負わない。** ここが設計判断の分かれ目である。

### VST3: `IComponentHandler2::setDirty`

`pluginterfaces/vst/ivsteditcontroller.h`（SDK 原文）:

> *"Tells host that the plug-in is dirty (something besides parameters has changed since
> last save), if true the host should apply a save before quitting."*
> `\note [UI-thread & Connected]`

「**パラメータ以外の何かが最後の保存以降変わった**」— まさに不透明 state の dirty 通知である
（`vst3-0.3.0/src/bindings.rs:6752` に `setDirty` 実在）。パラメータ変化は `performEdit` で
別途届くため、**`setDirty` + `performEdit` の合成が CLAP の `mark_dirty` に相当する**。

### CLAP: `clap_host_state.mark_dirty`

`include/clap/ext/state.h`（原文）:

> *"Tell the host that the plugin state has changed and should be saved again.
> If a parameter value changes, then it is implicit that the state is dirty. [main-thread]"*

拡張自体の目的も明示されている:

> *"Plugins can implement this extension to save and restore both parameter values and
> non-parameter state."*

両者はパラメータ変化の扱い（VST3 = 別経路 / CLAP = 暗黙に含む）が違うだけで、**到達面としては
等価**である。

> ⚠️ **本節は 2026-07-28 の独立監査で訂正された。** 初版は「VST3 に dirty 通知は存在しない」と
> 記載していたが、これは**誤り**だった。ホストコールバック interface の列挙を
> `IComponentHandler` で止め、`IComponentHandler2` を見落としていた。
> 教訓: **「存在しない」の主張は、列挙が尽きたことを示さなければ成立しない。**

### 参考: `restartComponent` は dirty 通知ではない

`RestartFlags` は12個の閉じた列挙で、最も近い `kParamValuesChanged` の原文は:

> *"Multiple parameter values have changed (as result of a program change for example).
> The host invalidates all caches of parameter values and asks the edit controller for the
> current values."*

これは**パラメータ値キャッシュの無効化要求**であって、「`getState` の出力が変わった」の
主張ではない。dirty 通知の役割を負うのは `setDirty` である。

### 設計への帰結（決定①の根拠）

1. **保存の基本方式は離散セーフポイント**（明示保存 API / UI クローズ時 / 停止・終了時）。
   根拠は「VST3 に通知が無いから」**ではなく**、**両形式とも通知が任意だから**である。
   ホストが `IComponentHandler2` を公開し、かつプラグインが `setDirty` を呼ぶ場合にのみ
   届く（CLAP の `mark_dirty` も同様）。**呼ばないプラグインで保存が落ちる設計にはできない**
2. **`CAP-STATE-DIRTY` は「セーフポイントを追加する任意の最適化」**として扱う。
   **両形式とも受け口を実装する**（VST3 = `IComponentHandler2` を公開して `setDirty` を受ける、
   CLAP = `mark_dirty` を受ける）。受けたらセーフポイントを1つ増やすが、依存はしない
3. **変更検知ポーリングは採らない**。`getState` の出力をハッシュして差分を見る方式は、
   Kontakt 級で数十 MB を定期取得することになりコストが実態に合わない。また
   「検知している」ように見えて取りこぼす形は silent failure である

> **反証されうる条件**: いずれかの規格が dirty 通知を**必須**と定めていた場合、1 の
> 「任意だから依存できない」は崩れる。VST3 は `IComponentHandler2` 自体がホストの
> オプション実装であり、CLAP の拡張も `get_extension` が null を返しうるため、
> 現時点では両方とも任意である。

## CAP.4 ループの定義（受け入れの単位）

能力の寄せ集めではなく、**次のループが通しで閉じること**を完成の定義とする
（#541 owner 確定）。

| 段階 | 人間の面 | LLM の面 | 使う能力 |
|---|---|---|---|
| 1. プラグイン指定 | DSL 記述 | MCP evaluate | — |
| 2. 音色を作る / 選ぶ | プラグイン UI | param 列挙・設定 / preset 選択 | `CAP-UI-*` / `CAP-PARAM-*` / `CAP-PRESET-*` |
| 3. 記録 | 自動（共通） | 自動（共通）+ 明示保存 | `CAP-STATE-GET` |
| 4. 復元 | 自動（共通） | 自動（共通） | `CAP-STATE-SET` |

**両面は同じ state に合流し、同じ機構で永続化される**（DESIGN_PRINCIPLES §3）。
段階 2 の LLM 側はループの必須半身であり、「UI 実装後の残項目」ではない。

`CAP-UI-*` を持たないプラグインでも、LLM 側の経路だけでループは閉じなければならない
（逆も同様）。**片方の経路が欠けてもループが閉じる**ことが、対称設計の検証条件である。

## CAP.5 スレッド境界の契約

一次ソースで確認した規格側の要求。**形式をまたいで一致している**ため、抽象側で
単一の規則として固定できる。

| 操作 | VST3 | CLAP | 抽象側の規則 |
|---|---|---|---|
| state save / load | UI スレッド（`setState` は inactive 時が正準） | `[main-thread]` | **メインスレッド** |
| param 列挙 / テキスト変換 | UI スレッド | `[main-thread]` | **メインスレッド** |
| ホストへの編集通知 | `IComponentHandler` 4メソッドすべて *"This must be called in the UI-Thread context!"* | `mark_dirty` `[main-thread]` | **メインスレッド** |
| UI の生成・破棄・表示 | `IPlugView` | `clap_plugin_gui.*` すべて `[main-thread]` | **メインスレッド** |
| 音声処理 | `IAudioProcessor::process` | `process` | **オーディオスレッド** |
| ホストへの表示要求 | — | `request_show` / `request_hide` / `closed` は `[thread-safe]` | 受信側でメインスレッドへ marshal |

> **規則**: 音声処理以外のプラグイン操作はすべてメインスレッドで行う。
> これが CAP.6 の実行モデル変更（child のメインスレッドを runloop に明け渡す）の根拠である。

## CAP.6 実装の要件

1. **能力は形式ごとの実装で満たす**。上位（daemon / MCP / DSL）は能力 ID だけを知り、
   形式分岐を持たない
2. **必須能力は全形式で揃える**。現状の欠落（CAP.0 の表）はすべて是正対象
3. **`orbit-vst3-effect-child` をバンドル対象に加える**。VST3 エフェクトが
   out-of-process で動かないのは、形式中立の前提を破っている
4. **能力の有無は実行時に問い合わせ可能**にし、MCP から観測できること
   （LLM が「このプラグインは UI を持つか」を判断できる）
5. 欠落している能力へのアクセスは **loud に失敗**する。silent no-op にしない
6. **dirty 通知の受け口を両形式で実装する**。VST3 は `IComponentHandler2` をホスト側で公開して
   `setDirty` を受け、CLAP は `mark_dirty` を受ける。受信はセーフポイントを増やすだけで、
   保存の正しさはこれに依存しない（CAP.3）
7. **必須能力には MCP 面が対応して存在する**。`CAP-PARAM-*` / `CAP-PRESET-*` の MCP tool
   （列挙・取得・設定・preset 選択）は、UI の実装有無にかかわらず提供される
   （DESIGN_PRINCIPLES §1）。tool 名・引数・観測形の詳細は実装 PR で定め、本仕様からは
   「存在すること」のみを要求する。**ただし確定後は本仕様へ反映する** — spec が単一
   信頼情報源であり、tool のスキーマがコードにしか無い状態を恒久化させない
   （DESIGN_PRINCIPLES §5）

## CAP.7 検証

- **必須能力は VST3 / CLAP の両方で同じ E2E が green** になること。片方だけの green を
  「完成」と呼ばない
- 判定は解析（capture WAV / MCP による state 観測）で行い、人間を介在させない
  （[`../testing/E2E_HARNESS_SPEC.md`](../testing/E2E_HARNESS_SPEC.md)）
- **computer-use は検証の道具であって API の代替ではない**。設計中の探索と人間経路の
  存在確認には使うが、受け入れ E2E の主経路には据えない。computer-use で UI を叩くのは
  「LLM の面」ではなく「人間の面の代行」であり、LLM 側 API を作らない理由にはならない

---

## 一次ソース

| 主張 | 出典 |
|---|---|
| CLAP `mark_dirty` の存在と原文 | `clap/ext/state.h`（free-audio/clap main）/ `clap-sys-0.5.0/src/ext/state.rs` |
| CLAP GUI のスレッド注記と `closed` | `clap/ext/gui.h` |
| CLAP state context（preset / duplicate / project） | `clap-sys-0.5.0/src/ext/state_context.rs` |
| **VST3 `IComponentHandler2::setDirty` の存在と原文** | `vst3-0.3.0/src/bindings.rs:6752`（`IComponentHandler2Vtbl`）/ VST3 SDK `pluginterfaces/vst/ivsteditcontroller.h:311-314` |
| VST3 のホストコールバック interface の全列挙 | `vst3-0.3.0/src/bindings.rs`: `IComponentHandler`(6545) / `IComponentHandler2`(6750) / `IComponentHandler3`(6937) / `IComponentHandlerBusActivation`(7040) / `IComponentHandlerSystemTime`(7155) / `IUnitHandler`(12989) / `IUnitHandler2`(13126) / `IPlugFrame`(1702) |
| `RestartFlags` が12個の閉じた列挙であること | `vst3-0.3.0/src/bindings.rs`（`RestartFlags_`） |
| `kParamValuesChanged` / `kReloadComponent` の原文 | VST3 SDK `pluginterfaces/vst/ivsteditcontroller.h` |
| `IPlugFrame` が `resizeView` の1メソッドのみであること | `vst3-0.3.0/src/bindings.rs`（`IPlugFrameVtbl`） |
| `IPlugView::setFrame` が「プラグインがホストへリサイズを知らせるため」であること | VST3 SDK `pluginterfaces/gui/iplugview.h:184-185` |
| **`attached()` の最中にプラグインが `resizeView` を呼びうること**（→ `setFrame` は attach 前） | VST3 SDK `pluginterfaces/gui/iplugview.h:146` |
| `resizeView` を受理したら `onSize` を呼び返す義務 | VST3 SDK `pluginterfaces/gui/iplugview.h:177-178` |
| `IPlugView` が常にホスト提供の親ウィンドウへ埋め込まれること | VST3 SDK `pluginterfaces/gui/iplugview.h` |
| AU の `fullState` / `fullStateForDocument` の区別と原文 | macOS SDK `AudioToolbox.framework/Headers/AUAudioUnit.h:758-787` |
| AU の `parameterTree` / `allParameterValues` KVO 通知 | 同 `AUAudioUnit.h:546-588` |
| AU の preset 面（`factoryPresets` / `userPresets` / `currentPreset`） | 同 `AUAudioUnit.h:791-926` |
| AU の UI 取得 | macOS SDK `CoreAudioKit.framework/Headers/AUViewController.h:83` |
| AU に `dirty` の語が存在しないこと | `AudioToolbox.framework/Headers/*.h` の全文検索（該当なし） |

_確立: 2026-07-28（#546 Phase 0 / #547）。改訂は owner 承認を要する。_
