# プロジェクトファイル仕様 v1

owner 確定（2026-07-28・Epic #546 Phase 0 / #547・#541）。プラグイン state の自動保存・
自動復元を担う `project.yaml` を規定する。

上位規範は [`../core/DESIGN_PRINCIPLES.md`](../core/DESIGN_PRINCIPLES.md)（特に §4「意図と
登記の分離」）、能力の定義は
[`PLUGIN_CAPABILITY_ABSTRACTION_v1.md`](PLUGIN_CAPABILITY_ABSTRACTION_v1.md)、
state の運搬経路は [`PLUGIN_UI_HOSTING_SPEC_v1.md`](PLUGIN_UI_HOSTING_SPEC_v1.md)（UIH.3）。

---

## PRJ.0 位置づけ

**DAW のプロジェクトファイルと同じ役割だが、生成も維持も暗黙・中身は人間が読めるテキスト。**

| | `.orbs`（楽譜） | `project.yaml`（登記簿） |
|---|---|---|
| 書くのは | 人間 / LLM | **機械（OrbitStudio）** |
| 内容 | **意図の宣言**（音楽的内容・プラグイン指定） | **環境と派生状態の登記** |
| 正本性 | プラグインが何か・どう鳴らすかは**ここだけ**が持つ | DSL と重なるフィールドを**持たない** |

**派生データを人間のファイルへ書き戻さない。** 自動保存される state は、ユーザーが
テキストを編集していないのに変わる。`.orbs` に書き戻すと保存のたびに楽譜が機械に
書き換えられ、ライブコーディングの編集と衝突する。

## PRJ.1 スキーマ

```yaml
version: 1
states:                      # インスタンス同一性（SC.5 の三つ組）→ state ファイル
  kick/instrument/kontakt-8/0: states/kick-instrument-kontakt-8-0.state
  kick/effect/reverb/0:        states/kick-effect-reverb-0.state
  kick/effect/reverb/1:        states/kick-effect-reverb-1.state
  lead/instrument/massive-x/0: states/lead-instrument-massive-x-0.state
audio:
  device: "..."              # PRJ.1a: DSL 宣言があればそちらが優先
  sample_rate: 48000
```

キーの構成 = **`<レシーバ>/<役割>/<正規化名>/<レシーバ内の同名出現順>`**。

```
mysong/
  mysong.orbs            ← 楽譜（テキスト・人間が書く）
  project.yaml           ← 登記簿（テキスト・機械が書く・diff 可能）
  states/
    kick-instrument-kontakt-8-0.state  ← state 本体（バイナリ・相対参照）
    kick-effect-reverb-0.state
```

- **バイナリを YAML へ埋め込まない**。Kontakt state は数十 MB 級。本体は `states/` の
  個別ファイル、マニフェストは参照のみ（git 管理と diff を壊さない）
- **`plugin:` フィールドを持たない**。`kick.instrument("Kontakt 8.vst3")` と二重になり
  正本が2つになる（drift 問題）
- `version:` で migration に備える

### 🔴 登記キーは SC.5 の三つ組で引く — チェーン位置ではない

**キーは [SIGNAL_CHAIN_DSL_SPEC_v1.md](SIGNAL_CHAIN_DSL_SPEC_v1.md) SC.5 規範(1) の
インスタンス同一性 = `(レシーバ, 正規化名, レシーバ内の同名出現順)` を使う。**

まず、シーケンス名だけでは足りない: `CAP-STATE-GET` / `CAP-STATE-SET` は**必須能力**であり、
CAP.6-2 により **effect も含めて全形式で揃える**対象である（CAP.0 は「effect の state は
引数すら無い」を是正対象として列挙している）。instrument 1 個 + effect N 個のチェーンを
表現できないと、UI から effect の音色を変えても登記できない。

**そして、チェーン位置（index）をキーにしてはならない。** SC.5 規範(4)(5) により、
ブロック再評価はチェーンを置き換え、コメントアウト → 再評価でプラグインはアンロードされる。
index はそのたびにずれる:

```
チェーン [reverb, delay]     → reverb=index 0, delay=index 1
reverb をコメントアウトして再評価 → delay=index 0

index キーなら delay に reverb の state が適用される
= 🔴 音色が黙って別のプラグインへ付け替わる silent failure
```

SC.5 の三つ組（名前 + 同名出現順）はこの操作に対して安定であり、**まさにそのために
名前ベースで定義されている**。

### UIH.5 の位置アドレスとの関係 — 層が違う

| | 用途 | 寿命 |
|---|---|---|
| **UIH.5 の位置アドレス** `(シーケンス名, chain index)` | 「**今この瞬間**どれを開くか」を指すコマンド引数 | 揮発（呼び出し1回） |
| **SC.5 の三つ組** | **同一性**。登記の永続キー | 永続 |

**位置アドレスは受理時に SC.5 同一性へ解決してから登記に使う。**
両者を同一視してはならない（初版は「同一でなければならない」と誤って規範化していた）。

> v1 で instrument に限定する選択肢もありうるが、その場合 CAP.6-2 と衝突する。
> **限定するなら CAP 側も同時に改訂すること**（片方だけ変えない）。

### PRJ.1a `audio:` と DSL の関係

`audio.device` は **DSL にも宣言経路がある**（`global.audioDevice(deviceName)` —
`packages/engine/src/core/global.ts:239` に実在。ただし
[`../core/INSTRUCTION_ORBITSCORE_DSL.md`](../core/INSTRUCTION_ORBITSCORE_DSL.md) には未記載）。

`plugin:` を排除した論理（正本が2つ → drift）がそのまま当てはまるため、**優先則を明文化する**:

```
.orbs の明示宣言（global.audioDevice(...)）  >  project.yaml の audio:
```

- `project.yaml` の `audio:` は**最後に使った環境の登記**であり、宣言が無い場合の既定値として
  働く（「この曲は前回このデバイスで鳴らした」の記録）
- DSL 宣言がある場合、登記は**更新するが権威にはしない**（PRJ.6 のフィンガープリントと同じ扱い）
- 食い違ったら warn して `.orbs` に従う

> **なぜ完全排除しないか**: デバイス名は**環境**であって意図ではなく、機材構成が変われば
> 曲を書き換えずに変わってほしい。一方 `global.audioDevice()` は「この曲はこのデバイスで」と
> 意図的に固定したい場合の表現である。両者は役割が違うので共存させ、優先則で drift を断つ。
> `plugin:`（純粋に意図側）とは事情が異なる。

## PRJ.2 管理モデル

1. **生成の儀式なし** — 「新規プロジェクト作成」メニューは作らない。最初に記録すべきもの
   （state 等）が発生した瞬間に `.orbs` の隣へ自動生成する。それまで存在しない
   （単一 `.orbs` の手軽さを完全に保つ・オプトイン原則の自然な実現）
2. **所有権は機械** — 書くのは原則 OrbitStudio。プレーン YAML なので人間はいつでも読める・
   緊急時は直せる
3. **書き込みは atomic**（tmp → rename）。読み込み時の破損は **loud エラー**（silent 無視しない）
4. **git 非関知** — `project.yaml` はテキストなので diff / git が自然に効く。`states/` の
   バイナリを版管理するかは利用者のリポジトリ運用の自由（OrbitStudio は `.gitignore` を書かない）
5. **LLM 対称** — MCP からプロジェクト読み取り・保存・state 一覧が可能

## PRJ.3 保存のタイミング — 離散セーフポイント方式（決定①）

**保存トリガは次の離散事象に固定する。**

| トリガ | 契機 |
|---|---|
| (a) 明示保存 | MCP / コマンドからの保存要求（対称設計の LLM 半身） |
| (b) UI クローズ時 | 人間が音色編集を終える自然な境界（UIH.4 の3経路すべて） |
| (c) 停止・終了時 | 演奏停止 / エンジン終了 |
| (d) 任意: プラグイン起点の dirty 通知受信時 | **最適化としてのみ**。これに依存した設計にしない。VST3 = `IComponentHandler2::setDirty`（+ `performEdit` によるパラメータ編集通知）、CLAP = `clap_host_state.mark_dirty`、AU = **無し**（CAP.3a）。**受け口のある形式では実装する**（CAP.6-6） |

### 変更検知ポーリングを採らない根拠

CAP.3 のとおり、**dirty 通知は VST3 / CLAP の両方に存在するが、双方ともプラグインが呼ぶ
義務を負わない**:

> VST3 `IComponentHandler2::setDirty` — *"Tells host that the plug-in is dirty (something
> besides parameters has changed since last save), if true the host should apply a save
> before quitting."*
>
> CLAP `clap_host_state.mark_dirty` — *"Tell the host that the plugin state has changed and
> should be saved again. If a parameter value changes, then it is implicit that the state
> is dirty. [main-thread]"*

VST3 側は `IComponentHandler2` 自体がホストのオプション実装であり、CLAP 側も拡張の
`get_extension` が null を返しうる。加えて**プラグインが呼ばない実装は規格違反ではない**。
したがって **dirty 通知に依存すると、呼ばないプラグインで音色が黙って失われる**。

**基本方式は離散セーフポイント**とし、dirty 通知は受け取ったらセーフポイントを1つ増やす
任意の最適化として扱う。

`getState` の出力をハッシュして差分を見る方式も採らない — Kontakt 級で数十 MB を定期取得
することになりコストが実態に合わず、取りこぼしても「検知している」ように見える
（silent failure）。

### respawn 時の巻き戻り防止

child crash → watchdog respawn の際、宣言時 state しか無いと**人間が UI で作った音色が
黙って巻き戻る**。(a)(b) により**常に最新の保存済み state が存在する**状態を保ち、
respawn はそれを適用する。

## PRJ.4 保存の手順

UIH.3 のサイドカー経路と組み合わせる。**確定（atomic rename）は host 側の責務。**

```
1. host  : 一時パスを決めて SAVE_STATE コマンドを投函
2. child : 一時パスへ書き込み → fsync → ack（バイト数つき）
3. host  : サイズ 0 / 失敗 ack なら 🔴 中断（登記を更新しない）
4. host  : states/<key>.state.tmp → states/<key>.state へ rename
           （<key> = インスタンス同一性から導く安全なファイル名。PRJ.1）
5. host  : project.yaml を tmp → rename で更新
```

**サイズ 0 の state を成功として登記しない。** 失敗時は前回の登記を保持する
（壊れた state で上書きして音色を失う方が、保存を1回落とすより悪い）。

## PRJ.5 復元の単位 — 「最後の状態のみ」（決定②）

**自動 state は登記キー（インスタンス・PRJ.1）あたり1つ（最後の状態）。
named states は v1 で実装しない。**

根拠:

- 受け入れ基準（#541）は「再起動で最後の状態が復元」であり、named states は要求されていない
- named states を入れると「**今どの名前が active か**」という第二の可変状態が生まれる。
  それは必ず「`.orbs` に書きたい」圧を生み、DESIGN_PRINCIPLES §4 の境界を内側から侵す
- 「音色を名前で再利用したい」需要は本物だが、**独自概念を足すのではなく規格側の
  preset / program を MCP に引き出して満たす**（`CAP-PRESET-LIST` / `CAP-PRESET-LOAD`）。
  §1「規格側のプログラマブル面は UI の有無にかかわらず MCP に出す」に一致する

将来 named を足す場合は `version:` の bump で移行する。

## PRJ.6 優先順位

```
.orbs の明示 statePath（持ち込み）  >  project.yaml の states:（自動復元）
```

DAW の「明示 preset ロード > プロジェクト保存状態」と同じ関係。

安全装置として、自動保存時にプラグインのフィンガープリント（path / pluginId）を state の
メタとして併記してよい。ただしそれは**検証用**であり、`.orbs` と食い違ったら warn して
`.orbs` に従う。**権威にはしない。**

> `.vstpreset` の DSL 明示指定はコアワークフローから外し、**互換入力に降格**する
> （外部 DAW での state authoring は却下済み・DESIGN_PRINCIPLES §2）。

## PRJ.7 規格の state コンテキストとの対応

CLAP は state の用途を規格として区別している（`clap-sys-0.5.0/src/ext/state_context.rs`）:

| 用途 | CLAP | AU | VST3 |
|---|---|---|---|
| **プロジェクト / ドキュメント保存** → `project.yaml` の `states:` | `CLAP_STATE_CONTEXT_FOR_PROJECT` | `fullStateForDocument` | 区別なし |
| **preset として保存** → `CAP-PRESET-*` 側 | `CLAP_STATE_CONTEXT_FOR_PRESET` | `fullState` | 区別なし |
| 複製 | `CLAP_STATE_CONTEXT_FOR_DUPLICATE` | — | — |

**3形式のうち2つ（CLAP・AU）が「ドキュメント保存」と「preset」を規格として区別している。**
AU の原文は *"Hosts saving documents should use this property"*（`fullStateForDocument`）と
ホストの取るべき側まで指定している。これは PRJ.5 の「自動 state は1つ / 名前付き再利用は
規格の preset で」という切り分けの、規格2つ分の裏付けになる。

VST3 には同等の区別が無いため、コンテキスト付き API は**あれば使う任意の改善**として扱い、
無い場合は `clap_plugin_state` / `IComponent::getState` にフォールバックする
（形式で挙動を変えないため、フォールバック側を基準の意味論とする）。

## PRJ.8 LLM 対称の MCP 面

| 操作 | MCP |
|---|---|
| プロジェクト読み取り | 登記内容と state 一覧を返す |
| 明示保存 | PRJ.3 (a) のトリガ |
| state 一覧 | インスタンス同一性（PRJ.1）→ 有無・サイズ・更新時刻 |
| 明示復元 | 登記済み state をプラグインへ再適用（PRJ.3 (a) の対）|

LLM が演奏セッションを自分で保存・復元できること。人間の面（自動保存）と**同じ state に
合流し、同じ機構で永続化される**。

## PRJ.9 検証

- **ループ通し E2E**: 宣言 → 音色変更（**UI 経路と API 経路の両方**）→ 終了 → 再起動 →
  同じ音で鳴る。これが green になるまで完成としない
- **VST3 と CLAP の両方**で同じ E2E が green（oracle synth で無人化）
- **オラクル synth に state 意味論を実装する**（state = 周波数オフセット等）。これにより
  以後のループ検証が無人で閉じる（[`../testing/E2E_HARNESS_SPEC.md`](../testing/E2E_HARNESS_SPEC.md) §7）
- 変異検証: 保存失敗時に登記を更新しないこと、サイズ 0 を成功扱いしないこと、
  3つの閉じる経路それぞれでセーフポイントがちょうど1回発火することを、
  それぞれ壊して red を確認してから積む

---

_確立: 2026-07-28（#546 Phase 0 / #547）。改訂は owner 承認を要する。_
