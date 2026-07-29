# Research: VST3 / CLAP プラグインのスキャンとカタログ化

## 調査日

2026-07-29

## ステータス

調査記録。**#549 の実装方針の根拠**。この調査を経て方針が確定し、実装計画を起案した。

owner の「プラグインのカタログの仕方はベストプラクティスがあるでしょこれ」という指摘が発端。
それまで main は自前で設計を始めており、しかも **main が自分で作った A / B の二択**で
判断を仰ごうとしていた。調査の結果、**その二択自体が誤った枠**だったことが判明した。

## 関連

- **#549** — カタログが VST3 の 23% しか拾えていない（本調査の対象）
- **#463** — 無人スキャン中に FIN-BOOST がネイティブダイアログを出した実害。
  現在の「moduleinfo 無しは probe せず skip」はこの対策として入った
- **Epic #546** — 受け入れ基準が **Kontakt を名指し**しているが、その Kontakt が補完に出ない

## 実測（2026-07-29・実機）

| 項目 | 値 |
|---|---|
| インストール済み VST3 バンドル | **340**（system 337 + user 3） |
| カタログのエントリ | **79**（effect 71 / instrument 9） |
| カバレッジ | **23.2%** |
| 欠落 | **261** |
| うち `moduleinfo.json` があるのに欠落 | **0件** |

**欠落 261 は全て `moduleinfo.json` 無し。** パーサのバグ等の他の失敗経路は存在せず、
原因は skip 判定ただ1つ。

**欠落はランダムではなくベンダー単位**。`moduleinfo.json` を同梱するベンダーだけが通っており、
Native Instruments（Kontakt 7/8・Massive X・Battery 4・Reaktor 6・Maschine 2）、
iZotope 約45件、TR5 約50件、UAD がシリーズ単位で落ちている。
カタログに残った **instrument は 9件のみ**で、うち6件が IK Multimedia。

## 🔴 この調査で覆った main の理解

**論点は「probe するかしないか」ではなく「probe の深さ」だった。**

| 深さ | 得られるもの | ダイアログのリスク |
|---|---|---|
| 静的（`moduleinfo.json`） | class 一覧・CID | なし |
| **factory probe** | class 一覧・CID・名前・カテゴリ | 低い（component 初期化より浅い） |
| component 初期化（JUCE/Ardour 相当） | channel 数・bus・MIDI I/O | 高い |

**#463 で実害が出たダイアログは component 初期化の層**で起きるもので、
factory descriptor の取得はそこまで到達しない。**「安全のために全部切る」は切りすぎだった。**

---

## 調査結果

結論から言うと、OrbitScore の現在の「`moduleinfo.json` がなければプラグインではないものとして skip」という扱いは、VST3 の仕様上は強すぎます。`moduleinfo.json` は任意の高速化用メタデータであり、非同梱は異常ではありません。

一方、VST3 には、`moduleinfo.json` なしで完全に静的・安全にクラス一覧を得る標準手段もありません。網羅性を上げるには、どこかでネイティブコードをロードする必要があります。

したがって推奨は次の構成です。

> 通常起動時はキャッシュと静的情報だけを読む。  
> 未知・更新済みプラグインの初回 probe は、ユーザーが明示的に開始するスキャンで、1モジュール1プロセス・factory 列挙だけ・ハードタイムアウト付きで行う。

これなら「無人起動中に UI が出る」を避けながら、現在欠落している261バンドルの大半をカタログ化できます。

以下、確信度は次の意味です。

- **高**: 仕様・公式文書・公開ソースで確認
- **中**: 公式文書で外部挙動は確認できたが、内部構造は非公開
- **不明**: 公開された一次情報を発見できなかった

---

## 1. 実際の DAW のスキャン方式

### 比較結果

| ホスト | プロセス分離 | ハング・クラッシュ | 失敗の保持・再試行 | 確信度 |
|---|---|---|---|---|
| **Ardour** | VST3バンドルごとに `ardour-vst3-scanner` を起動。1モジュール1プロセス | 設定可能なタイムアウトで子プロセスを終了。クラッシュは事前に作られた blacklist エントリが残る | キャッシュ、blacklist、scan log を永続化。Faultyだけ再スキャン可能 | **高** |
| **Tracktion Engine** | 複数プラグインで1つの子プロセスを再利用 | 接続断・クラッシュ時、現在のプラグインを新しい子プロセスで1回再試行。現行コードには実時間のハードタイムアウトなし | 2回失敗するとJUCE側のblacklist対象 | **高** |
| **JUCE AudioPluginHostサンプル** | OOPモードでは1つのworkerを複数scanで再利用 | 50msごとの応答ポーリングはするが、総時間の上限はない。接続断は失敗 | 失敗は `KnownPluginList` のblacklistへ | **高** |
| **REAPER** | 公式リリースノートで「別プロセス」と明記 | ユーザーがhung pluginを終了可能 | failed-to-scan一覧とプラグイン単位の強制再スキャン | **高**（粒度・自動timeoutは不明） |
| **Studio One** | 公式KBでexternal processと明記 | SkipまたはDisableをユーザーが選択 | Skipは次回起動で再試行、Disableはblocklist。詳細ログあり | **高**（プロセス再利用・timeoutは不明） |
| **Cubase** | Plug-in SentinelがCubase本体へのクラッシュ伝播を防ぐ | クラッシュしたプラグインをblacklistへ | 手動Reactivate、Rescan allで再検査 | **中**（実際のプロセス構成・timeoutは非公開） |
| **Ableton Live** | スキャナのプロセス構成は公式資料から確認できず | Live 11公式マニュアルでは、再試行後に2回目もクラッシュすると利用不可 | 再インストールまで自動再スキャンしない。Live 12.1以降は専用DBを利用 | **中** |
| **Bitwig Studio** | ランタイムのplugin hosting分離は詳細に公開。ただしscanプロセスの粒度は非公開 | scan error一覧と個別・全体再スキャンあり | エラーをユーザーに表示 | **中** |
| **Logic Pro** | AUの比較対象。VST3/CLAPホストではない。検証プロセス構成は非公開 | プラグインの警告ダイアログでscanが停止し得る | failed validation / not authorizedをPlugin Managerで表示、選択再検証可能 | **高**（外部挙動）、内部構造は不明 |

### 公開実装で特に参考になるもの

#### Ardour

Ardour は今回の要件に最も近い公開実装です。

- VST3ごとにscanner executableを起動
- scannerには1バンドルだけを渡す
- scan前にblacklistへ登録し、成功後に解除する
- 親側でtimeoutを監視して子プロセスを終了
- scan結果を1モジュール単位のキャッシュへ保存
- UIには `OK / New / Updated / Error / Stale / Incompatible` を表示
- failed、missingの件数も表示
- faultyだけの再スキャンが可能

一次情報: [Ardour plugin manager source](https://github.com/Ardour/ardour/blob/master/libs/ardour/plugin_manager.cc)、[VST3 scanner source](https://github.com/Ardour/ardour/blob/master/libs/ardour/vst3_scan.cc)、[Plugin Manager manual](https://manual.ardour.org/working-with-plugins/plugin-manager/)、[scan timeout設定](https://manual.ardour.org/preferences-and-session-properties/preferences-dialog/)

ただしArdourのVST3 scannerは、factory列挙後に `IComponent` を生成・初期化し、bus数、channel数、sample formatなども検査します。OrbitScoreが補完用の名前・vendor・カテゴリ・IDだけを必要とするなら、これは深すぎるprobeです。

#### Tracktion Engine

TracktionはJUCEの `KnownPluginList::CustomScanner` を使い、通常は別プロセスでスキャンします。

特徴的なのは、workerを再利用しつつ、クラッシュ時には「前のプラグインがプロセスを汚染した可能性」を考慮して、新しいworkerで現在のプラグインを1回再試行することです。一次情報: [PluginScanHelpers](https://github.com/Tracktion/tracktion_engine/blob/develop/modules/tracktion_engine/plugins/tracktion_PluginScanHelpers.h)、[PluginManager](https://github.com/Tracktion/tracktion_engine/blob/develop/modules/tracktion_engine/plugins/tracktion_PluginManager.cpp)

速度には有利ですが、workerに残ったthread、global state、Objective-C/AppKit状態の影響を次のプラグインが受ける可能性があります。

#### REAPER

REAPER 6.15の公式リリースノートには、次が明記されています。

- scanを別プロセス化
- hung pluginをscan中に終了可能
- scan失敗一覧
- プラグイン単位の強制再スキャン

また、macOSで「modal UIを出すVSTのscan挙動改善」という修正もあります。ただし、プロセスをプラグインごとに作るのか、workerを再利用するのか、自動timeoutがあるのかは公開資料から確認できませんでした。[REAPER 6.x release notes](https://www.reaper.fm/download-old.php?ver=6x)

#### Studio One / Cubase / Ableton

Studio Oneは外部プロセスで、SkipとDisableを明確に分けています。失敗理由を永久blacklistと一時失敗に分けるモデルとして参考になります。[PreSonus公式KB](https://support.presonus.com/hc/en-us/articles/360045185092-What-is-the-difference-between-skip-and-disable-in-the-new-plug-in-scan-and-how-do-I-manage-my-plug-ins-now)

CubaseのPlug-in Sentinelはクラッシュを本体へ伝播させず、失敗対象をblacklistへ入れます。ただし内部のworker粒度は非公開です。[Steinberg公式説明](https://helpcenter.steinberg.de/hc/en-us/articles/207348390-Plug-in-Sentinel-for-Cubase-9)

Ableton Live 11の公式マニュアルでは、クラッシュしたプラグインについて再scanか利用不可を選択させ、2回目もクラッシュした場合は再インストールまで自動scanしないとされています。Live 12.1以降、結果は専用の `Live-plugins-1.db` に格納されます。[Live 11 manual](https://www.ableton.com/en/live-manual/11/working-with-instruments-and-effects/)、[Live 12.1 scan database](https://help.ableton.com/hc/en-us/articles/16261934134940-Rescanning-plug-ins-in-Live-12-1)

### UI・ダイアログ抑止

**確認できたこと:**

- 通常のVST3エディタは、ホストが `IEditController::createView("editor")` を呼ばない限り作られません。[IEditController公式API](https://steinbergmedia.github.io/vst3_doc/vstinterfaces/classSteinberg_1_1Vst_1_1IEditController.html)
- したがってscan中はcontrollerや`IPlugView`を生成しないのが基本です。
- factory列挙だけなら `IComponent` の生成も不要です。

**しかし、完全抑止はできません。**

VST3には「現在はscan中なのでUIやユーザー操作を禁止する」という標準フラグがありません。モジュールのロード、static initializer、`bundleEntry`、`GetPluginFactory`、component初期化のいずれでも、プラグインが独自にAppKitダイアログを出せます。

Apple自身も、Logicのscanがライセンス・期限切れなどのプラグインダイアログによって止まり、Mission Controlから応答する必要がある場合を案内しています。[Apple公式サポート](https://support.apple.com/en-ca/101926)

したがって、

- `IPlugView`を作らない → 通常のeditor UIは抑止できる
- それでも任意のネイティブダイアログは防げない
- subprocess + timeout → ブロックを終了できるが、ダイアログの一瞬の表示まで保証して防げるわけではない

という区別が必要です。

---

## 2. VST3の `moduleinfo.json`

### 位置づけ

**確信度: 高**

Steinbergは明確にoptionalと定義しています。

- VST SDK **3.7.5**で導入
- 3.7.5のリリース日は **2022-05-16**
- 3.7.5～3.7.7では `Contents/moduleinfo.json`
- 3.7.8以降はmacOSコード署名対応のため `Contents/Resources/moduleinfo.json`
- 現行SDKの標準ビルドでは自動生成
- factoryと同等のクラス情報を、モジュールをロードせず取得するためのファイル

一次情報: [Moduleinfo公式仕様](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/VST%2BModule%2BArchitecture/ModuleInfo-JSON.html)、[SDK version history](https://steinbergmedia.github.io/vst3_dev_portal/pages/Versions/Index.html)

OrbitScoreは両方の場所を読むべきです。今回の261件調査が `Contents/Resources` だけを検査したものなら、旧位置について再集計する価値があります。

### 普及率

**不明です。**

Steinbergや業界団体による、インストールベース全体の同梱率調査は発見できませんでした。したがって「一般に何%」という数字は提示できません。

確認できるのは次だけです。

- 2022年導入の比較的新しいoptional機能
- 現行SDKの標準ビルドでは自動生成
- 旧SDK、独自ビルド、独自ラッパーを使う製品には存在しない
- OrbitScoreの実測母集団では23%

Native Instruments、iZotope、IK、UADなどの欠落を考えると、少なくとも実運用上「ない方を例外扱いできるほど普及していない」ことは、OrbitScore自身の実測から確実に言えます。

### ファイルがない場合の公式な経路

標準的な経路は次です。

1. VST3バンドルをロード
2. macOSでは `bundleEntry`
3. `GetPluginFactory`
4. `IPluginFactory::getFactoryInfo`
5. `countClasses`
6. `getClassInfo`、可能なら `IPluginFactory2::getClassInfo2`
7. 必要なクラス情報を得たらアンロード

`createInstance` はfactory列挙とは別操作なので、メタデータだけならcomponentを作る必要はありません。[公式ロード手順](https://steinbergmedia.github.io/vst3_dev_portal/pages/Technical%2BDocumentation/VST%2BModule%2BArchitecture/Loading.html)、[IPluginFactory API](https://steinbergmedia.github.io/vst3_doc/base/classSteinberg_1_1IPluginFactory.html)

公式資料に「moduleinfoがなければ必ずロードしなければならない」という規範的な一文は見つかりませんでした。しかし、moduleinfoをoptionalとし、同じ情報の本来の供給元をfactoryとしているため、**非同梱を非プラグイン扱いすることは公式モデルと整合しません**。

### ロードせず得られる代替情報

| 手段 | 得られるもの | 不足するもの |
|---|---|---|
| `Info.plist` | bundle名、version、executable名など | VST3 class CID一覧、subcategories、1バンドル内の複数plugin class |
| Mach-O export解析 | `GetPluginFactory`等のsymbol存在 | factory内部のclass名、CID、vendor、category |
| ファイル名・bundle名 | 表示名の推測 | 標準化されておらず、shell/multi-class bundleに対応不能 |
| `moduleinfo.json` | 標準的なfactory情報 | optionalなので欠落し得る |

つまり、`moduleinfo.json` がない場合に、ロードなしで完全なVST3カタログを作る標準手段はありません。

---

## 3. JUCEとCLAP

### JUCE

#### 各クラスの役割

- `AudioPluginFormatManager`: formatの登録、plugin instance生成の窓口。安全なscan実行環境そのものではない
- `KnownPluginList`: 成功した `PluginDescription` とblacklistを保持・XML化
- `PluginDirectoryScanner`: directory列挙、1ファイルずつscan、dead-man’s-pedal
- `PluginListComponent`: scan UI。コア機能だけでは必ずしもOOPではない
- `KnownPluginList::CustomScanner`: OOP scannerを差し込むための拡張点

#### Dead-man’s-pedal

JUCEはscan直前に現在のファイル名をdead-man’s-pedalファイルへ書き、成功後に消します。

プロセスがクラッシュするとファイル名が残るため、次回起動時にそのファイルをblacklistへ移し、他のプラグインを先にscanします。[PluginDirectoryScanner source](https://github.com/juce-framework/JUCE/blob/master/modules/juce_audio_processors/scanning/juce_PluginDirectoryScanner.cpp)

これはクラッシュには有効ですが、ハングには無効です。親側のtimeoutが別途必要です。

#### OOP scan

JUCEのAudioPluginHostサンプルにはOOP scanがありますが、

- 1つのworkerを複数pluginで再利用
- 50msのwaitはポーリング間隔
- 応答がなければ無期限にpollを続ける
- wall-clock timeoutは実装されていない

という構造です。[AudioPluginHost source](https://github.com/juce-framework/JUCE/blob/master/extras/AudioPluginHost/Source/UI/MainHostWindow.cpp)

したがって「JUCEのサンプルを使えばハング耐性まで完成する」わけではありません。

#### VST3のfast/slow path

現行JUCEは、

1. `Contents/Resources/moduleinfo.json`
2. 旧 `Contents/moduleinfo.json`
3. なければモジュールをロードしてfactory列挙

という順序です。[VST3PluginFormat implementation](https://github.com/juce-framework/JUCE/blob/master/modules/juce_audio_processors_headless/format_types/juce_VST3PluginFormatImpl.h)

ただしslow pathでは、チャンネル情報などを得るために `IComponent` も生成・初期化します。OrbitScoreの用途なら、factory列挙で止める独自の浅いprobeの方が安全です。

JUCEの再scan判定は主に `lastFileModTime` と既存 `PluginDescription` の比較です。[KnownPluginList API](https://docs.juce.com/master/classjuce_1_1KnownPluginList.html)

### CLAP

**確信度: 高**

CLAPのdescriptor取得は、plugin instance生成を必要としませんが、モジュールのロードは必要です。

1. `.clap` DSO/bundleをロード
2. `clap_entry.init(plugin_path)`
3. `get_factory(CLAP_PLUGIN_FACTORY_ID)`
4. `get_plugin_count`
5. `get_plugin_descriptor`
6. `deinit`、アンロード

`create_plugin` は別操作なので、カタログscanでは呼ぶ必要がありません。[CLAP entry](https://github.com/free-audio/clap/blob/main/include/clap/entry.h)、[plugin factory](https://github.com/free-audio/clap/blob/main/include/clap/factory/plugin-factory.h)、[descriptor](https://github.com/free-audio/clap/blob/main/include/clap/plugin.h)

CLAP仕様はVST3より明確で、`clap_entry.init()`について、

- 速く完了すべき
- GUI表示は禁止
- ユーザー操作は禁止

と明記しています。

ただし、これはplugin実装者への契約であって、ホスト側の強制機構ではありません。DSO load、static constructor、規約違反の実装は依然としてクラッシュ・ハング・UI表示を起こせるため、CLAPもsubprocess + timeoutが必要です。

---

## 4. カタログのデータモデル

### 「入らなかったもの」を保持するか

保持するのが実運用上の標準に近いです。

一次情報で確認できる例:

- Ardour: `Error / Stale / Incompatible`、failed数、missing数
- REAPER: failed-to-scan一覧
- Studio One: blocklistと `PluginScanner.log`
- Cubase: blacklistと再有効化
- Bitwig: scan error一覧と個別再scan
- Logic: failed validation / not authorized

成功したplugin classだけを保存すると、次の状態が区別できません。

- まだscanしていない
- moduleinfoがないためskipした
- load error
- unsupported architecture
- crash
- timeout
- dialogなどでブロックした可能性
- permission error
- pluginをアンインストールした
- scan root自体が存在しなかった

OrbitScoreでは、少なくとも以下を別エンティティにするのがよいです。

### 推奨モデル

#### `scan_root`

- configured path
- canonical path
- format
- `scanned / not_found / permission_denied / io_error / cancelled`
- scan run ID、開始・終了時刻
- 発見bundle数

#### `plugin_module`

- bundle path / executable path
- VST3・CLAP
- architecture
- `moduleinfo` の有無、場所、parse結果
- artifact fingerprint
- first seen / last seen / missing since

#### `plugin_class`

- VST3 CIDまたはCLAP plugin ID
- name、vendor、version、category/features
- metadata source: `moduleinfo / factory / clap_descriptor`
- completeness: `complete / partial / unknown-kind`

#### `probe_attempt`

- stage: `static / load / entry / factory / component`
- outcome: `success / no_classes / load_error / crash / timeout / unsupported_arch / permission / cancelled`
- duration
- exit code / signal
- diagnostic message
- fingerprint at failure
- retry count

#### `policy_state`

診断結果と利用ポリシーは分けるべきです。

- `available`
- `temporarily_suppressed`
- `quarantined`
- `user_disabled`

「前回クラッシュした」という事実と、「今後自動scanしない」という判断を同じbooleanにしない方が、再試行方針を変更しやすくなります。

### ディレクトリ単位の結果

DAWがdirectory access結果をfirst-classデータとして永続化しているかは、公開情報からは一般化できませんでした。

ただしOrbitScoreでは記録すべきです。特にmacOSでは、権限問題・外付けvolume・ユーザーLibraryの状態によって、「0件だった」と「走査できなかった」が容易に混同されます。

rootが一時的に読めなかった場合、前回カタログを即削除せず、`stale_due_to_root_error` として残す方が安全です。

---

## OrbitScoreへの推奨

## 推奨案: 二段階・ユーザー開始型の浅いprobe

### 通常起動時

- scan rootのfilesystem inventoryだけ実行
- 新旧両方の `moduleinfo.json` を読む
- 既存の成功・失敗キャッシュを読む
- 未知のネイティブモジュールは起動時にロードしない
- 変更を検出したら「未検査プラグイン N件」と表示する

これにより、通常起動中の無人UI表示を避けられます。

### ユーザーが「プラグインを検出」を実行したとき

各未知・更新済みモジュールについて、専用helperを1つ起動します。

VST3では:

- bundle load
- `bundleEntry`
- `GetPluginFactory`
- `getFactoryInfo`
- `countClasses`
- `getClassInfo2`、なければ`getClassInfo`
- 結果を親へ返す
- unloadしてプロセス終了

呼ばないもの:

- `IComponent::initialize`
- `IEditController`
- `createView`
- `IPlugView`
- audio bus activation
- sample processing

CLAPでは:

- load
- `clap_entry.init`
- plugin factory descriptor列挙
- `deinit`
- process終了

`create_plugin` は呼びません。

### プロセス粒度

**1モジュール1プロセスを推奨します。**

理由:

- crash・timeoutの帰属が明確
- pluginが残したthreadやglobal stateを次へ持ち越さない
- modal dialogも子プロセス終了で一緒に消せる
- 初回または更新時だけなので、340件規模ではprocess起動コストを受け入れやすい

worker再利用方式は速い一方、Tracktionが実装しているような「fresh workerで再試行」の複雑さが必要になります。

### timeoutと再試行

業界共通の標準秒数は確認できませんでした。Ardourは設定可能、REAPERはユーザー終了を提供し、JUCE/Tracktionの公開サンプルにはhard timeoutがありません。

OrbitScoreでは、

- 親側のwall-clock hard timeout
- timeout時はhelper/process groupを終了
- `timeout_or_ui_blocked` と記録
- 同じfingerprintでは起動ごとに再試行しない
- 明示的な「再検査」またはplugin更新時だけ再試行

がよいです。

開始値として10～30秒程度を設定し、実測分布から調整するのは妥当ですが、これは業界標準値ではなくOrbitScore側のポリシーです。

### キャッシュキー

単純なbundle directoryのmtimeだけは避けるべきです。macOSでは内部binaryを置換してもdirectory mtimeが期待通り変わらない場合があります。

推奨fingerprint:

- canonical bundle path
- 実際のexecutable path
- executableのsize + nanosecond mtime
- `Info.plist` のmtime/size
- `moduleinfo.json` のmtime/size
- architecture
- 必要ならcode-signing CDHashまたは実行ファイルSHA-256
- scanner schema version
- OrbitScore build/probe version

成功キャッシュとnegative cacheの両方を同じfingerprintへ結び付けます。fingerprintが変わればquarantineを自動解除し、再probeします。

## 選択肢とトレードオフ

### A. 完全静的scanを維持

- UI表示・クラッシュ・ハングをほぼ完全に回避
- ただし現在と同様に多数欠落
- Info.plistからの推測値では正確なCID・class一覧を復元不能

「初回scanでも画面上に第三者UIが1フレームも出る可能性を許容しない」が絶対条件なら、この選択しか標準的には保証できません。

### B. 明示的scan時だけfactory probe

- **推奨**
- 既存の主要VST3を広く回収可能
- component初期化よりかなり浅い
- crash/hangは子プロセスに封じ込め可能
- 規約違反pluginのダイアログが一瞬表示される可能性は残る
- 通常起動・無人scanでは実行しないことで運用上回避

### C. JUCE/Ardour相当のcomponent初期化まで実行

- channel数、bus、MIDI I/Oなど豊富なメタデータ
- ライセンス、content、preset DB、sample engine初期化に触れやすい
- OrbitScoreのDSL補完用途には過剰
- 今回問題になったcontent dialogの再発リスクが高い

現時点では採用理由がありません。

## 最終判断

OrbitScoreは、現在の二分法を次の三段階へ変更するのが適切です。

1. **静的成功**: `moduleinfo.json` から取得
2. **probe待ち**: moduleinfoはないがVST3/CLAP artifactとして発見
3. **probe済み**: factory descriptor取得成功、または理由付き失敗

重要なのは、`moduleinfoなし`を「非対応・失敗」ではなく「まだネイティブprobeしていない」と表現することです。

このモデルなら、現状の79件を維持しつつ、残り261件をユーザー開始の安全なprobe対象として段階的に回収でき、同時に「何が、なぜ、カタログへ入らなかったか」も説明可能になります。
