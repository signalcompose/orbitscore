# Research: ホスト側でのプラグイン state の保持・永続化

## 調査日

2026-07-29

## ステータス

調査記録。**#569 / #568 の設計をやり直す根拠**として使う。実装は未着手。

この調査の前に main が自前で立てた設計（#569「daemon 私有の一時コピーのパスを応答で返す」、
#568「`fingerprints:` を別トップレベルキーに併記」）は、**いずれも本調査で不十分と判明した**。
owner の「プラグインの状態をホスト側で持つ方法もベストプラクティスがあると思うよ」という指摘が発端。

## 関連

- **#569** — respawn 時に state ファイルが欠損すると child が即死する。本調査で設計を保留へ戻した
- **#568** — identity key が同名別パスで衝突する。本調査で `occurrence` ベースが
  **reorder でも壊れる**ことが判明し、方針を見直した
- **#541 / PR #570** — project.yaml からの自動復元（マージ済み）。本調査の対象はその保存側
- **Epic #546** — 受け入れ基準に「宣言 → 音色 → **自動記録** → 再起動 → 同じ音」を含む
- #563 / PR #562 — plugin state の保存（MCP まで）

## 🔴 main の理解の訂正

調査前に main が owner へ説明した内容に**誤りが1つ**あった。

> VST3 の `IComponentHandler`（`beginEdit` / `endEdit` / `restartComponent`）は実装済みだが
> すべて何もせず `kResultOk` を返している。**ここを拾うだけで変更検知の土台になる**

**`beginEdit` / `endEdit` は automation gesture の境界であって dirty API ではない。**
正しくは **`IComponentHandler2::setDirty`**（VST3）と **`clap_host_state.mark_dirty`**（CLAP）。

---

## 調査結果

調査日: 2026-07-29

表記:

- **確認済み**: 仕様・公式文書・公式ソースで直接確認
- **設計判断**: 仕様から導ける推奨だが、特定 DAW の内部実装を確認したものではない
- **不明**: 商用 DAW の非公開実装で、一次情報から確認できなかった

## 結論

OrbitScore は次の方向に変更するのが妥当です。

1. **プリセットとプロジェクト state を論理的に分離する**  
   シリアライズ API や内容は共通でもよいが、名前付きプリセットとインスタンスの自動スナップショットは別オブジェクト・別ライフサイクルにする。

2. **保存のために transport を止めない**  
   VST3 は Processing 中でも UI スレッドから `getState` 可能。CLAP は main-thread 呼び出し。オーディオスレッドから呼ばない。

3. **dirty 通知を保存そのものではなく、保存予約のトリガーとして使う**  
   VST3 の `beginEdit/endEdit` は automation gesture であり dirty API ではない。`IComponentHandler2::setDirty` と CLAP の `mark_dirty` を実装する。

4. **out-of-process child の外に最新チェックポイントを保持する**  
   child がクラッシュした後に最新 state を取り直すことは不可能。最後に成功した recovery snapshot を daemon 側で保持し、respawn 時にそれを復元する。

5. **instance identity と plugin type identity を分離する**  
   安定した `instance UUID` と、VST3 CID / CLAP descriptor ID の両方を保存する。plugin path は identity ではなく locator・診断情報として記録する。

6. **state blob は外部ファイルのままでよい**  
   OrbitScore の project-directory モデルでは、サイズ閾値を設けず全 blob を外部化する案が最も単純。原子的更新、チェックサム、generation 管理を追加する。

---

## 1. プリセットとプロジェクトスナップショット

## VST3

**確認済み:** 単純な VST3 プラグインでは、プリセットのデータは `IComponent::getState` が返す state そのものです。ホストが `.vstpreset` の読み書きを管理します。[Steinberg: Presets & Program Lists](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/Presets%2BProgram%2BLists/Index.html)

VST3 の完全な永続化では二つの state を扱います。

- component state: DSP・モデル
- controller state: GUI 固有状態など

保存・復元順序は次の通りです。

```text
save:
  component.getState
  controller.getState

load:
  component.setState
  controller.setComponentState(componentState)
  controller.setState(controllerState)
```

これはプロジェクトとプリセットの双方に使われます。[Steinberg: Persistence](https://steinbergmedia.github.io/vst3_dev_portal/pages/FAQ/Persistence.html)

したがって、OrbitScore の「VST3 `getState` blob」が component state だけを意味しているなら、controller state も保存対象にする必要があります。

ただし、**プリセットとプロジェクトで必ず同じバイト列になるとは限りません**。VST3 には stream attribute の `StateType` があり、プラグインは `Project`、`Default`、`TrackPreset` などのコンテキストを判別できます。[Preset Meta-Information](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/Change%2BHistory/3.6.0/IStreamAttributes.html)、[StateType](https://steinbergmedia.github.io/vst3_doc/vstinterfaces/group__stateType.html)

つまり:

- シリアライズ経路は共通
- 通常は大部分が同じ state
- ただし context に応じてプラグインが内容を変える余地がある

というモデルです。

## CLAP

**確認済み:** `CLAP_EXT_STATE` は、同じ save/load API を以下すべてに使うと明記しています。

- project reload
- instance duplication/copy
- host-side preset management

また `save` / `load` / `mark_dirty` はすべて main-thread 指定です。[CLAP `state.h`](https://raw.githubusercontent.com/free-audio/clap/main/include/clap/ext/state.h)

`CLAP_EXT_STATE_CONTEXT` はさらに:

- `FOR_PRESET`
- `FOR_DUPLICATE`
- `FOR_PROJECT`

を区別します。コンテキスト別に一部をロードしないなどの違いは許されますが、通常の state API と相互ロードできることが要求されています。[CLAP `state-context.h`](https://raw.githubusercontent.com/free-audio/clap/main/include/clap/ext/state-context.h)

CLAP の plugin-native preset は別の `preset-load` extension でロードできます。ロード後、プラグインはホストへ「どのプリセットをロードしたか」を通知し、ホストとプラグインの preset browser を同期します。[CLAP `preset-load.h`](https://raw.githubusercontent.com/free-audio/clap/main/include/clap/ext/preset-load.h)

## JUCE・実 DAW のモデル

JUCE も次を区別しています。

- `getStateInformation`: プロセッサ全体
- `getCurrentProgramStateInformation`: 現在の program/preset だけ

後者を実装しなければ、既定実装は前者へフォールバックします。[JUCE AudioProcessor](https://docs.juce.com/master/classjuce_1_1AudioProcessor.html)

Apple Audio Unit ではさらに明確で、`fullState` はユーザープリセット向け、`fullStateForDocument` はプロジェクト文書向けです。後者には、プリセットには入れないグローバルな tuning 設定などを含められます。[Apple `fullState`](https://developer.apple.com/documentation/audiotoolbox/auaudiounit/fullstate)、[`fullStateForDocument`](https://developer.apple.com/documentation/audiotoolbox/auaudiounit/fullstatefordocument)

Logic Pro は「プラグイン設定はプロジェクトファイルとともに保存され、再オープン時に自動復元される」としつつ、名前を付けた設定の保存・ロードを別機能として提供しています。[Logic Pro: plug-in settings](https://support.apple.com/en-euro/guide/logicpro/lgcp4dcb0092/mac)

### プリセットをロードした後

**確認済み・高確信:** プリセットロードは一回きりの履歴イベントではなく、インスタンスの現在 state を変更する操作です。次回のプロジェクトスナップショットには、そのロード結果と以後の編集結果が入ります。

VST3 も、factory program を直接変更するのではなく working memory へロードし、変更後の内容を component state として保存するモデルを説明しています。[Steinberg: Presets & Program Lists](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/Presets%2BProgram%2BLists/Index.html)

Apple の `currentPreset` も「最後に選択した preset」を示すだけで、その後パラメータが編集されたかは反映しないと明記されています。[Apple `currentPreset`](https://developer.apple.com/documentation/audiotoolbox/auaudiounit/currentpreset)

したがって OrbitScore では:

- preset ファイルへの参照を project restore の唯一の根拠にしない
- preset load 後の現在 state を改めて project snapshot に保存する
- preset 名・パスは provenance/UI 情報として任意に保持する

のが安全です。

## 埋め込み・外部化・サイズ閾値

**確認済み:** VST3/CLAP とも、ホストのプロジェクト内部で blob を埋め込むか、外部ファイルにするかを規定していません。

VST3 `.vstpreset` は chunk の offset と size に 64-bit 値を使います。[VST3 Preset Format](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/Locations%2BFormat/Preset%2BFormat.html) CLAP は stream callback であり、固定最大サイズを定めていません。

Logic はプラグイン設定を常に project の一部として保存しますが、audio、sample、impulse response などの asset は project package にコピーするか外部参照にするか選択できます。[Logic Pro: Manage project assets](https://support.apple.com/en-ie/guide/logicpro/lgcpce0d70e7/mac)

Ableton Live も Set の device settings と、収集可能な外部 sample/assets を区別しています。[Ableton: Saving and Exporting](https://www.ableton.com/en/live-manual/12/live-concepts/)、[Collecting External Files](https://www.ableton.com/en/live-manual/12/managing-files-and-sets/)

**不明:** Cubase、Logic、Live、Bitwig などが plugin state blob 自体を何 MB で外部化するかという公開閾値は確認できませんでした。標準的な共通閾値もありません。

重要なのは、ホストから見た state は不透明であることです。Kontakt 等が 30 MB を返した場合、ホストが意味を理解して一部だけ外部化することはできません。できるのは blob 全体を:

- project 本体に埋め込む
- project package 内の別ファイルにする
- 外部参照にする

のいずれかです。

---

## 2. いつ state を取るか

## dirty API の意味

### VST3

`beginEdit` / `performEdit` / `endEdit` は automation recording のための gesture API です。

- `beginEdit`: 操作開始
- `performEdit`: 値変更
- `endEdit`: 操作終了

dirty 判定専用 API ではありません。[VST3 Parameters and Automation](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/Parameters%2BAutomation/Index.html)

`restartComponent` も汎用 dirty 通知ではありません。`kParamValuesChanged`、`kLatencyChanged`、`kIoChanged` など、ホストに cache invalidation や component 再構成を要求する API です。[RestartFlags](https://steinbergmedia.github.io/vst3_doc/vstinterfaces/namespaceSteinberg_1_1Vst.html)

VST3 の正式な非パラメータ dirty API は、optional な `IComponentHandler2::setDirty` です。仕様は「パラメータ以外の何かが前回保存後に変わったので、終了前に保存すべき」と明記しています。[IComponentHandler2](https://steinbergmedia.github.io/vst3_doc/vstinterfaces/classSteinberg_1_1Vst_1_1IComponentHandler2.html)

したがって現状の no-op handler は:

- automation gesture を捨てている
- parameter change の通知を捨てている
- restart 要求を捨てている
- さらに `IComponentHandler2` がなければ非パラメータ dirty を受け取れない

という状態です。

### CLAP

`clap_host_state.mark_dirty` は「state が変わり、再保存すべき」と直接定義されています。パラメータ値の変更は暗黙に dirty とされるため、主に非パラメータ state 用です。[CLAP `state.h`](https://raw.githubusercontent.com/free-audio/clap/main/include/clap/ext/state.h)

### JUCE

JUCE の `nonParameterStateChanged` も、「current plugin state を破棄しかねない操作、例えば project close の前に保存を提示すべき」としています。[JUCE ChangeDetails](https://docs.juce.com/master/structjuce_1_1AudioProcessorListener_1_1ChangeDetails.html)

## 推奨トリガー

連続的に `getState` する「リアルタイム保存」は推奨しません。dirty は軽量に記録し、実際の snapshot はまとめて行うべきです。

推奨順は次です。

1. **ユーザーの project save**
2. **project autosave**
3. **dirty 後の debounce された recovery checkpoint**
4. **child の計画的な unload/restart 前**
5. **project close / app quit 前**
6. **通知を正しく出さないプラグイン向けの低頻度 fallback**

実 DAW でも autosave は project 単位です。Cubase は unsaved changes がある project を指定間隔で別 `.bak` に保存します。[Cubase Auto Save](https://www.steinberg.help/r/cubase-pro/15.0/en/cubase_nuendo/topics/project_handling/project_handling_about_the_auto_save_option_c.html) Logic も crash recovery 用 autosave を持ち、現行リリースノートには変更された plug-in settings の autosave 復元が明記されています。[Logic Pro release notes](https://support.apple.com/en-lamr/109503)

`endEdit` 直後は debounce の好機ですが、「必ずそこで snapshot」ではありません。大量 state のプラグインでは、短時間に何度も取得しないよう数秒程度まとめるべきです。

## RT-safe・再生中の取得

### VST3

**確認済み:** `IComponent::getState` は UI thread から呼び、Initialized から Processing までの各状態で許可されています。[IComponent](https://steinbergmedia.github.io/vst3_doc/vstinterfaces/classSteinberg_1_1Vst_1_1IComponent.html)

Steinberg FAQ も、realtime processing 中に UI thread から `getState/setState` を呼べると明記しています。[VST3 Processing FAQ](https://steinbergmedia.github.io/vst3_dev_portal/pages/FAQ/Processing.html)

### CLAP

`state.save/load` は `[main-thread]` 指定です。`!active` や `!processing` の制約はありません。[CLAP `state.h`](https://raw.githubusercontent.com/free-audio/clap/main/include/clap/ext/state.h)

したがって:

- **オーディオスレッドから呼んではいけない**
- **再生中に main/UI thread から取得することは規格上可能**
- **transport stop は規格上の要求ではない**

となります。

ただし、プラグイン内部の serialization が重い可能性はあります。out-of-process なら UI/daemon 側を止めず child の main thread で処理できますが、タイムアウト、遅いプラグインの記録、必要なら「停止後に保存」する compatibility override は残すべきです。

---

## 3. out-of-process ホスト

## crash と respawn

Bitwig はプラグインを別 process に分離し、クラッシュしたプラグインを `Reload Plug-in` で再ロードできます。[Bitwig Plug-in Handling](https://www.bitwig.com/userguide/latest/vst_plug-in_handling_and_options/)

**不明:** Bitwig が reload 用 state を RAM、project model、autosave、別ファイルのどこに何世代保持しているかは公式資料から確認できませんでした。

ただし設計上、child がクラッシュした後はその child から state を取得できません。したがって crash 前の状態を復元するには、host 側に以前取得したコピーが必要です。

推奨モデルは三層です。

```text
child live state
      ↓ snapshot
host recovery checkpoint     ← crash respawn 用
      ↓ project save commit
committed project snapshot   ← project reopen 用
```

- project を開いた直後: committed snapshot と recovery は同一
- dirty 後の checkpoint: recovery だけ更新
- manual save/autosave: 成功した recovery を committed generation に昇格
- user が「保存しない」で閉じた場合: recovery を project 本体へ commit しない

現状の「respawn 時に元の state ファイルを読み直す」は、そのファイルが最後の明示保存時点なら、そこまで巻き戻る設計です。少なくとも dirty 後に成功した recovery checkpoint を別途保持すべきです。

## 大容量 state の IPC

VST3 は `IBStream`、CLAP は `clap_ostream` / `clap_istream` なので、API 自体はストリーミング可能です。全 blob を一度 RAM に載せる必要はありません。

OrbitScore には次が適しています。

### 推奨: 一時ファイル/FD へ直接 stream

```text
daemon:
  temp file 作成
  FD を child に渡す
child:
  plugin getState/save → FD に stream
daemon:
  size/hash 検証
  fsync
  atomic rename
  manifest pointer 更新
```

macOS なら Unix socket の FD passing も選択肢です。child に project directory 全体への書き込み権限を与えずに済みます。

### pipe/socket

- 実装が比較的単純
- backpressure が使える
- 大容量では kernel/user 間コピーが増える
- child crash 時に EOF で失敗を検出しやすい

### shared memory

- コピー回数を減らせる
- 容量交渉、境界検証、generation、crash cleanup が複雑
- 低頻度の state snapshot には過剰になりやすい

**設計判断:** audio buffer には shared memory が適しますが、数十 MB の低頻度 state には、ファイル/FD streaming の方が耐障害性と単純さで優れます。

---

## 4. identity

## plugin type identity

VST3 の ClassID/CID はグローバルに一意として扱うことが要求されています。バージョン更新では通常同じ ClassID を維持します。[VST3 Hosting FAQ](https://steinbergmedia.github.io/vst3_dev_portal/pages/FAQ/Hosting.html)

`.vstpreset` の header にも対象クラスの 16-byte class ID が含まれます。[VST3 Preset Format](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/Locations%2BFormat/Preset%2BFormat.html)

CLAP の `clap_plugin_descriptor.id` も一意であるべき mandatory ID で、reverse URI が推奨されています。[CLAP `plugin.h`](https://raw.githubusercontent.com/free-audio/clap/main/include/clap/plugin.h)

JUCE の `PluginDescription` も `uniqueId` と `fileOrIdentifier` の両方を保持します。[JUCE PluginDescription](https://docs.juce.com/master/classjuce_1_1PluginDescription.html)

## 推奨 identity

最低限、次を分離して保存すべきです。

```yaml
instanceId: <stable UUID>

plugin:
  format: vst3 | clap
  classId: <VST3 CID または CLAP descriptor.id>
  version: <reported version>
  modulePath: <現在の locator>
  moduleFingerprint: <任意: signature/hash>

state:
  path: states/<instanceId>/<generation>.state
  sha256: ...
  size: ...
  context: project
```

- `instanceId`: 同じ plugin type の複数インスタンスを区別
- `classId`: state を適用可能な plugin type を検証
- `modulePath`: バイナリを探すための locator
- version/fingerprint: 診断と互換性判断

**plugin path を primary identity にしてはいけません。** アップデート、移動、再インストールで変わるからです。ただし、同じ CID を持つ重複モジュールや誤実装を診断するため、記録はした方がよいです。

現行 `(receiver, role, normalizedName, occurrence)` には次の問題があります。

- reorder/delete で occurrence がずれる
- rename で identity が変わる
- 同名の別 vendor/plugin を区別できない
- plugin type と logical routing identity が混在している

CID/CLAP ID を追加するだけで取り違えは防げますが、reorder 問題は残ります。最終的には安定した `instanceId` が必要です。

## プラグイン差し替え

推奨規則は次です。

- **同じ stable plugin ID、path/version だけ変更**  
  通常のアップデート・移動として state restore を試す。
- **異なる plugin ID**  
  古い blob を自動適用しない。新プラグインは default/preset state から開始。
- **明示的 compatibility/migration 宣言あり**  
  ユーザー確認または互換性ルールに基づき移行する。
- **古い state**  
  undo、差し戻し、missing-plugin recovery のため一定期間 orphan として保持し、後で GC。

VST3 にも、別 UID のプラグインを置換する場合は明示的な compatibility 情報を提供する仕組みがあります。[VST3 plug-in replacement guidance](https://steinbergmedia.github.io/vst3_dev_portal/pages/Tutorials/Guideline%2Bfor%2BVST3%2Breplacing%2BVST2.html) したがって、単に名前が同じだから state を流用するのは避けるべきです。

---

## OrbitScore への具体的推奨

## 最優先

1. `instanceId` を導入し、state map の key を occurrence ベースから移行する。
2. VST3 CID / CLAP ID を state metadata に必須保存し、load 前に照合する。
3. `IComponentHandler2::setDirty` と `clap_host_state.mark_dirty` を実装する。
4. `performEdit`、`kParamValuesChanged`、preset load、host 側 parameter edit でも instance dirty を立てる。
5. snapshot を child main/UI thread へ要求し、transport stop 要求を外す。
6. committed snapshot と recovery checkpoint を分離する。
7. respawn は最新の成功済み recovery checkpoint から復元する。

## 保存形式

現状の外部ファイル方式を継続する案を推奨します。

- サイズ閾値なしで全 state を外部ファイル化
- `<identityKey>.state` ではなく `instanceId + generation`
- temp write → hash/size 検証 → atomic rename
- manifest は snapshot 成功後に更新
- blob と manifest の更新を二段階 commit にする
- VST3 は component state と controller state を区別して envelope に格納

単一ファイル portability が重要になった場合だけ、project package/ZIP に state files を同梱すればよく、YAML へ base64 埋め込みする必要はありません。

## snapshot policy の二案

### A. Dirty-driven + project autosave（推奨）

- dirty 通知で flag/generation を更新
- gesture 終了後に debounce
- project save/autosave では未保存 instance を確実に snapshot
- 数分単位の低頻度 fallback
- 大容量 state に強い

欠点は、dirty 通知を出さない不良プラグインでは fallback まで state が古くなることです。

### B. 定期間隔ですべて snapshot

- 不良プラグインにも強い
- 実装判断が単純

一方、Kontakt 級の state が多数あると I/O、CPU、undo/autosave 容量が急増します。デフォルトには勧めません。

実用上は **A に、プラグインごとの fallback/compatibility policy を足す**のが最も堅実です。

## 移行時の注意

既存 state は、旧 identity が一意に現在の宣言へ解決でき、かつ取得できた CID/CLAP ID と一致する場合だけ自動移行すべきです。曖昧・不一致なら警告して手動選択とし、silent load は避けるべきです。

