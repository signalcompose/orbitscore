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
実装として揃える**。とりわけ、後述の CAP.3 のように**規格間で到達面が非対称**な箇所は、
抽象を先に置かないと「先に実装した形式の都合」が設計に混入する。

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
| `CAP-STATE-GET` | `IComponent::getState` | `clap_plugin_state.save` | `kAudioUnitProperty_ClassInfo` / `fullState`（要一次確認） |
| `CAP-STATE-SET` | `IComponent::setState` (+ `IEditController::setComponentState`) | `clap_plugin_state.load` | 同上（要一次確認） |
| `CAP-STATE-DIRTY` | **—（存在しない）** | `clap_host_state.mark_dirty` | 要一次確認 |
| `CAP-PARAM-LIST` | `IEditController::getParameterCount` / `getParameterInfo` | `clap_plugin_params.count` / `get_info` | `AUParameterTree`（要一次確認） |
| `CAP-PARAM-GET/SET` | `getParamNormalized` / `setParamNormalized` | `get_value` / パラメータイベント | `AUParameter.value`（要一次確認） |
| `CAP-PARAM-TEXT` | `getParamStringByValue` / `getParamValueByString` | `value_to_text` / `text_to_value` | 要一次確認 |
| `CAP-PRESET-LIST/LOAD` | `IUnitInfo` program list | `clap_plugin_preset_load.from_location` | `factoryPresets` / `currentPreset`（要一次確認） |
| `CAP-UI-OPEN` | `IEditController::createView` → `IPlugView::attached` | `clap_plugin_gui.create` → `set_parent` → `show` | `requestViewControllerWithCompletionHandler`（要一次確認） |
| `CAP-UI-CLOSE` | `IPlugView::removed` | `clap_plugin_gui.hide` → `destroy` | 要一次確認 |
| UI closed 通知 | **—**（`IPlugFrame` は `resizeView` の1メソッドのみ） | `clap_host_gui.closed(was_destroyed)` | 要一次確認 |

> **AU 列の扱い**: AU の実装は v1 の非目標であり、上表の AU 列は**未検証**である。
> 推測で埋めず「要一次確認」と明示する。CAP.5 の境界条件を満たす限り、後から実装を
> 差し込める。

## CAP.3 🔴 規格間の非対称 — state dirty 通知

**CLAP には存在し、VST3 には存在しない。** これは設計判断に直接影響するため明記する。

CLAP `include/clap/ext/state.h`（一次ソース・原文）:

> `mark_dirty`: *"Tell the host that the plugin state has changed and should be saved again.
> If a parameter value changes, then it is implicit that the state is dirty. [main-thread]"*

拡張自体の目的も明示されている:

> *"Plugins can implement this extension to save and restore both parameter values and
> non-parameter state."*

VST3 側は、ホストへの通知面が `IComponentHandler` の4メソッド
（`beginEdit` / `performEdit` / `endEdit` / `restartComponent`）に**閉じている**
（`vst3-0.3.0` バインディングで実測）。`restartComponent` の `RestartFlags` も12個の閉じた
列挙で、最も近い `kParamValuesChanged` の原文は:

> *"Multiple parameter values have changed (as result of a program change for example).
> The host invalidates all caches of parameter values and asks the edit controller for the
> current values."*

これは**パラメータ値キャッシュの無効化要求**であって、「`getState` の出力が変わった」の
主張ではない。**VST3 に `CAP-STATE-DIRTY` に相当するものは無い。**

### 設計への帰結（決定①の根拠）

1. **保存の基本方式は離散セーフポイント**（明示保存 API / UI クローズ時 / 停止・終了時）。
   これは最弱の形式（VST3）で成立し、全形式で同一に動く
2. **`CAP-STATE-DIRTY` は「セーフポイントを追加する任意の最適化」**として扱う。
   CLAP で `mark_dirty` を受けたらセーフポイントを1つ増やしてよいが、**これに依存した
   設計にしない**。プラグイン側が呼ぶ義務を負う保証は無く、VST3 では原理的に来ない
3. **変更検知ポーリングは採らない**。`getState` の出力をハッシュして差分を見る方式は、
   Kontakt 級で数十 MB を定期取得することになりコストが実態に合わない。また
   「検知している」ように見えて取りこぼす形は silent failure である

> **反証されうる条件**: VST3 のプラグインが独自拡張で dirty 通知を提供している、または
> 将来の VST3 SDK が該当フラグを追加した場合、2 の「原理的に来ない」は崩れる。ただし
> その場合も 1 の基本方式は変更不要（CLAP と同じ「任意の最適化」の扱いに入るだけ）。

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
| VST3 `IComponentHandler` が4メソッドに閉じること | `vst3-0.3.0/src/bindings.rs`（`IComponentHandlerVtbl`） |
| `RestartFlags` が12個の閉じた列挙であること | `vst3-0.3.0/src/bindings.rs`（`RestartFlags_`） |
| `kParamValuesChanged` / `kReloadComponent` の原文 | VST3 SDK `pluginterfaces/vst/ivsteditcontroller.h` |
| `IPlugFrame` が `resizeView` の1メソッドのみであること | `vst3-0.3.0/src/bindings.rs`（`IPlugFrameVtbl`） |
| `IPlugView` が常にホスト提供の親ウィンドウへ埋め込まれること | VST3 SDK `pluginterfaces/gui/iplugview.h` |

_確立: 2026-07-28（#546 Phase 0 / #547）。改訂は owner 承認を要する。_
