# macOS 開発機のセットアップ — テストが 34 倍遅くなる罠を先に潰す

**対象**: macOS（Apple Silicon）でこのリポジトリの Rust テストを回す人。
**所要**: 5 分。**やらないと `cargo test --workspace` が 37 分かかる**（やれば 66 秒）。

---

## 🔴 結論から

**システム設定 → プライバシーとセキュリティ → デベロッパツール**に
**使っているターミナル**（Ghostty / iTerm / Terminal など）を追加して **ON** にし、
**ターミナルを再起動**してから **`cargo clean`** する。

これだけで `cargo test --workspace` が **2,240 秒 → 66 秒**になる（2026-09-08 実測）。

---

## 何が起きているか

macOS は**新しく作られた実行ファイルを初回起動時にマルウェアスキャン**する。
担当は **`syspolicyd`**（Gatekeeper）と **`XprotectService`**。

`cargo test` はこの検査にとって**最悪のケース**である:

- テストバイナリは **1 回しか実行されない**（キャッシュが効く前に用済みになる）
- このワークスペースは **77 個**のテストバイナリを作る
- 🔴 **`XprotectService` はシングルスレッド**なので、**並列に起動しても検査は 1 本ずつ**

### 2026-09-08 の実測

| 内訳 | 時間 | 割合 |
|---|---|---|
| ビルド + リンク | 101 秒 | 5% |
| テスト自身の実行 | **80 秒** | 4% |
| 🔴 **バイナリ初回起動の検査** | **約 34 分** | **91%** |

**同じバイナリを 3 回起動した実測**:

```
run 1: 23.22 秒   ← 初回（検査）
run 2:  0.004 秒
run 3:  0.004 秒
```

CPU をサンプリングすると、前半 5 秒が `syspolicyd`、後半 6 秒が `XprotectService` だった。

---

## 手順

### 1. ターミナルをデベロッパツールに登録する

**システム設定 → プライバシーとセキュリティ → デベロッパツール** で、
**実際に `cargo` を起動するアプリ**を `+` で追加し、**トグルを ON**。

🔴 **「実際に起動するアプリ」を間違えないこと。** ターミナル多重化ツール（`herdr` / `tmux` 等）を
使っている場合、`ps` で祖先を辿って確認する:

```bash
pid=$$; for i in $(seq 1 8); do
  l=$(ps -o pid=,ppid=,comm= -p $pid) || break
  echo "$l"; pid=$(echo "$l" | awk '{print $2}'); [ "$pid" = "1" ] && break
done
```

⚠️ `sudo spctl developer-mode enable-terminal` は **`Terminal.app` を追加するだけ**で、
**トグルは ON にならない**（コマンド自身が "Enable in the Privacy & Security Settings" と言う）。
Ghostty など別のターミナルを使っているなら**この操作は無関係**。

### 2. ターミナルを完全に再起動する

権限は**プロセス起動時**に読まれる。`Cmd+Q` で終了してから開き直す。
ウィンドウを閉じるだけでは足りない。

### 3. 🔴 `cargo clean` する

**ここを飛ばすと効かない。** 設定は「**これから作られるバイナリ**」にしか効かず、
`target` に残っている成果物は**設定前のまま**なので検査され続ける。

```bash
cargo clean --manifest-path rust/Cargo.toml
```

⚠️ `target` は数十 GB になることがある（2026-09-08 時点で **71 GB**）。削除だけで数分かかる。

### 4. 効果を確認する

```bash
time cargo test --manifest-path rust/Cargo.toml --workspace --locked
```

**66 秒前後**なら成功。**30 分超**なら効いていないので、手順 1 のアプリ指定を見直す。

---

## トレードオフ

この設定は「**そのターミナルから起動するものはマルウェアスキャンしない**」という意味である。

- 効果: テストサイクルが **34 倍**速い
- 副作用: **そのターミナル配下で起動するものが検査されない**
- 範囲: 登録したアプリの配下のみ（Finder やブラウザからの起動は従来どおり検査される）

開発機で自分がビルドしたものを走らせる用途では一般的な選択で、Rust コミュニティでも推奨されている。
**判断は各自で。**

---

## 効かなかったもの（試す必要なし）

| 手 | 結果 |
|---|---|
| `codesign -v` で事前に検証 | ❌ 13.6 秒かけても初回起動は 76 秒。**署名検証と実行時スキャンは別物** |
| バイナリを並列に起動して warm up | ❌ **`XprotectService` がシングルスレッド**なので並列化しても直列に処理される |
| `sudo spctl developer-mode enable-terminal` 単独 | ❌ Terminal.app を追加するだけ。トグルも ON にならない |
| `cargo clean` なしで設定だけ | ❌ 既存の `target` の成果物には効かない |

⚠️ **並列 warm up を自作するのは危険**でもある。`--list` を渡しても、テストバイナリではない
実行ファイル（`orbit-plugin-scan` / `sandbox-effect-child` 等）は**引数を無視して本体として起動する**。
2026-09-08 に実際にやってしまい、8 分以上走り続けた。

---

## 参照

- [Faster Rust builds on Mac — Nicholas Nethercote](https://nnethercote.github.io/2025/09/04/faster-rust-builds-on-mac.html)
- [macOS — cargo-nextest](https://nexte.st/docs/installation/macos/)（"You may also need to run `cargo clean` afterwards."）
- [Mac App Launches Slowed by Malware Scan — Michael Tsai](https://mjtsai.com/blog/2024/02/15/mac-app-launches-slowed-by-malware-scan/)
- このリポジトリ内の先例: `orbit-audio-sandbox/src/child.rs:107` の `warm_up_executable`
  （#520。**個別のテストには対策済みだったが、テストサイクル全体には効いていなかった**）
