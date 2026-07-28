# プラグイン UI ホスティング仕様 v1

owner 確定（2026-07-28・Epic #546 Phase 0 / #547・#474）。out-of-process child が
プラグイン UI を開くための実行モデル変更を規定する。

上位規範は [`../core/DESIGN_PRINCIPLES.md`](../core/DESIGN_PRINCIPLES.md)、
能力の定義は [`PLUGIN_CAPABILITY_ABSTRACTION_v1.md`](PLUGIN_CAPABILITY_ABSTRACTION_v1.md)
（CAP.1 / CAP.5 を前提とする）。永続化側は
[`PROJECT_FILE_SPEC_v1.md`](PROJECT_FILE_SPEC_v1.md)。

---

## UIH.0 現状と目標の差分

| | 現状 | 目標 |
|---|---|---|
| child メインスレッド | audio spin loop（`orbit-vst3-instrument-child/src/main.rs` の `loop { … spin_loop() }`） | **Cocoa runloop**（`NSApplication`） |
| audio 処理 | メインスレッド | **専用スレッド**（spawn 後に spin） |
| host → child 制御 | `control: AtomicU32`（`CONTROL_RUN` / `CONTROL_QUIT` の2値） | 2値フラグ + **コマンドメールボックス**（UIH.2） |
| 可変長データの授受 | 無し（`SharedRegion` は固定サイズ POD） | **サイドカーファイル + ack**（UIH.3） |
| UI | 無し | 開閉可能（UIH.4） |

**macOS の制約**: `NSApplication` の runloop はプロセス先頭スレッドでなければならない。
したがって「audio をメインスレッドから退かす」ことが UI ホスティングの前提であり、
これは **instrument / effect・VST3 / CLAP のすべての out-of-process 経路に及ぶ
実行モデル変更**である。

## UIH.1 スレッド境界の契約

CAP.5 の規則（音声処理以外のプラグイン操作はすべてメインスレッド）を child 内部に割り当てる。

| スレッド | 担当 | 禁止事項 |
|---|---|---|
| **メイン**（runloop） | UI 生成 / 破棄 / 表示、state save / load、param 列挙・設定、preset 選択、コマンド処理 | ブロッキング待機で runloop を止めない |
| **オーディオ** | `process` / `IAudioProcessor::process` のみ | ロック取得・メモリ確保・ファイル I/O・UI 呼び出し |
| **親監視** | `ParentWatch`（既存） | 変更なし |

規格側の根拠（一次ソース）:

- VST3 `IComponentHandler` の4メソッドすべてに *"This must be called in the UI-Thread context!"*
- CLAP `clap_plugin_gui` の全メソッドが `[main-thread]`、`clap_plugin_state.save` / `load` も `[main-thread]`
- CLAP `clap_host_gui` の `closed` / `request_show` / `request_hide` / `request_resize` は
  `[thread-safe]` → **受信側でメインスレッドへ marshal する**

### 演奏との並行性（決定③）

**UI を開いている間も演奏は止めない。** これは必須要件であり、妥協点にしない。

state 取得（`getState` / `save`）はメインスレッドで行い、**オーディオスレッドは止めない**。
規格上これは許されている（ホストはプロジェクト保存時に実行中のプラグインから state を
取得する）。ただし個々のプラグイン実装が完全にスレッド安全である保証は無いため、
**この前提は UIH.7 の故障モードとして記録し、検証で押さえる**。

## UIH.2 制御語彙の拡張

現状の `control: AtomicU32` は RUN / QUIT の2値で、コマンドを運べない。
**2値フラグは維持したまま、独立したコマンドメールボックスを追加する。**

| フィールド | 方向 | 意味 |
|---|---|---|
| `cmd_seq: AtomicU64` | host → child | host が新規コマンド投函時に単調増加させる |
| `cmd_kind: AtomicU32` | host → child | `OPEN_UI` / `CLOSE_UI` / `SAVE_STATE` / `LOAD_STATE` / `LIST_PARAMS` / `SET_PARAM` / `LOAD_PRESET` |
| `cmd_arg: [u8; N]` | host → child | 固定長の引数域（パス文字列・param id + 値など）。可変長は UIH.3 |
| `cmd_ack_seq: AtomicU64` | child → host | 処理完了した `cmd_seq`。host はこれで完了を判定 |
| `cmd_result: AtomicU32` | child → host | 結果コード（0 = 成功、以外は失敗種別） |
| `cmd_result_len: AtomicU64` | child → host | 成功時に生成したバイト数（UIH.3 のサイドカー長） |
| `cmd_result_detail: [u8; N]` | child → host | **失敗理由の文字列のみ**。成功時は空 |

**規律**:

0. 🔴 **host は ack を受け取るまで次のコマンドを投函してはならない（MUST）**。
   メールボックスは1件分の領域しか持たないため、ack 前に `cmd_seq` を進めると
   前のコマンドは**一度も実行されないまま**上書きされ、しかも child は新しい `cmd_seq` を
   ack するので、`cmd_ack_seq >= 発行 seq` を見ている host には**成功に見える**。
   host 側の待機ヘルパはタイムアウトを持ち、ack された `seq` が発行した `seq` と
   一致することまで確認すること
0-b. 🔴 **child の respawn 時、host はメールボックスを reset しなければならない（MUST）**。
   `SharedRegion` は respawn 間で再利用され、`reset_child_starting` は `child_status` /
   `child_flags` しか戻さない。未処理コマンドを残したまま新しい incarnation を起こすと、
   **replacement child が前世代宛のコマンドを自分宛として実行し、`cmd_result=0` で ack する**
   （「保存したはずが別インスタンスの state だった」を成功として登記する経路）。
   host は「未処理なら失敗として ack を打ってから」replacement を spawn すること。
   *現状 host 側の発行経路は未実装のため未到達。発行経路を足す PR がこの規律を同時に満たすこと*
1. **コマンドはメインスレッドが処理する**。オーディオスレッドはメールボックスを見ない
2. メインスレッドは runloop タイマー（数十 ms 周期で可）でメールボックスを polling する。
   UI 操作はリアルタイム要件を持たないため、この粒度で足りる
3. **未完了のコマンドがあるうちは次を投函しない**（`cmd_seq` == `cmd_ack_seq` を待つ）。
   単一メールボックスで足りる — UI 操作は本質的に低頻度である
4. **`cmd_result` を無視しない**。失敗は上位（daemon → MCP → 利用者）まで loud に伝える

## UIH.2a child → host の非同期ハンドシェイク

**セーフポイントの実行主体は host だが、契機は child 側で発生する。** この非対称が本節の全体である。

- 実行主体が host である根拠: UIH.3（child は最終配置先へ書かない）/ PRJ.4（atomic rename と
  登記更新は host の責務）
- 契機が child 側にある例: プラグイン起点の dirty 通知（`setDirty` / `mark_dirty`）は child 内の
  ホストコールバックに届く。UI クローズの経路①③ も child 起点

### ポリシー（以下すべてこれに従う）

1. **child のメインスレッドは、いかなる待ち合わせでもブロックしない。**
   待ちは**状態機械 + runloop への復帰**で表現する（継続渡し）。
   ブロックすると、応答であるコマンドを処理するのも同じメインスレッドであるため**必ず
   デッドロックする**
2. **🔴 コマンドの ack は「受理」を意味し、「完了」ではない。**
   長時間かかる手続き（クローズ）を起動するコマンドは、**受理した時点で直ちに ack を返す**。
   手続きの完了は**イベント**で別に通知する。

   > **これを守らないとデッドロックする**（実際にした）。UIH.2 規律3 によりコマンド
   > メールボックスは単一で、host は ack を待つ間 次を投函できない。CLOSE_UI の ack を
   > 手続き完了まで遅らせると、host は完了に必要な SAVE_STATE を投函できず、child は
   > その保存完了を待ち続ける — **循環待ち**になる。

3. **イベントの `evt_ack_seq` の前進 = 「当該イベントに伴う host 側処理が完結した」**
   （保存の場合は SAVE_STATE の往復・atomic rename・`project.yaml` 更新まで完了）。
   **受領のみの ack は定義しない**（受領 ack だと child が保存前に先へ進み、
   セーフポイントが事実上スキップされる）
4. **同期を要するイベントと、しないイベントを分ける。**
   `UI_CLOSED` / `UI_CLOSED_DONE` は**取りこぼし不可**（失うと手続きが完結しない）。
   `STATE_DIRTY` は**最適化**なので合流（coalesce）してよい
5. **紳士協定を作らない。** 「host が先に SAVE_STATE を済ませているはず」に依存しない。
   **3経路すべてが同じハンドシェイクを通る**

### イベント欄（リング）

単一スロットではポリシー4を満たせない（後続が先行を上書きする）。**既存の `seq_tag` / `SLOTS`
と同じ per-slot 方式**を使う:

| フィールド | 方向 | 意味 |
|---|---|---|
| `evt_seq: AtomicU64` | child → host | child が投函時に単調増加。スロットは `evt_seq % EVT_SLOTS` |
| `evt_kind: [AtomicU32; EVT_SLOTS]` | child → host | `STATE_DIRTY` / `UI_CLOSED` / `UI_CLOSED_DONE` |
| `evt_arg: [[u8; N]; EVT_SLOTS]` | child → host | 付随情報 |
| `evt_ack_seq: AtomicU64` | host → child | **host 側処理が完結した** `evt_seq`（ポリシー3） |

**🔴 host はイベントを seq 順に処理する（不変条件の前提）**:

**`evt_ack_seq = s` は「s 以下のすべてが完結した」を意味する。**
host は `evt_ack_seq < evt_seq` の間、未処理スロットを**順に**処理して `evt_ack_seq` を進める。
**追い越して前進させてはならない。**

> これは文言ではなく**下記 slot 再利用不変条件の成立条件**である。host が s-1（`STATE_DIRTY`）を
> 後回しにして s（`UI_CLOSED`）を先に完結させ ack を s へ進めると、child は s-1 のスロットを
> 「再利用可」と判定し、**host がまだ読んでいる可能性のある `evt_arg[s-1 % EVT_SLOTS]` へ
> 書き込む** — Release/Acquire を守っていても防げない（順序保証ではなく再利用判定の問題）。

**🔴 `EVT_SLOTS >= 2`**（鏡像元 `transport.rs:59`: *"2 以上であること(連続 seq が必ず別 slot を
指す前提)"*）。`STATE_DIRTY` の in-flight を最大1件に固定する（下記）ため**リング占有の上限は 3**
であり、`EVT_SLOTS = 3` なら見送りが原理的に起きない。2 でも再試行規則があるので停止はしない。

**🔴 slot 再利用の不変条件（鏡像元から継承する）**:

> `transport.rs:25-27`: *"host は新 seq s を submit する前に `seq_done >= s - SLOTS` を確認する。
> 満たさなければ submit を見送る(stall)。… **不変条件が破れると live-but-slow child との間で
> データ競合 = UB になる**"*

イベント欄の鏡像は: **child は新 `evt_seq` = s を投函する前に
`evt_ack_seq >= s - EVT_SLOTS` を確認する。満たさなければ投函を見送る。**

**🔴 publish プロトコル（Release / Acquire）も同様に継承する**:

鏡像元の安全性は**不変条件と Release/Acquire 対の2本柱**で成立している
（`transport.rs:7-9`: *"該当 slot の … を書く → `seq_request` を **Release** で進めて publish"* /
*"child: `seq_request` を **Acquire** で読む … → n_frames/input が可視"*）。
イベント欄には per-slot tag が無く単一カウンタ構成なので、**書き直して明記する**:

| 主体 | 手順 |
|---|---|
| child PUBLISH | `evt_kind[s % EVT_SLOTS]` と `evt_arg[s % EVT_SLOTS]` を書く → **`evt_seq` を Release store** |
| host READ | **`evt_seq` を Acquire load** → 進んでいれば該当 slot を読む |
| host ACK | 処理を完了 → **`evt_ack_seq` を Release store** |
| child READ ACK | **`evt_ack_seq` を Acquire load** |

**`Relaxed`（あるいは素朴な store）で実装してはならない。** `evt_arg` は非 atomic の
`[u8; N]` であり、順序保証の無い cross-process 読み書きは**データ競合 = UB** になる
（`transport.rs:25-27` が警告するものと同じクラス）。

- **投函済み・未 ack のスロットを書き換えてはならない。** host が `evt_arg`（非 atomic の
  `[u8; N]`）を読んでいる最中の書き込みは cross-process の torn read になる
- したがって **`STATE_DIRTY` の合流は child ローカルの pending フラグで行う**
  （「dirty が立っている」を child 側に保持し、スロットが空いてから1件だけ投函する）。
  スロット上の書き換えによる合流は**禁止**
- **`STATE_DIRTY` の in-flight は常に最大1件**（未 ack の dirty があるうちは新たに投函せず
  pending フラグへ合流させる）。これにより**リング占有の上限が静的に決まる**:
  `STATE_DIRTY` 1 + `UI_CLOSED` 1 + `UI_CLOSED_DONE` 1 = **3**
- **🔴 取りこぼし不可のイベント（`UI_CLOSED` / `UI_CLOSED_DONE`）は、投函できるまで
  child が保持し runloop で再試行する。** 「見送る = 落とす」に倒してはならない
  （`Closing` に留まるのはこの一般規則の特例であり、`Closed` 遷移後に投函する
  `UI_CLOSED_DONE` にも再試行が要る — タイムアウト完遂時は host 停滞中で ack が進んでおらず、
  投函が invariant に弾かれうる。落とすと MCP `close_plugin_ui` の完了判定が永遠に閉じない）
- host は既にコマンド完了を polling しているため、同じループでイベントも拾える

> **`UI_RESIZED` を持たない理由**: ウィンドウのリサイズは child が自分の `NSWindow` に対して
> 完結させる（UIH.4b）。host に消費者が無いイベントを高頻度で流すとリングを塞ぎ、
> `UI_CLOSED` の投函を不必要に遅らせる。

### 故障時の脱出条件

| 事象 | 規定 |
|---|---|
| **`Closing` 中に child が crash → respawn** | **リセットの主体は host**（既存の `reset_control_run` と同じパターン・`transport.rs:301`）。順序を固定する: **watchdog が旧 child の死を確認 → host が in-flight 手続きを中止（登記は不変）→ host が `cmd_*` / `evt_*` をリセット → spawn**。新 child 側でゼロ初期化しない（host の polling / 投函と並行 store すると lost update になる）。**「死の確認」は プロセス終了の確認であり、ハング検知ではない** — 生存中の child を死と誤認してリセットすると並行 writer が生じる |
| **host が生きたまま停滞し `evt_ack_seq` が進まない** | child は `Closing` に**無期限滞留しない**。タイムアウト後は保存なしでクローズを完遂し、**🔴 `UI_CLOSED_DONE` を `evt_arg` に「timeout・保存なし」を載せて投函する**（投函できるまで再試行する）。これで (a) MCP の完了判定が閉じ、(b) host は **タイムアウト経路だったことを判別でき**、(c) loud 報告の運搬も兼ねる |
| **host プロセスが死亡** | 既存の `ParentWatch` が child ごと回収する（UIH.1・変更なし）。新たな規定は不要 |
| **child の `cmd_ack_seq` が永遠に返らない** | host はコマンドにタイムアウトを持ち、**loud に失敗**させる。規律3 の待ちに脱出条件が無い状態にしない |
| **`Closing` / `Closed` 中に `OPEN_UI` が届く** | **failure ack**（`cmd_result_detail = "closing-in-progress"`）。タイムアウト任せにしない（正常系なのに loud な失敗になる） |
| **🔴 正常な teardown（`CONTROL_QUIT`）が in-flight のハンドシェイクと交差する** | **host は QUIT を立てる前に、in-flight のクローズ手続き・保留イベント・MCP 完了待ちを解決する**（UIH.6 の停止前セーフポイントと同順で直列化）。解決できないものは **loud に報告**した上で打ち切る。<br>これを規定しないと: 再試行中の `UI_CLOSED_DONE` が QUIT による child 終了で永遠に投函されず、**`close_plugin_ui` の完了判定（DONE の受信）がハングする** |

> **タイムアウト後に host が遅れて保存を完遂した場合**は、二重処理として禁止しない。
> プラグインインスタンスが生きている限り「現在の真の state」が保存されるため実害が無く、
> 禁止するより **`evt_arg` で判別可能にする**方が整合的である。

> **既存の `control` を再利用しない理由**: `control` は teardown 経路で
> `reset_control_run` により RUN へ戻される（respawn の shm 再利用）。コマンドの意味論を
> 同じフィールドに載せると、teardown とコマンドが競合する。

## UIH.3 可変長データの運搬 — サイドカーファイル + ack

`SharedRegion` は固定サイズの POD（`input` / `output` / `input_events` … すべて固定長配列）
であり、**Kontakt 級の数十 MB になりうる state を通せない**。

**方式**: host がパスを指定し、child がそのパスへ書き、ack でバイト数を返す。

```
SAVE_STATE:
  host  → cmd_arg = 出力先パス（host が用意した一時パス）
  child → 一時パスへ書き込み → fsync → cmd_result=0 / cmd_result_len=バイト数
  host  → 読み取り後、PROJECT_FILE_SPEC の atomic 書き込みで確定させる

LOAD_STATE:
  host  → cmd_arg = 入力パス
  child → 読み取り → プラグインへ適用 → ack
```

- **child は最終配置先へ直接書かない**。確定（atomic rename）は host 側の責務
  （PRJ.4）。child がクラッシュしても登記簿が壊れない
- **一時パスの用意と削除は host の責務**。child は「指定されたパスへ書く」だけで、
  自分では消さない（child がクラッシュした残骸も host が掃除する）。
  パスは衝突しない名前を host が採ること（child は検証しない — 同一信頼境界内であり、
  child 内では既にプラグインの任意コードが動いているため、パス検証に追加の防御価値はない）
- 書き込み失敗・サイズ 0・読み取り不能はすべて `cmd_result` の失敗として返す。
  **サイズ 0 の state を「成功」として登記しない**

## UIH.4 ウィンドウの所有 — 形式中立のためホスト所有に統一

規格間で到達面が異なる（CAP.2 の最終行）:

| | VST3 | CLAP |
|---|---|---|
| 埋め込み | 常にホスト提供の親ウィンドウへ（`IPlugView::attached(parent, type)`） | `is_floating=false` + `set_parent` |
| フローティング | **不可** | 可（`is_floating=true` + `set_transient`） |
| 閉じられた通知 | **無し**（`IPlugFrame` は `resizeView` の1メソッドのみ） | `clap_host_gui.closed(was_destroyed)` |

**決定**: **両形式とも「child プロセスが所有する `NSWindow` へ埋め込む」方式に統一する。**
CLAP のフローティングモードは使わない。

理由:

1. **UX が形式で変わらない**（中核制約）。ウィンドウの見え方・閉じ方・タイトルが揃う
2. **閉じられた検出が単一経路になる**。ウィンドウを我々が所有するので、閉じたことは
   我々のウィンドウデリゲートが知る。VST3 に通知が無い問題を回避できる
3. CLAP の `closed(was_destroyed)` は**追加経路**として受理し、同じハンドラへ合流させる
   （`was_destroyed == true` なら仕様どおり `destroy()` を呼んで応答する）

```
OPEN_UI:
  child メインスレッド:
    VST3: createView("editor") → isPlatformTypeSupported("NSView")
          → 🔴 setFrame(IPlugFrame 実装)     ← attached より前（UIH.4b）
          → getSize でウィンドウサイズを決めて NSWindow 生成
          → attached(nsview, "NSView")
    CLAP: is_api_supported(cocoa, is_floating=false)
          → false なら 🔴 loud に失敗（UIH.4a）
          → create(cocoa, false) → get_size → NSWindow 生成
          → set_parent(nsview) → show()
```

> 🔴 **`setFrame` は `attached` より前**でなければならない。SDK 原文
> （`iplugview.h:146`・`attached()` の doc）: *"Note that in this call the plug-in could call
> a IPlugFrame::resizeView ()!"* — **attach の最中にプラグインがリサイズを要求しうる**ため、
> frame が未設定だとその要求を取りこぼす。`getSize` の初回取得も attach 前に行う。

### UIH.4a embedded 非対応プラグインの扱い

CLAP の `is_api_supported(api, is_floating)` は embedded と floating を**別々に問う**設計で、
floating しかサポートしないプラグインは規格上合法である。

**決定**: `is_api_supported(cocoa, false)` が false のプラグインは
**`CAP-UI-OPEN` 非対応として loud に失敗する**（floating へフォールバックしない）。

理由: フォールバックを許すと UIH.4 の統一（ウィンドウ所有・閉じた検出の単一経路）が崩れ、
プラグインによって UX が変わる。**LLM 側の経路（param / preset）でループは閉じる**ので、
UI が開けないことは機能の喪失ではない（CAP.4）。

> 実機で該当プラグインが見つかった場合は記録し、floating 対応の是非を改めて判断する。

### UIH.4b リサイズ応答の義務

child がウィンドウを所有する以上、**プラグイン起点のリサイズ要求に応答する義務も child が負う**。

| 形式 | 経路 | 義務 |
|---|---|---|
| VST3 | `IPlugView::setFrame(IPlugFrame*)` — SDK 原文: *"Sets IPlugFrame object to allow the plug-in to inform the host about resizing"* | **`IPlugFrame` を実装し、`attached` より前に渡す**。null のままだと attach 中のリサイズ要求を取りこぼす |
| VST3 | `IPlugView::onSize` — SDK 原文（`iplugview.h:177-178`）: *"Note that if the plug-in requests a resize (IPlugFrame::resizeView ()) onSize has to be called afterward."* | **`resizeView` を受理したら NSWindow をリサイズし、`onSize` を呼び返す** |
| CLAP | `clap_host_gui.request_resize` / `resize_hints_changed`（`[thread-safe]`） | 受理してメインスレッドで NSWindow をリサイズ |

`set_scale` / `get_resize_hints` も同様にメインスレッドで扱う。

### UIH.4c クローズの状態機械（経路条件つき・冪等）

**UI 状態機械**: `Closed → Open → Closing → Closed`。**`Closing` は非同期状態であり、
その間 child はメインスレッドを runloop へ返す**（UIH.2a ポリシー1）。

```
閉じる要求の到達経路（3つ・すべて同じハンドシェイクを通る）:
  ① NSWindow の閉じるボタン → 🔴 windowShouldClose で NO を返して一旦拒否   ← child 起点
  ② CLOSE_UI コマンド                                                      ← host 起点
  ③ CLAP closed(was_destroyed) コールバック（[thread-safe] → main へ marshal） ← child 起点

フェーズ A（Open のときのみ受理・即座に Closing へ遷移して runloop へ復帰）:
  - 🔴 ② 起因なら CLOSE_UI に**この時点で**受理 ack を返す（UIH.2a ポリシー2）
       ack を手続き完了まで遅らせると循環待ちになる
  - UI_CLOSED イベントを投函（UIH.2a）
  - was_destroyed フラグを Closing 状態に保持
  - 🔴 ここで待たない。ハンドラは戻る

（host が UI_CLOSED を観測 → SAVE_STATE コマンドを投函できる（CLOSE_UI は ack 済み）→
  child が runloop で処理 → host が atomic rename と project.yaml 更新まで完了
  → evt_ack_seq を前進）

フェーズ B（🔴 evt_ack_seq >= UI_CLOSED を投函した evt_seq、を観測して再開）:
  1. プラグイン側の解放 — 形式と was_destroyed で分岐:
       VST3                       : removed()   ← 親破棄より前（iplugview.h:151-152）
       CLAP（was_destroyed=false） : hide() → destroy()
       CLAP（was_destroyed=true）  : destroy() のみ（破棄済み GUI へ hide() を呼ばない）
  2. NSWindow をプログラム的に閉じて破棄
  3. Closed へ遷移
  4. 🔴 UI_CLOSED_DONE イベントを投函（手続き完了の通知）

🔴 フェーズ B のトリガに「単なる前進」を使ってはならない。`evt_ack_seq` は全イベント共用の
   単一カウンタなので、クローズ直前に投函済みだった STATE_DIRTY の完了 ack でも前進する。
   それでフェーズ B を開始すると、UI_CLOSED の保存がまだ走っていないのに解放が先行し、
   「セーフポイントは解放より前」を破る。**必ず UI_CLOSED 自身の seq に到達したかで判定する。**

Closing / Closed 中に到達した追加の要求:
  ①③ → no-op（既に手続き中）
  ②   → no-op だが 🔴 成功 ack を返す（cmd_result=0 / detail="already-closing"）
```

> **MCP `close_plugin_ui` の完了判定**: コマンドの ack（受理）ではなく
> **`UI_CLOSED_DONE` の受信**をもって完了とする。ack で完了を名乗ると
> 「返ってきたのにウィンドウがまだある」ことになる。

> 🔴 **経路①で `windowWillClose` を使ってはならない。** `windowWillClose` は AppKit が
> ウィンドウを閉じ**始めた後**の通知で、そこから保存の往復（非同期・数十 ms〜）を挟むと
> ウィンドウは待たずに消える。VST3 の `removed()` は SDK 原文（`iplugview.h:151-152`）で
> *"The parent window of the view is **about to be** destroyed"* と規定され、**親破棄より前**に
> 呼ぶ契約であるため、順序が壊れる。**`windowShouldClose` で一旦 NO を返し、フェーズ B の
> 完了後にプログラム的に閉じる。**

> 🔴 **「no-op」は「応答しない」ではない。** CLOSE_UI 経由の要求は no-op でも**成功 ack を
> 返す**。返さないと UIH.2 規律3 の host が永久待機する。閉じるボタンの直後に MCP
> `close_plugin_ui` が届くのは**正常系**である。

> **②に特別扱いを設けない理由**: 「host が CLOSE_UI の前に SAVE_STATE を済ませている」は
> child から検証できない紳士協定であり、host 側の実装が守らなければ黙って保存なしで閉じる
> （UIH.2a ポリシー5）。3経路を同じ手続きに通せばこの穴は生じない。

**セーフポイントは状態遷移の入口で1回だけ発火する。** runloop による直列化は「同時実行」を
防ぐが「2回実行」は防がないため、**状態機械による再入ガードが設計要件**である
（UIH.8 の「1回だけ発火」検証はこの要件に対応する）。

> **step 1 を step 2 より先に置く理由**: state はビューではなくプラグイン本体にあるため
> 技術的には破棄後でも取得できるが、破棄経路で例外が出た場合に state を失う。
> **先に確定させる**。

## UIH.5 アドレッシング — テキスト位置ではない

**UI の対象指定は `(シーケンス名, chain index)` で行う。**

テキスト位置（エディタのカーソル）は人間専用の概念であり、これを下位層まで持ち込むと
LLM 側と非対称になる（DESIGN_PRINCIPLES §3 違反）。

| 層 | 責務 |
|---|---|
| エディタ（右クリック） | テキスト位置 → `(シーケンス名, chain index)` の**解決のみ** |
| MCP | `open_plugin_ui(sequence, index)` / `close_plugin_ui(sequence, index)` |
| daemon 以下 | `(シーケンス名, chain index)` だけを知る |

これにより #474 の regex 依存はエディタ層に閉じ込められ、#495 言語サービス導入時も
engine 側は影響を受けない。

### 🔴 位置アドレスは登記キーではない

`(シーケンス名, chain index)` は「**今この瞬間**どれを開くか」を指す**揮発的なコマンド引数**
である。**永続キーとして使ってはならない。**

[SIGNAL_CHAIN_DSL_SPEC_v1.md](SIGNAL_CHAIN_DSL_SPEC_v1.md) SC.5 規範(4)(5) により、ブロック
再評価はチェーンを置き換え、コメントアウト → 再評価でプラグインはアンロードされる。**index は
そのたびにずれる。**

**受理時に SC.5 のインスタンス同一性
`(レシーバ, 正規化名, レシーバ内の同名出現順)` へ解決してから、state 登記に使う**
（PRJ.1）。この解決を怠ると「UI で変えた音色が別のプラグインに適用される」silent failure に
なる。

## UIH.6 ライフサイクル

| 事象 | ウィンドウ | state |
|---|---|---|
| `CLOSE_UI` / 閉じるボタン / CLAP `closed()` | 破棄 | **閉じる前にセーフポイント発火** |
| エンジン停止 | child ごと消える | **停止前にセーフポイント発火** |
| **watchdog respawn** | **自動で開き直さない** | 直近の保存済み state を適用 |

**respawn 時にウィンドウを自動再オープンしない理由**: respawn は障害事象であり、
crash ループ時にウィンドウが繰り返し復活すると作業文脈を壊す。代わりに
**「respawn により UI が閉じた」を loud に通知**する（silent にしない）。

> 自動再オープンは DAW 的には自然な挙動であり、将来の再検討余地として記録する。
> v1 では通知のみとする（owner 判断・2026-07-28）。

## UIH.7 故障モード

| 故障 | 扱い |
|---|---|
| プラグインが UI を持たない | `CAP-UI-OPEN` 非対応として **loud に失敗**。silent no-op にしない |
| **CLAP が embedded 非対応**（`is_api_supported(cocoa, false)` == false） | 同上（UIH.4a）。floating へフォールバックしない |
| `createView` / `gui.create` が失敗 | `cmd_result` で失敗を返し、上位まで伝える |
| **閉じる要求が重複到達**（閉じるボタン + コマンド + `closed()`） | UIH.4c の状態機械が `Closing` 中の要求を無視。**セーフポイントは1回だけ** |
| **プラグインがリサイズを要求**（`IPlugFrame::resizeView` / `request_resize`） | UIH.4b のとおり応答する。**未実装のまま放置しない**（可変 UI プラグインで実害） |
| UI 生成中に child がクラッシュ | 既存の watchdog が respawn。UIH.6 のとおりウィンドウは復活させない |
| **audio スレッド移行によるレイテンシ退行** | 既存の `orbit-clap-effect-child/tests/roundtrip_latency_gated.rs` で検証する。**退行が出た時点で設計を見直す**（性能は要件） |
| state 取得中にプラグインがスレッド安全でない | 規格上は許される操作なので方式は変えないが、**実機検証で dropout / クラッシュを観測する**。問題が出たプラグインは個別に記録する |
| ウィンドウを開いたまま `.orbs` を再評価 | インスタンス同一性（SC.5）が保たれる限りウィンドウは維持。同一性が変わる場合は閉じてセーフポイントを発火 |

## UIH.8 検証

- **VST3 と CLAP の両方**で、UI を開く → パラメータを変える → 閉じる → 再起動 → 同じ音、が
  green になること。片方だけの green を完成と呼ばない
- **UI を開いている間の capture WAV に dropout が無いこと**（`drops == 0`・想定外の無音区間なし）
- 既存 roundtrip latency gated テストに退行が無いこと
- 新規テストは変異検証つき（分岐反転 / 呼び出し回数 / 順序 / 引数差し替えの4種以上）。
  とりわけ次を `toHaveBeenCalledTimes` で押さえる:
  - **閉じる3経路すべてでセーフポイントがちょうど1回発火する**（経路ごとに 0 回・2 回の変異）
  - **経路が重複到達しても1回のまま**（UIH.4c の再入ガードを外すと red になること）
  - **`Closing` 中の CLOSE_UI が成功 ack を返す**（ack を落とすと host が待ち続けて red）
  - **`was_destroyed=true` の経路で `hide()` が呼ばれない**（分岐を潰すと red になること）
  - **フェーズ B が `evt_ack_seq` の前進**でのみ開始する（受領のみで進めると、保存前に解放が
    走って red — UIH.2a ポリシー3 の検証）
  - 🔴 **フェーズ B が `UI_CLOSED` 自身の seq に紐づく**（クローズ直前に**未 ack の
    `STATE_DIRTY` を仕込み**、トリガを「単なる前進」へ変異させると、dirty の ack で
    解放が保存に先行して red）

    > 前項の変異（受領 vs 完結）は**取り違えの軸が違う**ため、これを殺せない。両方要る。

  - **`evt_arg` の publish が Release / Acquire で行われる**（`Relaxed` へ変異させて
    loom 等のモデル検証で競合が検出されること。TSan は別プロセス間の shm を追跡できないので
    in-process モデルで検証する）
  - 🔴 **host がイベントを seq 順に処理する**（s-1 を飛ばして s を先に ack する変異を入れると、
    child が s-1 のスロットを再利用して host の読み取りと競合し red）
  - 🔴 **`UI_CLOSED_DONE` が投函できるまで再試行される**（リングを満杯にしてタイムアウト
    完遂させ、再試行を落とす変異を入れると `close_plugin_ui` が完了せず red）
  - **フェーズ A がメインスレッドをブロックしない**（ハンドラ内でブロッキング待機に変異させると
    SAVE_STATE が処理されずタイムアウトで red — UIH.2a ポリシー1 の検証）
  - **経路①が `windowShouldClose` で一旦拒否する**（`windowWillClose` へ変異させると
    解放より先にウィンドウが消えて red）
  - **`setFrame` が `attached` より前に呼ばれる**（順序を入れ替えると red）
  - **`UI_CLOSED` を取りこぼさない**（リングを単一スロットに変異させ、`STATE_DIRTY` を
    連投して `UI_CLOSED` を上書きすると、クローズが完結せず red）
  - 🔴 **規律3 を忠実に守る host モックで経路②を完走させる**（`cmd_seq == cmd_ack_seq` を
    待ってから次を投函する host で CLOSE_UI を送る。CLOSE_UI の受理 ack をフェーズ B へ
    遅らせる変異を入れると **hang して red**）

    > **この項目が最重要**: host モックが規律3 を守らず SAVE_STATE を平行投函してしまうと、
    > 循環待ちがあっても**全項目 green のまま出荷される**。「テストが通っても壊れている」の典型。

  - **`Closing` 中に child を kill → respawn** させ、host が手続きを中止して
    **登記を更新しない**ことを確認（登記を書く変異を入れると red）
  - **未 ack スロットへ上書き投函する変異**を入れると red（slot 再利用の不変条件・
    `transport.rs:25-27` の鏡像）
  - **host 停滞時にタイムアウトでクローズが完遂する**（タイムアウトを外す変異で
    `Closing` に無期限滞留 → red）
- 判定は解析で行い人間を介在させない。**computer-use は受け入れ E2E の主経路にしない**
  （CAP.7）

## UIH.9 前提となる是正

本仕様の実装前に、以下が満たされていること:

1. **`orbit-vst3-effect-child` をバンドル対象に加える**（`scripts/copy-daemon-bin.sh`）。

   これは「未実装」ではなく**出荷物の欠落**である:
   - daemon は `ORBIT_EFFECT_FORMAT=vst3` のとき当該 child を spawn しようとする
     （`rust/crates/orbit-audio-daemon/src/outproc_effect.rs:84`）。既定パスは daemon 実行
     ファイルと同一ディレクトリ（同 `default_child_exe`）
   - しかし `copy-daemon-bin.sh` の再ビルド一覧（`:85`）にも copy 一覧（`:93-97`）にも
     含まれていない → **出荷された拡張では VST3 エフェクトの spawn が失敗する**
   - gated テストは自前で `cargo build -p orbit-vst3-effect-child` してから走るため
     （`tests/outproc_effect_vst3_gated.rs:28`）、**この欠落を構造的に検出できない**

   是正時は、バンドル済み成果物に対する検証（`.vsix` 内の bin 一覧）を伴わせる。

2. CLAP 側の `CLAP_EXT_STATE` 配線（現状 `--state` は明示 `bail!`）

---

_確立: 2026-07-28（#546 Phase 0 / #547）。改訂は owner 承認を要する。_
