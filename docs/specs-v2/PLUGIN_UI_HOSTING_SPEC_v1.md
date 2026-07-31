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
   `SharedRegion` は respawn 間で再利用される。未処理コマンドを残したまま新しい
   incarnation を起こすと、
   **replacement child が前世代宛のコマンドを自分宛として実行し、`cmd_result=0` で ack する**
   （「保存したはずが別インスタンスの state だった」を成功として登記する経路）。
   host は「未処理なら失敗として ack を打ってから」replacement を spawn すること。
   host 側発行経路は `CommandMailboxHost` として実装済み（#562）。watchdog respawn は
   `CommandMailboxHost::reset_after_child_exit` を effect / instrument の両 supervisor と
   初回 attach の3経路から呼ぶ
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
4. **リングに載せるのは取りこぼし不可のイベントだけにする。**
   `UI_CLOSED` / `UI_CLOSED_DONE` は**取りこぼし不可**（失うと手続きが完結しない）。
   `STATE_DIRTY` は**イベントではなく水位**（level・「前回観測以降に変化があったか」だけが
   意味を持ち、合流してよい）であり、**リングに載せない** — 専用の `dirty_epoch` 単調
   カウンタで運ぶ（本節末「dirty の運搬」）
5. **紳士協定を作らない。** 「host が先に SAVE_STATE を済ませているはず」に依存しない。
   **3経路すべてが同じハンドシェイクを通る**

### イベント欄（リング）

単一スロットではポリシー4を満たせない（後続が先行を上書きする）。**既存の `seq_tag` / `SLOTS`
と同じ per-slot 方式**を使う:

| フィールド | 方向 | 意味 |
|---|---|---|
| `evt_seq: AtomicU64` | child → host | child が投函時に単調増加。スロットは `evt_seq % EVT_SLOTS` |
| `evt_kind: [AtomicU32; EVT_SLOTS]` | child → host | `UI_CLOSED` / `UI_CLOSED_DONE` |
| `evt_arg: [[u8; N]; EVT_SLOTS]` | child → host | 付随情報 |
| `evt_ack_seq: AtomicU64` | host → child | **host 側処理が完結した** `evt_seq`（ポリシー3） |

**🔴 host はイベントを seq 順に処理する（不変条件の前提）**:

**`evt_ack_seq = s` は「s 以下のすべてが完結した」を意味する。**
host は `evt_ack_seq < evt_seq` の間、未処理スロットを**順に**処理して `evt_ack_seq` を進める。
**追い越して前進させてはならない。**

> これは文言ではなく**下記 slot 再利用不変条件の成立条件**である。host が s-1（前サイクルの
> `UI_CLOSED_DONE`）を後回しにして s（新サイクルの `UI_CLOSED`）を先に完結させ ack を s へ
> 進めると、child は s-1 のスロットを「再利用可」と判定し、**host がまだ読んでいる可能性のある
> `evt_arg[s-1 % EVT_SLOTS]` へ書き込む** — Release/Acquire を守っていても防げない
> （順序保証ではなく再利用判定の問題）。

**🔴 `EVT_SLOTS >= 2`**（鏡像元 `orbit_audio_sandbox::transport::SLOTS` の
「連続 seq が必ず別 slot を指す」不変条件）。**`EVT_SLOTS = 2`。**

占有上限の導出: 1 クローズサイクル内で同時に in-flight になりうるのは
`UI_CLOSED` 1 +（host 停滞 → タイムアウト完遂時の）`UI_CLOSED_DONE` 1 = **2**。
`EVT_SLOTS = 2` なら投函の invariant `evt_ack_seq >= s - EVT_SLOTS` は 2 件同時 in-flight まで
満たされるため、**見送りが原理的に起きない**。3 件目が要求されるのは前サイクルの未 ack
`UI_CLOSED_DONE` へ新サイクルの投函が重なる病的ケースのみで、これは再試行規則
（下記）が吸収する — **遅延であり停止ではない**。

> なお本節末「`Closed` の語義（確定）」の**ドレーンゲート**により、**この病的ケース自体が
> 到達不能**になった（前サイクルの ack が追いつくまで新サイクルの投函が始まらない）。
> **それでも再試行規則は防御として維持する** — 到達可能性に依存させない。

> 🔴 **鏡像元の `SLOTS` と値を揃える必要はない。** `SLOTS`（audio pipeline 深さ）は
> `transport.rs` のコメントどおり **PR-C の gated 実機計測で 2 or 3 に確定する暫定値**であり、
> 導出根拠が別（latency/stall のトレードオフ）。`EVT_SLOTS` は上記の占有上限から独立に導く。

**🔴 slot 再利用の不変条件（鏡像元から継承する）**:

> `PipelinedEffectHost::process_block` / `PipelinedInstrumentHost::process_block`:
> host は新 seq s を submit する前に `seq_done >= s - SLOTS` を確認し、満たさなければ
> submit を見送る（stall）。**不変条件が破れると live-but-slow child との間でデータ競合 = UB
> になる**

イベント欄の鏡像は: **child は新 `evt_seq` = s を投函する前に
`evt_ack_seq >= s - EVT_SLOTS` を確認する。満たさなければ投函を見送る。**

**🔴 publish プロトコル（Release / Acquire）も同様に継承する**:

鏡像元の安全性は**不変条件と Release/Acquire 対の2本柱**で成立している
（`PipelinedEffectHost::process_block` / `PipelinedInstrumentHost::process_block` が
該当 slot の payload を書いてから `seq_request` を **Release** で publish し、child loop が
`seq_request` を **Acquire** で読んで payload の可視性を得る）。
イベント欄には per-slot tag が無く単一カウンタ構成なので、**書き直して明記する**:

| 主体 | 手順 |
|---|---|
| child PUBLISH | `evt_kind[s % EVT_SLOTS]` と `evt_arg[s % EVT_SLOTS]` を書く → **`evt_seq` を Release store** |
| host READ | **`evt_seq` を Acquire load** → 進んでいれば該当 slot を読む |
| host ACK | 処理を完了 → **`evt_ack_seq` を Release store** |
| child READ ACK | **`evt_ack_seq` を Acquire load** |

**`Relaxed`（あるいは素朴な store）で実装してはならない。** `evt_arg` は非 atomic の
`[u8; N]` であり、順序保証の無い cross-process 読み書きは**データ競合 = UB** になる
（`PipelinedEffectHost::process_block` / `PipelinedInstrumentHost::process_block` の
slot 再利用 guard が防いでいるものと同じクラス）。

- **投函済み・未 ack のスロットを書き換えてはならない。** host が `evt_arg`（非 atomic の
  `[u8; N]`）を読んでいる最中の書き込みは cross-process の torn read になる
- **🔴 取りこぼし不可のイベント（`UI_CLOSED` / `UI_CLOSED_DONE`）は、投函できるまで
  child が保持し runloop で再試行する。** 「見送る = 落とす」に倒してはならない
  （`Closing` に留まるのはこの一般規則の特例であり、`Closed` 遷移後に投函する
  `UI_CLOSED_DONE` にも再試行が要る — タイムアウト完遂時は host 停滞中で ack が進んでおらず、
  投函が invariant に弾かれうる。落とすと MCP `close_plugin_ui` の完了判定が永遠に閉じない）
- host は既にコマンド完了を polling しているため、同じループでイベントも拾える

> 🔴 **poller は単一であること（規範）**。イベントの読み出しは
> 「`evt_ack_seq + 1` を読む → host 側処理 → `evt_ack_seq` を進める」の一連が**不可分**である必要が
> あり、これを並行に走らせると同一イベントの重複処理と `evt_ack_seq` の lost update が起きる。
>
> 実装は**待ち合わせで直列化するのではなく、多重呼び出しを検出して loud に失敗させる**
> （このコードベースの fail-loud 規律に合わせる）。**同じ理由で、イベント処理ハンドラの中から
> 読み出しを再入させてはならない** — 再入も多重呼び出しとして loud に失敗する。
>
> 将来 poller を多重化する必要が生じた場合、retry / 直列化は**呼び出し側の責務**であり、
> 本節の不可分性の要求は変わらない。

> **`UI_RESIZED` を持たない理由**: ウィンドウのリサイズは child が自分の `NSWindow` に対して
> 完結させる（UIH.4b）。host に消費者が無いイベントを高頻度で流すとリングを塞ぎ、
> `UI_CLOSED` の投函を不必要に遅らせる。

### dirty の運搬 — `dirty_epoch`（リング外・#577 PR-B）

| フィールド | 方向 | 意味 |
|---|---|---|
| `dirty_epoch: AtomicU64` | child → host | プラグインの dirty 通知の**累積回数**（水位） |

- **child**: プラグインの dirty 通知（VST3 `IComponentHandler::setDirty` /
  CLAP `clap_host_state.mark_dirty`）を受けるたび `fetch_add(1, Release)`。
  atomic RMW なので**通知コールバックのスレッドを問わず安全**で、メインスレッドへの
  marshal は不要（リング投函がメインスレッド限定だったのに対する単純化）
- **host**: 既存の polling ループで Acquire load し、**host プロセス内に保持する
  `last_seen`** と比較する。進んでいれば「前回観測以降に少なくとも1回 dirty があった」
  → debounce checkpoint（#577 PR-C）をスケジュールし `last_seen` を更新する。
  `last_seen` は **shm に置かない**（child → host の片方向なので shm に要るのはカウンタ1語）
- **ack は存在しない。** 合流はカウンタの意味論そのものであり、child は host の消費を待たない。
  **ポリシー3 の ack 意味論はリング上のイベント専用で、dirty には適用されない**

> 🔴 **`dirty_epoch` は daemon 起動時の shm truncate による 0 初期化以外で 0 に戻してはならない。**
> **respawn 経路の region リセット（`reset_child_starting`）はこれに触れず**、新 incarnation は
> 既存値の上に増分を続ける。
>
> **evt リングとは扱いが逆である点に注意** — リングは前 incarnation の未処理イベントを
> 残すと replacement child のイベントと混線するため `reset_child_starting` でリセットするが、
> `dirty_epoch` は水位なのでリセットしない。
>
> 理由は `transport.rs` の `InFlightCommand::generation` のコメントが `cmd_seq` について
> 記録している教訓と同じ（respawn 時に「綺麗な状態から始める」意図でカウンタを 0 に戻すと壊れる。
> 実際 `reset_child_starting` は `cmd_kind` / `cmd_arg` を消す一方で `cmd_seq` には触れていない）。
> dirty_epoch では**より悪い**: カウンタだけ 0 に戻り host の `last_seen`（例: 42）が残ると、
> `loaded > last_seen` が偽のままになり、**カウンタが 42 を再超過するまで dirty を黙って
> 取りこぼす**。単調・非リセットならこの故障クラスは構造的に存在しない。
>
> daemon 再起動では shm truncate と host メモリの消滅が同時に起きるため、カウンタと
> `last_seen` は両方 0 に揃う。

> **なぜリングに載せないか**（決定の記録）: ポリシー3 は「ack の前進 = host 側処理が**完結した**。
> 受領のみの ack は定義しない」と規定するが、`STATE_DIRTY` の「host 側処理の完結」は
> 定義できない。debounce checkpoint の完了とすると、seq 順処理の強制により**後続の
> `UI_CLOSED` の ack が debounce 窓（数秒）に結合する**。受領で即 ack とすると
> ポリシー3 の暗黙の例外になる。dirty を ack 概念の外に出すことで、この未定義箇所を
> **定義する必要ごと消す**。

### 故障時の脱出条件

| 事象 | 規定 |
|---|---|
| **`Closing` 中に child が crash → respawn** | **リセットの主体は host**（既存の `reset_control_run` / `CommandMailboxHost::reset_after_child_exit` と同じパターン）。順序を固定する: **watchdog が旧 child の死を確認 → host が in-flight 手続きを中止（登記は不変）→ host が `cmd_*` / `evt_*` をリセット → spawn**。新 child 側でゼロ初期化しない（host の polling / 投函と並行 store すると lost update になる）。**「死の確認」は プロセス終了の確認であり、ハング検知ではない** — 生存中の child を死と誤認してリセットすると並行 writer が生じる |
| **host が生きたまま停滞し `evt_ack_seq` が進まない** | child は `Closing` に**無期限滞留しない**。タイムアウト後は保存なしでクローズを完遂し、**🔴 `UI_CLOSED_DONE` を `evt_arg` に「timeout・保存なし」を載せて投函する**（投函できるまで再試行する）。これで (a) MCP の完了判定が閉じ、(b) host は **タイムアウト経路だったことを判別でき**、(c) loud 報告の運搬も兼ねる |
| **host プロセスが死亡** | 既存の `ParentWatch` が child ごと回収する（UIH.1・変更なし）。新たな規定は不要 |
| **child の `cmd_ack_seq` が永遠に返らない** | host はコマンドにタイムアウトを持ち、**loud に失敗**させる。規律3 の待ちに脱出条件が無い状態にしない |
| **クローズ手続きが未決着の間に `OPEN_UI` が届く**（`Closing` 中、および `Closed` 遷移後も当該サイクルの `UI_CLOSED_DONE` が ack されるまで） | **failure ack**（`cmd_result_detail = "closing-in-progress"`）。タイムアウト任せにしない（正常系なのに loud な失敗になる）。未決着の判定は下記「`Closed` の語義（確定）」の**ドレーン条件**による |
| **🔴 正常な teardown（`CONTROL_QUIT`）が in-flight のハンドシェイクと交差する** | **host は QUIT を立てる前に、in-flight のクローズ手続き・保留イベント・MCP 完了待ちを解決する**（UIH.6 の停止前セーフポイントと同順で直列化）。解決できないものは **loud に報告**した上で打ち切る。<br>これを規定しないと: 再試行中の `UI_CLOSED_DONE` が QUIT による child 終了で永遠に投函されず、**`close_plugin_ui` の完了判定（DONE の受信）がハングする** |

> **タイムアウト後に host が遅れて保存を完遂した場合**は、二重処理として禁止しない。
> プラグインインスタンスが生きている限り「現在の真の state」が保存されるため実害が無く、
> 禁止するより **`evt_arg` で判別可能にする**方が整合的である。

> **`Closed` の語義（確定・2026-07-31）**: 上表の「クローズ手続きが未決着」の窓は、
> **`Closing` への遷移から、当該サイクルの `UI_CLOSED_DONE` が ack されるまで**。
> 状態機械の `Closed` にいることは再オープン可の十分条件ではなく、
> **evt リングのドレーンが完了していること**を併せて要求する:
>
> **🔴 再オープン可 ⇔ `Closed` かつ リングがドレーン済み**
> **（保留イベント 0 件 かつ `evt_ack_seq == evt_seq`）**
>
> リングに載るイベントは `UI_CLOSED` / `UI_CLOSED_DONE` のみで ack は seq 順に進むため、
> **ドレーン完了は「直前サイクルの `UI_CLOSED_DONE` が host 側で完結した」と同値**である。
> child は `evt_ack_seq` を Acquire load で読めるので、**この判定は child 単独で行える**
> （個別 seq の記録は不要）。
>
> **初期状態（一度も開いていない `Closed`）はリングが空でドレーン条件を自明に満たす**ので、
> 最初の `OPEN_UI` は受理される — 字義どおりの読み（`Closed` 全体を拒否する解釈）が招く
> 「UI を一度も開けない」帰結は、この定式化により生じない。respawn 後も同様
> （`reset_child_starting` が evt カーソルを 0 に戻すため新 incarnation はドレーン済みから始まる）。
>
> この確定により: **(a)** `EVT_SLOTS = 2` の占有上限導出が**例外なく**成立する
> （前サイクルの ack が追いつくまで新サイクルの投函が始まらないため、投函 invariant による
> 見送りは原理的に発火しない）。**(b)** UIH.4c フェーズ B の
> 「前サイクル `UI_CLOSED_DONE` の ack による誤前進」ハザードは**到達不能**になる。
>
> 🔴 **ただしフェーズ B のトリガ規則（`UI_CLOSED` 自身の seq 到達で判定）は無条件に維持する** —
> 規則は到達可能性に依存させない（緩めて得られるものが無く、緩めた場合の失敗は
> 「セーフポイントのスキップ」= 音色の喪失だからである）。
>
> **却下した代替**: 「`Closing` 中のみ拒否し、`Closed` なら即再オープン可」も検討したが、
> 利点とされる「host の ack を待たない」が実質を持たない — **`OPEN_UI` は host 起点のコマンド**
> であり、host が DONE を ack できないほど停滞している状況では**発行主体も同じ host 側**にいる。
> ドレーン待ちは正常系で「host の poll 1 周分」であり、失敗しても failure ack で loud に返る。
>
> **この確定が崩れる条件**: ① リングに**第3のイベント種別**が追加された場合
> （「ドレーン ⇔ DONE ack 済み」の同値性が崩れ、判定を「DONE の seq を明示記録して比較」へ
> 格上げする必要がある。確定自体は不変で判定式のみ変更）② `OPEN_UI` の処理スレッドと
> evt 投函スレッドが分離される設計変更（check-then-act の race が生じる）。

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
- 🟡 **audio 専用スレッドへの分離（UIH.1 の目標状態）は #474 P1 で実装済み。**
  4 child とも audio slot 処理は専用 audio スレッド、`SAVE_STATE` を含む command mailbox は
  `NSApplication` main runloop のタイマーで処理する。サイドカーの書き込み・`fsync` が main
  スレッドをブロックしても audio slot の前進を止めない構造になった。
  #474 P1 の実機 gated は green:
  - レイテンシは4回実測の最悪値でも要求（margin >10x）に対して **margin 49.9x**、
    `kill にフォールバック` は0件
  - 実機4経路は **effect 4+4 / instrument 3+3**、`capture drops == 0`
  - 演奏中 `SAVE_STATE` は `save_during_playback.rs` が **1 passed**、state roundtrip も green

  これにより、従来の「host は演奏停止中にのみ `SAVE_STATE` を発行すること」という
  **暫定 MUST を解除し、演奏中の発行を許可する**。
  規格上も VST3 `IComponent::getState` は
  **`[UI-thread & (Initialized | Connected | Setup Done | Activated | Processing)]`**
  （VST3 SDK `ivstcomponent.h:203`）であり、Processing 中の main/UI スレッドからの state
  取得が明示的に許可されている。これを演奏中保存の VST3 規格根拠とする。
  host 側発行経路は `CommandMailboxHost` として実装済み（#562）。watchdog respawn は
  `CommandMailboxHost::reset_after_child_exit` を effect / instrument の両 supervisor と
  初回 attach の3経路から呼ぶ

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
   単一カウンタなので、**先行イベントの完了 ack でも前進する**。dirty をリングから外した後
   （UIH.2a）に残る先行イベントは**前サイクルの `UI_CLOSED_DONE`** である。
   それでフェーズ B を開始すると、UI_CLOSED の保存がまだ走っていないのに解放が先行し、
   「セーフポイントは解放より前」を破る。**必ず UI_CLOSED 自身の seq に到達したかで判定する。**

   > この経路（前サイクルの `UI_CLOSED_DONE` が未 ack のまま新サイクルが走る）は、
   > UIH.2a「故障時の脱出条件」の `OPEN_UI` 受理規則の確定（**ドレーン条件**・2026-07-31）により
   > **到達不能**である。
   >
   > 🔴 **それでも本規則は維持する** — 判定を「単なる前進」に緩めて得られるものが無く、
   > 緩めた場合の失敗は「セーフポイントのスキップ」（= 音色の喪失）だからである。
   > **規則は到達可能性に依存させない。**

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

**対象指定は `(receiver, chain index)` で行う。** receiver は sequence 名・`master`
（**master 出力エンドポイント** — sum / aux の **mixer バス**とは別概念）・
`sum:<name>` / `aux:<name>`（mixer バス）のいずれか。

テキスト位置（エディタのカーソル）は人間専用の概念であり、これを下位層まで持ち込むと
LLM 側と非対称になる（DESIGN_PRINCIPLES §3 違反）。

| 層 | 責務 |
|---|---|
| エディタ（右クリック） | テキスト位置 → `(receiver, chain index)` の**解決のみ** |
| MCP | `save_plugin_state(receiver, index)`（実装済） / `open_plugin_ui(sequence, index)`・`close_plugin_ui(sequence, index)`（**未実装**） |
| daemon 以下 | 解決済みの target（daemon bus / instance）と chain index だけを知る |

> **UI open/close の v1 スコープ**: `open_plugin_ui` / `close_plugin_ui` は**未実装**であり、
> **v1 では receiver を sequence に限定する**。receiver 一般化（`master` / `sum:` / `aux:`）が
> v1 で適用されるのは state 保存・復元（`save_plugin_state` / PRJ.1 auto-restore）のみ。

これにより #474 の regex 依存はエディタ層に閉じ込められ、#495 言語サービス導入時も
engine 側は影響を受けない。

### chain index の割り当て規則（規範）

**この規則が無いと、呼び出し側が index の数え方を推測することになる**（#562 で空白が判明）。

> **receiver 名前空間（規範）**: sum / aux バスは receiver にそれぞれ `sum:` / `aux:` を
> 字句的に前置して指定する（例: `sum:drum`, `aux:reverb`）。接頭辞付き receiver は指定した
> kind の同名バスだけを指し、sum → aux の解決順、`resolveNode()`、sequence への fallback を
> 使用してはならない。接頭辞を剥がした宣言名は当該 kind の名前空間でのルックアップキーとして
> **のみ**使い、daemon target には**宣言名で解決した物理バス**（chain slot が保持する
> pool 割り当て済みバス名。例: `sum-bus-0`）を渡す。receiverId から接頭辞を除いた文字列を
> そのまま daemon に渡してはならない。SC.5 の永続 identity には接頭辞付き receiver を
> そのまま使う。
>
> 接頭辞なし receiver は従来どおり sequence だけを指し、`master` だけは master 出力
> エンドポイントを指す。
> 接頭辞なしの名前と同名の sum / aux バスが存在してもバスへ暗黙解決してはならない。sequence が
> 存在しない一方で同名バスが存在するときは、`sum:<name>` / `aux:<name>` の明示指定を促す
> loud エラーにする。これにより、同名の sequence / sum / aux 間で別プラグインの state を保存して
> 成功扱いする silent failure を防ぐ。`sum:x` という文字列は常に sum バス receiver と解釈し、
> 同名 sequence への fallback は設けない。
>
> **暗黙の不変条件（規範）**: 接頭辞解釈が字句的である帰結として、`sum:` / `aux:` で始まる
> **sequence 名は receiver 解決で常にバス扱い**になり、state 保存の対象として直接アドレス
> できない（DSL の識別子文法は `:` を受理しないため DSL からは到達不能だが、内部 API 経由では
> 起こりうる）。また、永続 identity キー `receiver/role/正規化名/出現順` の**単射性**は次の
> 3点に依存する: (1) role が `instrument` / `effect` の固定語彙であること、(2) 正規化名が
> basename 由来で `/` を含み得ないこと、(3) 出現順が数値であること。これらのいずれかを
> 緩める変更は、キー衝突（別プラグインの state を同一キーへ登記する silent failure）の
> 再検討なしに行ってはならない。

1. **index 0 = ソーススロット。** レシーバの信号源（SC.1 規範(2) の構造トポロジーで先頭に立つもの）
   に予約する。
   - **note シーケンス**: `instrument()` プラグインが入る。宣言があれば index 0 で指せる
   - **audio シーケンス**: 組み込みオーディオ再生（`.audio()`）が占有する。
     **v1 ではプラグインではないため index 0 はアドレス不可**（UI も state chunk も持たない）
   - **バス（sum / aux / master 出力）**: ソーススロットを**持たない**
     （信号源は他レシーバからの合流入力であり、スロットではない）
2. **effect は全レシーバ種別で 1 始まり。** チェーンの n 番目の effect（SC.1 信号層の接続順）
   = index n。**ソーススロットの有無・中身に関わらず effect の番号は変わらない。**
3. **存在しない index の指定は loud エラー。** silent no-op にしない。エラーには当該レシーバで
   現在有効な index の一覧（role・正規化名つき）を含める（**LLM が MCP から自己修正できるように**）。
   - instrument 未宣言のシーケンスの index 0 → 「instrument が宣言されていない」
   - audio シーケンスの index 0 → 「組み込みオーディオソースはプラグインではない」
   - バスの index 0 → 「このレシーバ種別はソーススロットを持たない（effect は 1 始まり）」
4. この index は**揮発アドレス専用**である（次節）。受理時に SC.5 のインスタンス同一性へ解決してから
   永続化に使う。**SC.5 の「同名出現順」とこの index は別の数**であり、混同してはならない
   （前者は同名内の順位、後者はチェーン全体の位置。値がずれるのが常態）。

> ⚠️ **誤読しやすい点**: 「持たない」のは **index 0 のソーススロットだけ**。
> **エフェクトチェーンは全レシーバが持つ** — sum / aux / master にも当然 effect を挿せる
> （SC.2.1 規範(4)「バス（sum / aux）自身もレシーバである: シーケンスと同じ書式で
> プラグインチェーン・出力先指定を持てる」）。

> **将来のレシーバ種別について**: 新種別を足すときは「**ソーススロットを持つか / その中身は
> アドレス可能なプラグインか**」の2述語を宣言するだけでよく、既存の番号は動かない
> （規則2が種別に依存しないため）。
>
> ただし**レコーディングトラックを「index 0 の予約席」と見なしてはならない**（owner 2026-07-28）。
> 想定されているレコーディング機能は「音源が1個刺さっている」モデルではなく、
> **時間軸上に複数チャンクが並ぶ**構造（Opcode Studio Vision のチャンク機能に近い）で、
> 現在の `audio()` ワンショット再生とも別物。**新しいレシーバ種別として設計する**。仕様は未定。

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
  - 🔴 **フェーズ B が `UI_CLOSED` 自身の seq に紐づく**（**前サイクルの `UI_CLOSED_DONE` を
    未 ack のまま**新サイクルのクローズを走らせ、トリガを「単なる前進」へ変異させると、
    前サイクル DONE の ack で解放が保存に先行して red）

    > 状態機械のユニットテストは host を trait で差し替えるため、**この仕込みは
    > 「実運用で再オープンが受理されるか」（UIH.2a 故障時の脱出条件の曖昧点）とは
    > 独立に構成できる。**
    > 規則が守られていることを検証するのであって、経路の到達可能性を検証するのではない。

    > 前項の変異（受領 vs 完結）は**取り違えの軸が違う**ため、これを殺せない。両方要る。

  - **`evt_arg` の publish が Release / Acquire で行われる**（`Relaxed` へ変異させて
    loom 等のモデル検証で競合が検出されること。TSan は別プロセス間の shm を追跡できないので
    in-process モデルで検証する）
  - 🔴 **host がイベントを seq 順に処理する**（s-1 を飛ばして s を先に ack する変異を入れると、
    child が s-1 のスロットを再利用して host の読み取りと競合し red）
  - 🔴 **`UI_CLOSED_DONE` が投函できるまで再試行される**（リングを満杯にしてタイムアウト
    完遂させ、再試行を落とす変異を入れると `close_plugin_ui` が完了せず red）
  - 🔴 **`OPEN_UI` のドレーンゲートが効いている**（`Closed` の語義の確定・本節冒頭）。
    **2方向で検証する**:
    - **DONE 未 ack のまま `OPEN_UI` を受理する変異**（ドレーン条件を外す）→ **red**
    - **初期 `Closed`（一度も開いていない）で `OPEN_UI` が受理される** → **green**
      — ドレーン条件が初回オープンを誤って弾かないことの確認。
      **片方向だけでは「常に拒否する」実装が通ってしまう**
  - **フェーズ A がメインスレッドをブロックしない**（ハンドラ内でブロッキング待機に変異させると
    SAVE_STATE が処理されずタイムアウトで red — UIH.2a ポリシー1 の検証）
  - **経路①が `windowShouldClose` で一旦拒否する**（`windowWillClose` へ変異させると
    解放より先にウィンドウが消えて red）
  - **`setFrame` が `attached` より前に呼ばれる**（順序を入れ替えると red）
  - **`UI_CLOSED` を取りこぼさない**（リングを単一スロットに変異させ、前サイクルの
    未 ack `UI_CLOSED_DONE` の上へ新サイクルの `UI_CLOSED` を投函させると、
    `close_plugin_ui` の完了判定が閉じず red）
  - **`dirty_epoch` の増分が届く**（child の `fetch_add` を外す変異 / host の `last_seen`
    更新を壊す変異で debounce checkpoint が発火せず red。#577 PR-B のテストと共有可）
  - 🔴 **`dirty_epoch` が respawn でリセットされない**（`reset_after_child_exit` に
    `dirty_epoch = 0` を足す変異を入れ、respawn 後の dirty が `last_seen` を超えるまで
    検出されないことで red）
  - 🔴 **規律3 を忠実に守る host モックで経路②を完走させる**（`cmd_seq == cmd_ack_seq` を
    待ってから次を投函する host で CLOSE_UI を送る。CLOSE_UI の受理 ack をフェーズ B へ
    遅らせる変異を入れると **hang して red**）

    > **この項目が最重要**: host モックが規律3 を守らず SAVE_STATE を平行投函してしまうと、
    > 循環待ちがあっても**全項目 green のまま出荷される**。「テストが通っても壊れている」の典型。

  - **`Closing` 中に child を kill → respawn** させ、host が手続きを中止して
    **登記を更新しない**ことを確認（登記を書く変異を入れると red）
  - **未 ack スロットへ上書き投函する変異**を入れると red（slot 再利用の不変条件・
    `PipelinedEffectHost::process_block` / `PipelinedInstrumentHost::process_block` の鏡像）
  - **host 停滞時にタイムアウトでクローズが完遂する**（タイムアウトを外す変異で
    `Closing` に無期限滞留 → red）
- 判定は解析で行い人間を介在させない。**computer-use は受け入れ E2E の主経路にしない**
  （CAP.7）

## UIH.9 前提となる是正 — ✅ 両項目とも解消済み（2026-07-30 実測確認・#474 P0）

本仕様の実装前提として要求していた是正2件は、**いずれも解消済みであることを実測確認した**
（確認対象 = main `ea692a0`）。経緯の記録として原文の要旨を残す:

1. **`orbit-vst3-effect-child` のバンドル欠落** — ✅ **解消済み（#548）**。
   - `scripts/copy-daemon-bin.sh` は 4 child すべて（clap/vst3 × effect/instrument）を
     bundle 前に再ビルドし（`:85-87`）、copy 対象にも含める（`:94-98`）
   - `release.yml` の post-package gate が出荷 `.vsix` に対して 4 child の存在と実行属性を
     検査する（欠落時は release を abort）
   - 是正時に要求していた**バンドル済み成果物への検証**も実装済み:
     `tests/vscode-extension/bundled-child-binaries.spec.ts`（#548 回帰ピン）が
     「daemon が spawn しうる child（台帳A・Rust ソースから導出）⊆ バンドル供給（台帳B）」の
     照合、release gate の CHILD_BIN 台帳照合、および **gate スクリプトの実走**（child を
     1つずつ欠かして非ゼロ終了することの確認）まで行う

2. **CLAP 側の `CLAP_EXT_STATE` 配線**（当初 `--state` は明示 `bail!`）— ✅ **解消済み**。
   `orbit-clap-effect-child` は `--state` を読み `ClapEffectProcessor::load(state_bytes)` へ
   渡し、`CMD_SAVE_STATE` → `capture_state()` も配線済み（instrument 側 #557 と対称）

---

_確立: 2026-07-28（#546 Phase 0 / #547）。改訂は owner 承認を要する。_
