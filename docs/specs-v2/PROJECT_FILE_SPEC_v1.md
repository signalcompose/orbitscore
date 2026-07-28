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
states:                      # シーケンス名 → state ファイル（相対パス）
  kick: states/kick.state
  lead: states/lead.state
audio:
  device: "..."
  sample_rate: 48000
```

```
mysong/
  mysong.orbs            ← 楽譜（テキスト・人間が書く）
  project.yaml           ← 登記簿（テキスト・機械が書く・diff 可能）
  states/
    kick.state           ← state 本体（バイナリ・マニフェストから相対参照）
    lead.state
```

- **バイナリを YAML へ埋め込まない**。Kontakt state は数十 MB 級。本体は `states/` の
  個別ファイル、マニフェストは参照のみ（git 管理と diff を壊さない）
- **`plugin:` フィールドを持たない**。`kick.instrument("Kontakt 8.vst3")` と二重になり
  正本が2つになる（drift 問題）
- `version:` で migration に備える

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
| (d) 任意: CLAP `mark_dirty` 受信時 | **最適化としてのみ**。これに依存した設計にしない |

### 変更検知ポーリングを採らない根拠

CAP.3 のとおり、**VST3 には state dirty 通知が存在しない**（`IComponentHandler` は4メソッドに
閉じ、`RestartFlags` の `kParamValuesChanged` はパラメータ値キャッシュの無効化要求であって
「`getState` の出力が変わった」ではない）。一方 **CLAP には `mark_dirty` がある**:

> *"Tell the host that the plugin state has changed and should be saved again. If a parameter
> value changes, then it is implicit that the state is dirty. [main-thread]"*
> — `clap/ext/state.h`

したがって dirty 通知は**規格間で非対称**であり、これを基本方式に据えると形式ごとに
挙動が変わる（中核制約に反する）。**最弱の形式（VST3）で成立する方式を基本とし、
CLAP の `mark_dirty` はセーフポイントを1つ増やす任意の最適化として扱う。**

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
4. host  : states/<seq>.state.tmp → states/<seq>.state へ rename
5. host  : project.yaml を tmp → rename で更新
```

**サイズ 0 の state を成功として登記しない。** 失敗時は前回の登記を保持する
（壊れた state で上書きして音色を失う方が、保存を1回落とすより悪い）。

## PRJ.5 復元の単位 — 「最後の状態のみ」（決定②）

**自動 state はシーケンスあたり1つ（最後の状態）。named states は v1 で実装しない。**

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

| CLAP 定数 | 用途 | 本仕様での対応 |
|---|---|---|
| `CLAP_STATE_CONTEXT_FOR_PROJECT` | プロジェクト保存 | **`project.yaml` の `states:`** |
| `CLAP_STATE_CONTEXT_FOR_PRESET` | preset として保存 | `CAP-PRESET-*` 側 |
| `CLAP_STATE_CONTEXT_FOR_DUPLICATE` | 複製 | v1 では未使用 |

**規格側が既に「プロジェクト保存」と「preset」を区別している**ことは、PRJ.5 の
「自動 state は1つ / 名前付き再利用は規格の preset で」という切り分けの裏付けになる。

VST3 には同等の区別が無いため、`CLAP_EXT_STATE_CONTEXT` は**あれば使う任意の改善**として
扱い、無い場合は `clap_plugin_state` / `IComponent::getState` にフォールバックする
（形式で挙動を変えないため、フォールバック側を基準の意味論とする）。

## PRJ.8 LLM 対称の MCP 面

| 操作 | MCP |
|---|---|
| プロジェクト読み取り | 登記内容と state 一覧を返す |
| 明示保存 | PRJ.3 (a) のトリガ |
| state 一覧 | シーケンス名 → 有無・サイズ・更新時刻 |

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
