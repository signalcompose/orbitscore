# 設計: エンジンの真実を出す・設定を一覧する・性能を測る（#662 A〜E / #661 / #660 / #667 / #663 / #368 / #156）

**対象 issue**: #662（傘・バッチ A〜E）/ **#661**（`--audio-device` 無音・`must-fix`）/ #660（`list_audio_devices` 誤報）/ #667（child の busy-wait）/ #663（プール上限の撤廃）/ #368（`ORBIT_OUTPUT_BUFFER_FRAMES`）/ #156（env prefix 統一）/ 吸収先 #483・#484・#503
**正本**: [`docs/design/662-engine-visibility-and-limits.md`](662-engine-visibility-and-limits.md)（原則・レイテンシー = 余裕・上限撤廃の形・restart 属性・設定 UX）。**本書はそれを再設計しない。** 2026-09-03 の owner 指示（**性能を独立の軸にする / 設定変数を一覧する / 数値目標は置かない**）を載せた**差分**と、**PR 分割**だけを書く。
**関連**: 地図 §4.H・§4.H.1（949-1010）/ §4.I（1011-1041）/ §4.O・§4.O.1（1132-1209）/ §7 (12)（1383）/ §9 / [`694-session-log-editor-path-design.md`](694-session-log-editor-path-design.md) §12
**状態**: 設計（実装しない）・2026-09-03・main `ca176f0` 実測

---

## 0. 裁定・確定事項（再議論しない）

| # | 確定 | 出どころ |
|---|---|---|
| 1 | **エンジンが知っていることは、原則ユーザーにも見せる**。LLM は第一級ユーザーなので、パネルに出すものは MCP からも取れる | 662 設計 §1 |
| 2 | レイテンシーは値でなく**締切に対する使用率**（ピーク + 平均 + ドロップアウト） | 662 設計 §2 |
| 3 | 上限撤廃は **off-thread 確保 + atomic 差し替え + 世代退役**（定数を大きくするのは解決でない・RT で確保しない） | 662 設計 §3・#663 |
| 4 | **余裕の表示（B）が上限撤廃（D）より先。** 逆にしない | 662 設計 §3.4・#663 |
| 5 | 「再起動が必要」は**検証済みの属性**。一律に警告を出さない。未検証は「未検証」と書く | 662 設計 §6 |
| 6 | ライブ変更の実装範囲に **「切り替わったことの確認」** を含める | 662 設計 §6.2 |
| 7 | 実施は issue の境界でなく**同じコードに触る単位**（A→B→C→D→E・実害の順 B > C > D） | 662 設計 §8・#662 |
| 8 | **#667 → #663**（1 プラグイン = 1 コアのままでは上限を外しても増やせない） | #667 §2・#663 チェックリスト |
| 9 | 性能は独立の軸。ただし**数値目標は置かない**（「何を測るか」を書く） | 地図 §4.O・本書ブリーフ |
| 10 | 上限を決めない対象に **トラック / インスト / Link** は含む。**1 ラインの出口の個数と render bus 16 は #663 ではなく #649 / #611** | 地図 §4.H・#663 チェックリスト |

---

## 1. 到達点（1 文）

**OrbitStudio の Engine ビューと MCP `get_engine_state` が、`GetStatus` という 1 つの供給源から「掴んでいるデバイス名・実効サンプルレート / バッファ・コールバックが回っているか・締切に対する使用率・child の PID と生死・各設定変数の実効値」を同じ内容で返し、`--audio-device` を指定しても音が出て、idle の child が 1 コアを食い切らず、プール上限がユーザーから見えなくなる。**

---

## 2. 現在地（一次情報・本書が変えるもの）

| 事実 | 根拠（main `ca176f0`） | 本書 |
|---|---|---|
| `GetStatus` は**状態だけ 8 個**（`daemon_version` / `protocol_version` / `output_sample_rate` / `output_channels` / `loaded_samples` / `active_plays` / `uptime_sec` / `render_contentions`） | `rust/crates/orbit-audio-daemon/src/session.rs:1349-1360` | §4 で拡張（**追加のみ・改名しない**） |
| **掴んだデバイス名をどこにも保持していない**（`resolve_output_device` の戻り値は `Device` のみ・名前は捨てられる） | `rust/crates/orbit-audio-native/src/output.rs:168-217` / `:1380-1470` | §4.1 で記録 |
| `output_sample_rate()` / `output_channels()` は **build 時の値を返す固定フィールド** | `engine_wrap.rs:7865` / `:7903`（`self.sample_rate` / `self.channels`） | §4.1 🔴 デバイス切替後に**嘘になる** |
| `apply_device_switch` は `rebuild_output_stream` の結果を代入するだけ。**新レートを wrap に書き戻さない・コールバック生存を確認しない** | `engine_wrap.rs:4857-4882` | §5.3 |
| `rebuild_output_stream` は **engine を作り直さない**（`Engine::new` は `start_output_inner` のみ）。insert bus の buffer 再確保（`ensure_buffer_len`）も呼ばない | `output.rs:1473-1508` vs `:1404-1432` | §5.3 の失敗モード表 |
| コールバック回数は `CallbackTimeStats.callback_count` にある。ただし **`callback_timing` が true の経路だけ**（`post` 経路 = 本番）で、hardware-only / link 経路は `None` | `post_processor.rs:38-52` / `output.rs:1431`（`callback_timing.then(...)`） | §4.2 で `StreamStats` へ移し**無条件**に |
| `StreamStats` は `xruns` / `buffer_underruns` / `device_lost` / `render_contentions` を持つが、**`GetStatus` は最後の 1 つしか返さない** | `output.rs:28-33` / `:82-88` / `session.rs:1357` | §4.2 |
| 起動引数は **`--audio-device` と `--list-audio-devices` の 2 つだけ** | `main.rs:83` / `:91` / `:187-213` | 不変 |
| `--audio-device` は **`std::env::set_var("ORBIT_AUDIO_DEVICE")` を経由**して `device_name_from_env()` が読み直す | `main.rs:200-207` → `engine_wrap.rs:4173-4186` | §5.2 候補 C2（typed 引数化で往復を消す） |
| 🔴 その `set_var` の SAFETY コメントは「他スレッド生成前・単一スレッド」と書くが、**`#[tokio::main(flavor = "multi_thread", worker_threads = 2)]` が既に worker を起動している** | `main.rs:32` vs `main.rs:202-206` | §5.2 C2 |
| `ListAudioDevices` RPC は daemon 側**実装済み**。`--list-audio-devices` 軽量モードも実装済み | `session.rs:1303-1325` / `main.rs:215-` | §6（拡張が繋いでいないだけ） |
| 拡張は既に `--list-audio-devices` を叩く関数を持つ | `packages/vscode-extension/src/extension.ts:1733-1766` `fetchAudioDevicesForView()` | §6 でそのまま流用 |
| MCP `list_audio_devices` は rust なら**即エラー**（SC 時代のまま） | `extension.ts:3223-3230` | §6 |
| MCP `get_engine_state` が返すのは **`{running, liveCoding}` の 2 bool だけ** | `mcp-server.ts:596-602` / `EngineState` は `:107-110` / 実装 `extension.ts:3168-3173` | §7.2 |
| Engine ビューは TreeView（`orbitscore.engineView`）。データ整形は vscode 非依存に分離済み | `extension.ts:392-397` / `:1779-1830` / `engine-view.ts` | §7.1（ガワは E = #503） |
| 拡張 ↔ engine は **メタ行 + 相関 JSON 1 行**の帯域外チャネル（`//#selectAudioDevice` → `{"selectAudioDevice":{...}}`） | `repl-mode.ts:82-95` / `:262-287` / `device-switch-bridge.ts:20-70` / `engine-view.ts:218-241` | §7.1 で `//#engineStatus` を同型で足す |
| engine 側に daemon 状態の入口はある（`@internal`・呼び出し元 0） | `rust-engine-player.ts:1793-1795` `getDaemonStatus()` → `daemon-client.ts:716-718` | §7.1 で公開経路にする |
| child 5 種の待ちは**全部同じ形**（`load(Acquire)` → `cur <= last` なら `spin_loop()`） | §14 の grep | §9 で 1 箇所に畳む |
| child の audio thread は **QoS を設定している**（`QOS_CLASS_USER_INTERACTIVE`） | `rust/crates/orbit-child-runtime/src/lib.rs:521-533` | §9 🔴 #667 本文の「RT 優先度も設定されていない」は**不正確** |
| host（daemon RT）は child を**待たない**（1 block パイプライン・`seq_tag[slot(submitted-1)]` を読む） | `orbit-audio-sandbox/src/host.rs:90-140` / `instrument_host.rs:270-300` / `transport.rs:4-24` | §9（待ちを直すのは child 側だけ） |
| 本番 daemon の feature は `outproc-effect,outproc-instrument` | `package.json:18` / `scripts/copy-daemon-bin.sh:109` | §4 の経路特定 |
| 本番ソースの env は **32 個**（33 ではない） | §14 の grep + §8 の表 | §8 🔴 地図 §4.H.1 / #662 チェックリストの「33 個」は **`ORBITSCORE_DSL` の誤検出**を含む |
| capture 有効時は**デバイス切替を明示拒否**する | `engine_wrap.rs:4816-4822` | §12 の E2E 設計を縛る |
| daemon の 1 Hz ticker が `device_lost` / xrun / child 異常を event 化している | `session.rs:720-800` | §4.2 のコールバック停止検知の置き場 |
| `ORBIT_OUTPUT_BUFFER_FRAMES` は**未実装**（読み出し 0 件） | §14 の grep（`start_output_inner` は `buffer_frames` 引数のみ） | §11（owner 未決 → §17 (4)） |

---

## 3. 本書と正本設計の差分（何を足すか）

`662-engine-visibility-and-limits.md` は **原則と形**を決めた。2026-09-03 の owner 指示で足りなくなったのは次の 3 点だけ。

| 足すもの | 正本のどこに接ぐか | 節 |
|---|---|---|
| **設定変数の一覧**（正本は個別の設定 5 項目しか扱っていない。env に触れるのは capture の 1 行） | §4「棚卸し」の隣に「設定の実効値」を並べる | §4.3 / §8 |
| **性能を測る手段**（正本 §2 は出力コールバックの余裕まで。スレッド構成・CPU・RSS・child の内訳は無い） | §2 の外側に「プロセスとメモリ」を足す | §10 |
| **PR 分割**（正本 §8 はバッチまで。PR の粒度・依存・一方通行の別が無い） | — | §15 |

**正本が既に決めていることは本書で繰り返さない**（余裕の出し方 §2 / 上限撤廃の形 §3 / restart 属性 §6 / 設定 UX §7）。

---

## 4. バッチ A — `GetStatus` に真実を載せる

**A が全体の前提。** 表示（B）も操作（C）も、daemon が真実を返さないと作れない。**供給源は 1 本**（拡張の Engine ビューと MCP `get_engine_state` が同じ JSON を見る）。

### 4.1 wire（`session.rs:1349-1360` を置き換える）

既存 8 フィールドは**そのまま残す**（`rust-engine-player.ts:573` が `uptime_sec` を、kill-test が `loaded_samples` / `active_plays` を読む）。追加は**入れ子 4 つ**にする。**追加のみ・改名なし ⇒ 一方通行ではない**（`PROTOCOL_VERSION = "0.2"`・`protocol.rs:8` は据え置き）。

```jsonc
{
  // 既存 8 個（不変）
  "daemon_version": "...", "protocol_version": "0.2",
  "output_sample_rate": 48000, "output_channels": 2,
  "loaded_samples": 3, "active_plays": 0, "uptime_sec": 12.5, "render_contentions": 0,

  "output": {                      // §4.1
    "device_name": "MacBook Proのスピーカー",   // 実際に掴んだ名前
    "device_requested": "外部ヘッドフォン",      // 要求（未指定なら null）
    "device_fell_back": true,                  // requested != device_name
    "sample_rate": 48000,                      // 現ストリームの実効値（切替後も正しい）
    "channels": 2,
    "sample_format": "f32",
    "buffer_frames_requested": null,           // BufferSize::Fixed を要求したか
    "buffer_frames_observed": 512              // 直近コールバックの data.len()/channels
  },
  "callback": {                    // §4.2
    "count": 41231,                            // 🔴 0 のまま = ストリームが死んでいる
    "alive": true,                             // 直近 1 s で count が進んだか
    "deadline_ns": 10666666,                   // buffer_frames_observed / sample_rate
    "mean_ns": 3100000, "max_ns": 7400000, "p99_ns": 5200000, "min_ns": 900000,
    "load_mean": 0.29, "load_peak": 0.69,      // 所要時間 ÷ 締切（正本 §2）
    "xruns": 0, "buffer_underruns": 0, "device_lost": false
  },
  "capture": { "enabled": false, "path": null },   // §4.3
  "config": {                      // §4.3 設定の実効値（未設定なら既定）
    "sum_bus_pool": 4, "aux_bus_pool": 4, "effect_bus_pool": 8,
    "effect_buses": ["master"], "instrument_slots": 8,
    "instrument_buffer_frames": null, "effect_buffer_frames": null,
    "limits": { "insert_bus_stages": 64, "source_slots": 32,
                "source_units": 16, "link_channels": 64, "instrument_slots_max": 32 },
    "used":   { "insert_bus_stages": 5, "instrument_slots": 2 }
  },
  "children": [                    // §4.4（#483 / #484 のプロセス表示の供給源）
    { "pid": 44317, "role": "instrument", "key": "plugin:piano",
      "alive": true, "respawns": 0 }
  ]
}
```

### 4.1 出力デバイスの真実（供給元）

| field | 型 | 供給元 | 現在地 |
|---|---|---|---|
| `output.device_name` | `String` | `resolve_output_device` が選んだ `Device::name()` | 🔴 **捨てられている**（`output.rs:168-217` は `Device` だけ返す）→ `OutputStream` に `device_name: String` を足し、`start_output_inner`（`output.rs:1380`）/ `rebuild_output_stream`（`:1473`）の両方で埋める |
| `output.device_requested` | `Option<String>` | `device_name_from_env()` | `engine_wrap.rs:4173-4186` |
| `output.device_fell_back` | `bool` | 上 2 つの比較 | 🔴 縮退は現在 **stderr の警告 1 行だけ**（`output.rs:203-211` / `:214-218`）。#661 の「静かに壊れる」の一部 |
| `output.sample_rate` / `channels` | `u32` / `u16` | `OutputStream.sample_rate` / `.channels` | 🔴 現在 `GetStatus` は `EngineWrap` の**固定フィールド**を返す（`engine_wrap.rs:7865` / `:7903`）。`apply_device_switch`（`:4857`）が更新しないので**切替後に嘘になる** → wrap 側を `Mutex<StreamConfigSnapshot>` にし、`record_stream_config`（`:4786-4801`）と `apply_device_switch` の**両方**で書く |
| `output.buffer_frames_requested` | `Option<u32>` | `EngineWrap.output_buffer_frames` | `engine_wrap.rs:1629` |
| `output.buffer_frames_observed` | `u32` | **コールバックが受け取った `data.len() / channels`** | 新規。`BufferSize::Default` では cpal が実フレーム数を返さないので、**観測が唯一の実効値**。RT では `AtomicU32::store(Relaxed)` 1 回 |

### 4.2 コールバックの生存と余裕（#661 の発見遅れを構造的に潰す）

🔴 **`callback_count` を `CallbackTimeStats` から `StreamStats` へ移す**（型で潰す）。

理由: 今は `callback_timing` が true の経路にしか存在しない（`output.rs:1431`）。本番は post 経路なので実在するが、**「経路によっては生存を測れない」形のまま #661 の再発防止を建てると、別の start 経路が増えた瞬間に穴が開く**。`StreamStats` は全経路で必ず作られる（`output.rs:1428`）。

```rust
// rust/crates/orbit-audio-native/src/output.rs（StreamStats に追加・:28-33）
pub struct StreamStats {
    xruns: AtomicU64,
    buffer_underruns: AtomicU64,
    device_lost: AtomicBool,
    render_contentions: AtomicU64,
    /// コールバックが 1 回回るごとに +1（RT: Relaxed fetch_add のみ）。
    /// 🔴 0 のまま = ストリームは構築されたが CoreAudio が IOProc を回していない（#661）。
    callbacks: AtomicU64,
    /// 直近コールバックの frames（`BufferSize::Default` 時の実効バッファ長）。
    last_frames: AtomicU32,
}
```

`callback.alive` の判定は **daemon の 1 Hz ticker**（`session.rs:720-800`・`device_lost` と同じ場所）が前回値との差で持つ。`GetStatus` はその bool を読むだけ（RPC ごとに時間窓を持たない）。

**ticker に「コールバック停止」の event を足す**（正本 §4 の「コールバックが止まっていること」）:

| 条件 | severity | code | 根拠 |
|---|---|---|---|
| ストリーム開始後、`callbacks` が **一度も** 進まない | `fatal` | `STREAM_CALLBACK_DEAD` | #661 そのもの |
| 走行中に `callbacks` が 1 tick 進まない | `warning` → 継続で `fatal` | `STREAM_CALLBACK_STALLED` | device 抜線・スリープ復帰 |

`load_mean` / `load_peak` は **daemon 側で計算する**（`mean_ns / deadline_ns`）。締切の分母 `buffer_frames_observed` は daemon しか知らないため、TS 側で再計算すると 2 つの真実ができる。

### 4.3 設定の実効値（未設定なら既定）

**env の生値ではなく実効値を返す。** 読み手に既定値の再導出を強いない（地図 §4.H.1 論点 5）。

| field | 既定 | 解決関数 |
|---|---|---|
| `config.sum_bus_pool` | 4 | `sum_bus_pool_from_env()` `engine_wrap.rs:1993-1999`（既定 `:1972`） |
| `config.aux_bus_pool` | 4 | `aux_bus_pool_from_env()` `:2002-2008`（既定 `:1975`） |
| `config.effect_bus_pool` | 8 | `parse_effect_bus_pool_size` `:1923-` / 読み `:1945`（既定 `:1910`） |
| `config.effect_buses` | `["master"]` 相当 | `:1941`（`ORBIT_EFFECT_BUSES`） |
| `config.instrument_slots` | 8 | `parse_instrument_slots` / 読み `outproc_instrument.rs:105`（既定 `:87`） |
| `config.limits.*` | — | `output.rs:343` / `:347` / `:350` / `:353` / `outproc_instrument.rs:89` |
| `capture.enabled` / `.path` | 無効 | `capture_path_from_env()` `engine_wrap.rs:4153-4167` |

🔴 **`capture.enabled` は表示のためだけではない** — capture が有効だとデバイス切替が拒否される（`engine_wrap.rs:4816-4822`）。UI が切替を出す前に、この 1 つで理由を説明できる（正本 §7.5「変えられないものには理由を出す」）。

### 4.4 child のプロセス（#483 の供給源）

daemon は supervisor 経由で child の PID・生死・respawn 回数を知っている。**CPU / RSS は返さない。**

**決定（地図 §4.O (4) の「どちらの供給源にするか」）: identity は daemon、CPU / RSS は拡張の `ps`。**

| 何 | どこから | 理由 |
|---|---|---|
| PID・role・key（`plugin:<seqName>`）・alive・respawn 回数 | `GetStatus.children`（daemon） | daemon しか知らない。`ps` からは役割が読めない（プロセス名は全部 `orbit-vst3-instrument-child`・正本 §10） |
| %CPU・RSS | 拡張が `ps -o pid,%cpu,rss -p <pids>` | %CPU は**サンプル間の差分**なので poller が要る。daemon に poller を足すより、既に子プロセスを spawn している拡張（`extension.ts:1743`）に置く方が薄い。**#667 が根拠に使った数値と同じ出どころ**になり、突き合わせができる |

---

## 5. #661 — `--audio-device` で無音（`must-fix`）

### 5.1 🔴 原因はソースからは確定できない

issue にあるのは**観測**（daemon CPU 0.0% / 縮退警告なし / child は 95〜99% でレンダリング中）であって原因ではない。**推測で修正箇所を決めない。** 以下は候補と、**それぞれを潰す実験**。

| # | 候補 | 根拠 | 反証 / 確定の方法 |
|---|---|---|---|
| **C1** | サンプルレート不一致 | issue「直すべきこと 3」 | **ほぼ否定できる**: `start_output_inner` は解決後の device の `default_output_config()` から `sample_rate` を取り、`Engine::new(sample_rate, channels)` もその値で作る（`output.rs:1394-1432`）。起動経路にレート不一致は構造的に無い。**ただし切替経路には在る**（§5.3） |
| **C2** | `--audio-device` → `set_var` → 読み直しの往復が壊れる | `main.rs:200-207` の SAFETY コメントが「単一スレッド」と書くが、`main.rs:32` の `#[tokio::main(flavor="multi_thread", worker_threads=2)]` が既に worker を起動している | **往復自体を消して確認する**（§5.2）。消せば候補が 1 つ減る |
| **C3** | 🔴 **最有力**: `host.devices()` から得た `Device` で開いたストリームを CoreAudio が回さない | `resolve_output_device` は `requested` が `Some` なら**常に列挙経由**で `Device` を作る（`output.rs:180-197`）。`None` なら `host.default_output_device()`（`:172`）。**#661 で指定した `外部ヘッドフォン` は `isDefault: true`**（issue の `--list-audio-devices` 出力）— つまり**動く場合と動かない場合で違うのは「Device の入手方法」だけ** | 起動ログに解決後の device 名 / config / sample_format と、開始 N ms 後の `callbacks` を出す（§5.2 の 1）。C3 なら「requested == 既定デバイス名のとき `default_output_device()` を使う」で `callbacks` が回り出す |

### 5.2 直すもの（原因が C1/C2/C3 のどれでも要る）

1. **起動時に掴んだ構成をログへ**（issue の直すべきこと 2・正本 §4 最終行）。現在 `[daemon]` は `listening` と `accepted connection` の 2 行だけ（`main.rs:128` 付近）。
   出す: `requested` / `resolved` / `fell_back` / `sample_rate` / `channels` / `sample_format` / `buffer_size` / **最初のコールバックまでの実測 ms**。
   🔴 **これは診断であると同時に §5.1 の実験そのもの**。原因調査のために別の一時コードを書かない。
2. **コールバックが回らないストリームを「起動成功」にしない**（issue の直すべきこと 1）。
   `start_output_inner` の `stream.play()` 直後に `stats.callbacks` が進むまで待つ。進まなければ **host 既定へ 1 回だけ縮退して再試行**し、それも死んでいれば `OutputError` を返して `report_startup_failure`（`main.rs:100-103`）で**非ゼロ exit + StartupError**。無音で立ち上がらない。
   ⚠️ **待ち時間の予算**: client 側の起動タイムアウトは `DEFAULT_STARTUP_TIMEOUT_MS = 10_000`（`daemon-client.ts:86`）。**本書では待ち値を置かない** — 上の 1 が出す「最初のコールバックまでの実測 ms」の分布を見てから決める（数値目標を推測で置かない）。
3. **`--audio-device` の env 往復を消す**（C2 を候補から外す）。
   `main.rs` が `parse_audio_device_arg` の結果を `EngineWrap::start*(…, device: Option<String>)` へ**型で渡す**。`ORBIT_AUDIO_DEVICE` 自体は残す（env 単独起動の経路がある）が、**CLI 引数は env を経由しない**。
   これは既存の層分けの原則そのもの（`engine_wrap.rs:4149-4152`「env 読取りは daemon 層に集約し、native へは解決済み値を渡す」）に沿う — 現状は CLI → env → 読み直しで**その原則を一周して破っている**。

### 5.3 切替後の確認（正本 §6.2 の実装範囲）

`apply_device_switch`（`engine_wrap.rs:4857-4882`）に**確認とロールバック**を足す。

🔴 **「確認してから差し替える」は採れない。** `rebuild_output_stream` は `render_state` と `engine` を**新旧ストリームで共有**する（`output.rs:1473-1479`）。新ストリームを play したまま確認のために待つと、**2 つのコールバックが同じ engine を進める**（トランスポートが 2 倍速・音が 2 デバイスへ分裂）。現在この窓が極小なのは、play の直後に代入しているから。

| 案 | 手順 | 判断 |
|---|---|---|
| **A（推奨）** | 旧 stream を `pause()` → 新 stream を build + play → `callbacks` の前進を確認 → 成功なら旧を drop / 失敗なら**新を捨てて旧を `play()` 再開** | 二重レンダの窓が無い。cpal の `Stream::pause()` / `play()` を使う |
| B | 代入してから確認 → 失敗なら**直前のデバイス名**で再構築 | `previous_device` の保持が要る。復帰も失敗したら FATAL event（`session.rs:765` と同じ形）を出す |

**どちらでも `output.sample_rate` / `channels` / `device_name` を wrap へ書き戻す**（§4.1）。書き戻さないと `GetStatus` が嘘をつく。

🔴 **切替後にレート / チャンネル数が変わる場合の未検証点**: `rebuild_output_stream` は `Engine` を作り直さず、insert bus の `ensure_buffer_len`（`output.rs:1404-1409`）も呼ばない。**レートが上がる / チャンネルが増えるデバイスへ切り替えたときの挙動は未確認**。§13 の失敗モード表に置き、**バッチ D で実測して属性を確定させる**（正本 §6「未検証は未検証と書く」）。

---

## 6. #660 — `list_audio_devices` の誤報

**1 箇所**。`extension.ts:3223-3230` の rust 分岐を、ビューが既に使っている `fetchAudioDevicesForView()`（`extension.ts:1733-1766`）へ差し替える。SC 経路（`:3231-3246`）はそのまま。

```ts
async function listAudioDevicesForAgent(): Promise<AudioDevicesResult> {
  if (getConfiguredEngineKind() === 'rust') {
    try {
      const devices = await fetchAudioDevicesForView()   // daemon の --list-audio-devices
      return { ok: true, devices: devices.map(toMcpAudioDeviceInfo) }
    } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  }
  …既存の SC 経路…
}
```

🔴 **型が合わない**: MCP の `AudioDeviceInfo` は SC 由来で `{label, id: number, description}`（`mcp-server.ts:113-117`）、daemon 側は `{name, isDefault, maxOutputChannels, defaultSampleRate, direction}`（`output.rs:106-113` / `session.rs:1307-1315`）。**`id: number` は cpal に存在しない。**

| 案 | 内容 | 判断 |
|---|---|---|
| **A（推奨）** | `AudioDeviceInfo` に **`name` / `isDefault` / `maxOutputChannels` / `defaultSampleRate` を任意フィールドで足し**、`id` を optional にする。rust 経路は `label = name`・`id` 省略 | LLM が `select_audio_device` に渡すのは**名前**（`selectAudioDeviceForAgent` は `device: string`・`extension.ts:3254`）なので、`id` は rust 経路で不要 |
| B | 別ツール `list_audio_devices_native` を足す | 🔴 却下。#660 の「片翼状態」を 2 つに増やす |

**ユーザードキュメント**（`sites/user/getting-started/engine-settings.md` 日英）は #660 の「やること」に含まれるが、**バッチ A の PR ではなく B の完了時に書く**（B でバッファ / レートの現状が確定するため。§15 PR-6）。

---

## 7. バッチ B — 見える化（実害はここ）

### 7.1 データの通り道 1 本（端から端まで）

```
cpal callback (RT)
  └ stats.callbacks.fetch_add(1, Relaxed) / last_frames.store(n, Relaxed)   ← output.rs build_stream:1517-
     cb_stats.record(elapsed_ns)                                             ← post_processor.rs:66-74
        ↓
EngineWrap（1 Hz ticker が alive 判定・stream config snapshot を保持）       ← session.rs:720-800 / engine_wrap.rs:4786
        ↓  GetStatus RPC                                                     ← session.rs:1349
DaemonClient.getStatus()                                                     ← daemon-client.ts:716
        ↓
RustEnginePlayer.getDaemonStatus()（@internal を解除）                        ← rust-engine-player.ts:1793
        ↓  REPL メタ行 `//#engineStatus` → stdout に `{"engineStatus":{…}}`   ← repl-mode.ts（:262-287 と同型・新規）
        ↓
EngineStatusBridge（FIFO + timeout + drainAll）                              ← device-switch-bridge.ts:20-70 と同型・新規
        ↓
 ├→ EngineViewProvider.refresh() → TreeView の行                             ← extension.ts:1779-1830
 └→ MCP get_engine_state                                                     ← mcp-server.ts:596 / extension.ts:3168
```

🔴 **`get_engine_state` は現在 `{running, liveCoding}` の 2 bool**。ここに `daemon` を足す（**追加のみ**）:

```ts
// packages/vscode-extension/src/mcp-server.ts:107-110
export interface EngineState {
  running: boolean
  liveCoding: boolean
  /** daemon の GetStatus スナップショット。engine 停止中・取得失敗時は undefined（嘘を返さない）。 */
  daemon?: DaemonStatusSnapshot
  /** daemon 状態が取れなかった理由（running なのに undefined のとき必ず入る）。 */
  daemonError?: string
}
```

**`daemon` を取れないときに古い値や既定値を返さない。** #661 は「正常に見える画面」で 1 時間が溶けた故障なので、**不明は不明と出す**（正本 §1）。

### 7.2 何を出すか（正本 §2 / §4 / §7 の適用先）

| 行 | 値 | 帰結（正本 §7: 数値を単独で出さない） |
|---|---|---|
| Output Device | `output.device_name` | `device_fell_back` なら **「要求: X → 実際: Y」** を同じ行に |
| Callback | `callback.alive` | 🔴 **停止時は最上段に赤で 1 行**（「コールバックが回っていません」）。daemon CPU 0.0% を人が読む形にしない |
| Headroom | `load_peak` / `load_mean` | 締切（`deadline_ns`）と `buffer_frames_observed @ sample_rate` を併記 |
| Dropouts | `xruns` + `buffer_underruns` | **0 か否かが決定的**（正本 §2.3） |
| Slots | `config.used.*` / `config.limits.*` | 上限に達したら分かる（正本 §3.5。D 完了後は「使用数 + 余裕」に変わる） |
| Children | `children[]` + 拡張の `ps` | PID・role・%CPU・RSS・respawn 回数 |
| Capture | `capture.enabled` / `.path` | 有効なら**デバイス切替が使えない理由**をここに（§4.3） |

### 7.3 設定変数の一覧（§8 の表を UI に出す）

**属性（live / restart / build）は §8 の表をそのまま出す。🔴 「未確認」はそのまま「未確認」と出す**（正本 §6）。

---

## 8. 設定変数の一覧（32 個・地図 §4.H.1）

🔴 **地図と #662 チェックリストの「33 個」は誤り。**`ORBITSCORE_DSL` は env ではなく、`INSTRUCTION_ORBITSCORE_DSL.md` という**ファイル名を含む doc コメント**が正規表現に当たっただけ（読み出し 0 件・§14 の grep）。実数は **32**。

**属性の凡例**: `restart` = プロセス起動時に 1 回読む（実測で確認済み）/ `live` = 走行中に変えられる（実測で確認済み）/ **`未確認`** = 試していない（**「不可能」ではない**・正本 §6）。**候補**列は main の読みであって確定ではない（§17 (1)）。

| # | 変数 | プロセス | いつ効くか | 入口（読み出し） | 候補 |
|---|---|---|---|---|---|
| 1 | `ORBIT_AUDIO_DEVICE` | daemon | **restart**（`EngineWrap::start` 前）。ただし**走行中の変更は `SelectAudioDevice` RPC** で可能 | `engine_wrap.rs:4173-4186` / CLI `main.rs:200-207` | ユーザー |
| 2 | `ORBIT_CAPTURE_WAV` | daemon | **restart** | `engine_wrap.rs:4153-4167` | ユーザー |
| 3 | `ORBIT_SUM_BUS_POOL` | daemon | **restart** | `engine_wrap.rs:1993-1999` → `:2020` | ユーザー（D で消える） |
| 4 | `ORBIT_AUX_BUS_POOL` | daemon | **restart** | `engine_wrap.rs:2002-2008` → `:2020` | ユーザー（D で消える） |
| 5 | `ORBIT_EFFECT_BUS_POOL` | daemon | **restart** | `engine_wrap.rs:1945` | ユーザー（D で消える） |
| 6 | `ORBIT_EFFECT_BUSES` | daemon | **restart** | `engine_wrap.rs:1941` | ユーザー |
| 7 | `ORBIT_OUTPROC_INSTRUMENT_SLOTS` | daemon | **restart** | `outproc_instrument.rs:105` | ユーザー（D で消える） |
| 8 | `ORBIT_INSTRUMENT_BUFFER_FRAMES` | daemon → child | **restart** | `outproc_instrument.rs:100` | 開発 |
| 9 | `ORBIT_EFFECT_BUFFER_FRAMES` | daemon → child | **restart** | `outproc_effect.rs:428` | 開発 |
| 10 | `ORBIT_EFFECT_FORMAT` | daemon | **restart**（初期値のみ。以後は `LoadPlugin` 引数・`outproc_effect.rs:355`） | `outproc_effect.rs:336` 付近 | 開発 |
| 11 | `ORBIT_EFFECT_PLUGIN` | daemon | **restart** | `outproc_effect.rs:424` | 開発（gated harness） |
| 12 | `ORBIT_EFFECT_PLUGIN_ID` | daemon | **restart** | `outproc_effect.rs:425` | 開発（gated harness） |
| 13 | `ORBIT_INSTRUMENT_PLUGIN` | daemon | **restart** | `outproc_instrument.rs:97` | 開発（gated harness） |
| 14 | `ORBIT_INSTRUMENT_PLUGIN_ID` | daemon | **restart** | `outproc_instrument.rs:98` | 開発（gated harness） |
| 15 | `ORBIT_EFFECT_CHILD_BIN` | daemon | **build/配置**（バイナリの場所） | `outproc_effect.rs:420` | 開発 |
| 16 | `ORBIT_INSTRUMENT_CHILD_BIN` | daemon | **build/配置** | `outproc_instrument.rs:93` | 開発 |
| 17 | `ORBIT_DAEMON_ALLOW_FAULT_INJECTION` | daemon | **restart** | `session.rs:2283` | 🔴 開発専用（出荷時は既定無効） |
| 18 | `ORBIT_STD_PLUGIN_DIR` | rack child | **restart**（child spawn 時） | `orbit-effect-rack-child/src/macos.rs:239` | 開発／配置 |
| 19 | `ORBIT_PLUGIN_PATH` | scanner child | scan 実行時 | `orbit-plugin-scan/src/main.rs:34` | ユーザー |
| 20 | `ORBIT_PLUGIN_SCAN_PATH` | extension | scan 実行時 | `plugin-catalog-reader.ts:184` | 開発／配置 |
| 21 | `ORBIT_PLUGIN_CATALOG` | engine + extension | 読み出しごと | `plugin-catalog.ts:40` / `plugin-catalog-reader.ts:117` | 開発 |
| 22 | `ORBIT_AUDIO_DAEMON_PATH` | engine（TS） | **restart**（daemon spawn 時） | `daemon-client.ts:225` | 開発／配置 |
| 23 | `ORBIT_SCSYNTH_PATH` | engine（TS・SC 経路） | **restart** | `scsynth-resolver.ts:7-12`（拡張が `extension.ts:2153` で渡す） | 開発（SC 退役中） |
| 24 | `ORBITSCORE_ENGINE` | engine（TS） | **restart** | `engine-backend.ts:53` / 拡張が `extension.ts:2143-2146` で明示 | 開発 |
| 25 | `ORBITSCORE_DEBUG` | engine（TS） | **restart** | `slice-audio-file.ts:66` ほか / 拡張 `extension.ts:2123` | ユーザー |
| 26 | `ORBITSCORE_SESSION_LOG` | engine（TS） | **restart**（engine spawn 時） | `session-log-gate.ts:13`。入口 = VS Code 設定 `orbitscore.sessionLog`（既定 true） | ユーザー |
| 27 | `ORBITSCORE_MCP_PORT` | extension | **restart**（拡張 activate 時） | `extension.ts:451` | 開発 |
| 28-32 | `ORBIT_VST3_FACTORY_ABORT_CREATE_INSTANCE` / `ORBIT_VST3_FACTORY_ORACLE_LEVEL` / `ORBIT_VST3_GAIN_EMPTY_STATE` / `ORBIT_VST3_SYNTH_EMPTY_STATE` / `ORBIT_VST3_SYNTH_STATE_DELAY_MS` | **oracle プラグイン**（テスト用 VST3・別プロセス） | プラグイン load 時 | `orbit-vst3-gain-oracle/src/lib.rs:240` / `:695` / `:768`、`orbit-vst3-synth-oracle/src/lib.rs:290` / `:297` | 🔴 テスト専用（故障注入） |

**#26 は `694-session-log-editor-path-design.md` §12 の 1 行をそのまま転記した**（記載だけ。実装は #694）。

🔴 **`live` の行が 1 つも無い。** 現時点で走行中に変えられると**確認済み**の設定は 1 つもない（デバイスは RPC 経路があるが #661 が直るまで成立しない）。**推測で `live` と書かない。** 属性の確定はバッチ D の作業（§17 (2)）。

---

## 9. #667 — child の busy-wait を待ちに変える

### 9.1 現在地の訂正

| #667 本文 | 実測 |
|---|---|
| 「`thread_policy` / `TIME_CONSTRAINT` / `pthread_setschedparam` の設定は child 側に見つからない（grep 実測）」 | 🔴 **不正確**。`orbit-child-runtime/src/lib.rs:521-533` が `pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0)` を audio thread に設定している（`spawn_audio` `:186-194`）。**探した語が違っただけ**。TIME_CONSTRAINT ではないが「通常優先度」でもない |
| 「`orbit-vst3-instrument-child/src/main.rs:346`」 | 現 main では **`:354`**（`:352` が `seq_request` の load） |

したがって #667 の論点 3「RT 優先度を付けるか」は「**QoS を上げるか（USER_INTERACTIVE → TIME_CONSTRAINT）**」という問いに変わる。**本書はここを決めない**（待ちを直した後に測る。§10）。

### 9.2 🔴 前提: child は「アイドル」ではない

`GetStatus` の観測（#667）は「トランスポート停止中も CPU 98%」だが、**`seq_request` は停止中も callback ごとに進む**（host は音の有無に関わらず毎ブロック publish する: `host.rs:105-125` / `instrument_host.rs:286-289`）。つまり child が待っているのは「次のブロック」であって、**要求が来ない時間ではなく、要求と要求の間**。#667 の算術（10.67 ms 周期のうち ~1 ms が DSP・残り ~9.7 ms が spin）はこれと一致する。

**帰結**: 「停止中は完全に寝かせる」（#667 論点 4）は**現在の host 実装では成立しない**。寝かせるには host 側が publish を止める必要があり、それはエフェクトの tail を切る。**本書では扱わない**（別の設計）。

### 9.3 直し方

🔴 **待ちの実装を 1 箇所に畳む**（型で潰す）。5 crate の loop は**文字どおり同じ形**（§14 の grep）なので、`orbit-audio-sandbox` に共有ヘルパを置き、5 つの `if cur <= last { spin_loop(); continue; }` を置き換える。

```rust
// rust/crates/orbit-audio-sandbox/src/transport.rs（新設）
/// 次の `seq_request` を待つ。`last` より進んだ seq を返す。`CONTROL_QUIT` / stop で `None`。
///
/// 🔴 待ち方をここ 1 箇所に閉じる。5 種の child が個別に spin/park を持つと、1 つ直して
/// 他が残る形になる（#667 受け入れ基準「全 5 種の child で確認」）。
pub fn wait_for_request(
    region: *mut SharedRegion,
    last: u64,
    stop: &AtomicBool,
) -> Option<u64>;
```

内部は **ハイブリッド待ち**（#667 の「直し方」）:

```
短時間スピン（次ブロックの到着ゆらぎを覆う長さ）
   ↓ 来なければ
ブロッキング待ちへ落ちる
   ↓ 要求が来たら起きる
```

**起こす側の制約が設計の中心**: publish するのは **daemon の RT コールバック**（`host.rs:120` / `instrument_host.rs:288`）で、そこには**確保・ロック・syscall を持ち込めない**（#628 の不変条件）。

| 案 | 起床の仕組み | RT コスト | 評価 |
|---|---|---|---|
| **A** | shm の `waiters: AtomicU32` を child が park 前に立て、host は **`waiters != 0` のときだけ**起床 syscall を出す | 演奏中は child が spin 段で拾うので `waiters == 0` → **RT で syscall 0 回**。落ちた時だけ 1 回 | ✅ 有力。ただし「落ちた時だけ」の 1 回が**ブロック境界に乗る**ので実測が要る |
| **B** | child が **タイムアウト付き park** を繰り返す（host は何もしない） | **RT コスト 0** | 起床遅延が待ち粒度に等しい。締切が 1.33 ms（64f@48k）になると粒度が効く |
| C | パイプ / kqueue で host が書く | RT で write(2) | 🔴 却下（RT に syscall を常時持ち込む） |

**A と B は排他ではない**: A の起床を取りこぼしても B のタイムアウトが救う（**失われた wake でデッドロックしない**）ので、**A + B のタイムアウトを安全網として両方入れる**。

**macOS のブロッキング手段**（#667 論点 2）は**未確定**。候補: 名前付き POSIX セマフォ（`sem_open` / `sem_post` / `sem_timedwait`）/ `PTHREAD_PROCESS_SHARED` の mutex + condvar / mach セマフォ（ポート受け渡しが要る）。🔴 **本書では選ばない** — `orbit-sandbox-spike`（`src/bin/sandbox-host.rs` / `sandbox-child.rs`・同じ handshake を持つ既存のスパイク）で**先に測ってから**決める（§15 PR-8a）。

### 9.4 何を測るか（🔴 数値目標は置かない）

| 測るもの | 手段 |
|---|---|
| idle の child CPU | `ps -Ao pid,%cpu,rss,comm`（#667 と同じ出どころ）。**修正前後を同条件で** |
| 起床レイテンシ | child 側に「`seq_request` 前進から処理開始まで」の histogram（`CallbackTimeStats`（`post_processor.rs:29-31`）と同じ 50 µs バケットの形を流用） |
| **音が変わらないこと** | capture E2E（§12・#667「CPU が下がっただけでは不十分」） |
| ドロップアウト・締切に対する使用率 | `GetStatus.callback.*`（§4.2）— **A が先に要る** |

---

## 10. 性能の実測（地図 §7 (12)・§4.O — owner の 2 つの問いに答える材料）

> マルチスレッドちゃんと使えてる？ とか。メモリは有効に使えてる？ とか（owner・逐語）

**現状は「測る手段が無いので答えられない」。** 本節はその手段だけを設計する。🔴 **数値目標も閾値も置かない。**

| 問い | 何を出せば答えになるか | 手段 | どの PR |
|---|---|---|---|
| スレッドを使えているか | daemon の**スレッド一覧と各スレッドの CPU** | `ps -M <daemon pid>`（macOS・スレッド別 %CPU）。名前は既に付いている（`orbit-audio-owner` `main.rs:149` / `<child>-audio` `child-runtime/src/lib.rs:187`） | PR-9（1 回測って記録） |
| 並列に回っているか | child の**プロセス数と役割**（instrument = 1 インスタンス 1 child / effect = 1 バス 1 child） | `GetStatus.children`（§4.4）+ `ps` の %CPU | PR-3 / PR-5 |
| RT は直列か | post-loop（`output.rs` の配列順）が child を直列に待つか | 🔴 **未検討**（地図 §9）。本書のスコープ外 | — |
| メモリを有効に使えているか | **固定確保の内訳**: insert bus buffer（`sample_rate × channels` × stage 数・`output.rs:1404-1409`）/ shm（`BUF_LEN × SLOTS`・`transport.rs:56-60` / `:73`）/ capture ring（`CAPTURE_RING_SECONDS = 8`・`output.rs:222`・確保は `:1419`） | `GetStatus.config.limits` の値から**計算式で出す**（実測に頼らない部分）+ daemon RSS を `ps` で | PR-3（値）/ PR-9（実測） |
| child のメモリ | child ごとの RSS（プラグイン支配・#667 では 0.3〜4.2 GB） | 拡張の `ps -o rss`（§4.4） | PR-5 |

🔴 **1 回測って終わりにしない。** `GetStatus` に載る項目（callback 負荷・xrun・children）は**常時見える**ので、`ps -M` / Instruments が要るのは「スレッド別 CPU の内訳」だけ。それは**バッチ B の実装時に 1 回測って本書へ追記する**（地図 §9 の「daemon のスレッド数・スレッド別 CPU・メモリ内訳の実測」を閉じる）。

---

## 11. #663 — プール上限の撤廃（バッチ D）

**形は正本 §3 と #663 で確定済み**（off-thread 確保 → atomic 差し替え → 世代退役。#628 の install ring / 退役リストの適用）。本書が足すのは**順番だけ**。

| 順 | 定数 | なぜこの順か |
|---|---|---|
| 1 | `MAX_INSTRUMENT_SLOTS = 32`（`outproc_instrument.rs:89`） | 🔴 **RT の固定長配列ではない**。slot は shm region + block source の集合で、**確保も解放も既に off-thread**（`LoadPlugin` 時）。上限は「暴走値を弾く」ためのガード（`:88` のコメント）。**最も安く外せる** |
| 2 | `MAX_INSERT_BUS_STAGES = 64`（`output.rs:347`） | 🔴 本丸。callback が stack 上の `ArrayVec` で `render_multi` の引数を組む前提（`:345-347`）。install ring と世代退役が要る |
| 3 | `MAX_SOURCE_SLOTS = 32` / `MAX_SOURCE_UNITS = 16`（`:350` / `:353`） | 2 と同じ機構。`MAX_SOURCE_FEEDS = 32 × 16`（`:355`）が派生するので**同時に**外す |
| 4 | `MAX_LINK_CHANNELS = 64`（`:343`） | LinkAudio 経路（feature gate）。1〜3 が済んでから |
| — | `ORBIT_*_POOL` / `ORBIT_OUTPROC_INSTRUMENT_SLOTS`（§8 の #3-#7） | 上限が消えれば**設定項目としては消える**（正本 §3.5）。ただし env は**起動時の初期確保数**として残る（起動を速くするための先読み） |

**#663 に入っていないもの**（地図 §4.H / #663 チェックリスト・再確認）: **1 ラインの出口の個数**（`_sumOutputBus` 単一）と **render bus `output(1..16)` の 16**（`sequence.ts:385-390`）は **#649 / #611 の仕事**。本書は触らない。

**受け入れは #663 の 5 項目のまま。** 検証は「拡張の最中に音が途切れないこと」= capture E2E（§12 E-7）。

---

## 12. E2E（`tests/e2e/orbitstudio-mcp-gated.spec.ts` に積む・MCP だけで駆動）

**新しい DSL 語は増えない**（A〜E はすべて MCP / UI / daemon 面）ので `tests/e2e/dsl-e2e-coverage.spec.ts` の baseline は**触らない**。
`evaluate_orbitscore` の `ok` に assert しない。ERROR 件数は `toBeLessThanOrEqual`（`gated-assertion-hygiene.spec.ts:31-45` が強制）。

| # | 何を守るか | 手順（MCP tool のみ） | 判定 |
|---|---|---|---|
| **E-1** | 🔴 **#661: デバイスを指定して音が出る** | ① `list_audio_devices` → `isDefault` の**名前**を取る（マシン非依存）② `select_audio_device(name)`（engine 停止中なので設定へ書いて起動する経路・`extension.ts:3268-3274`）③ `stop_engine` ④ `start_engine({capture_wav})` — **ここで daemon が `--audio-device <name>` で起動する**（`extension.ts:2109-2116` → `daemon-client.ts:877`）⑤ kick を鳴らす ⑥ `stop_engine` ⑦ `analyze_audio` | **RMS > 0**。🔴 現状の harness は `orbitscore.audioDevice: '__default__'` センチネル（`orbitstudio-mcp-gated.spec.ts:658`）で **`--audio-device` を通らない** — 本テストは実名を通す最初の経路 |
| **E-2** | #661: 死んだストリームが「起動成功」にならない | 存在しないデバイス名で ④ を実行 | `start_engine` が失敗を返す **または** `get_log` に縮退のログが出る（**沈黙しない**）。`ok` だけで判定しない |
| **E-3** | #660: MCP から実デバイス一覧が返る | `list_audio_devices` | `ok: true` かつ `devices.length >= 1` かつ `isDefault` が 1 つ |
| **E-4** | **A の真実が MCP から読める** | `start_engine` → `get_engine_state` | `daemon.output.device_name` が E-3 の名前のどれかと一致 / `daemon.callback.count > 0` / `daemon.callback.alive === true` / `daemon.output.sample_rate > 0` / `daemon.config.limits.insert_bus_stages > 0` |
| **E-5** | **コールバック停止が画面に出る** | `get_engine_state` を engine 停止中に呼ぶ | `running === false` かつ `daemon === undefined`（**古い値を返さない**） |
| **E-6** | #667: 音が変わらない | 修正前後で同じ譜面を capture し、窓 RMS を比較 | 窓ごとの RMS 差が許容内（既存 `rms(name)` ヘルパ・`:598-604`）+ `daemon.callback.xruns` が増えない |
| **E-7** | #663: 拡張中に音が途切れない | 上限を超える数の bus / instrument を**演奏しながら**宣言 | 拡張の瞬間を含む窓の RMS が**下限を割らない**（無音窓が出ない） |
| **E-8** | C（操作）: MIDI panic が到達する | `evaluate_orbitscore` で鳴らす → panic の MCP tool → capture | panic 後の窓 RMS が減衰（正本 §7.4「押したけど効いたのか分からないボタンは押せない」） |

⚠️ **capture とデバイス切替は排他**（`engine_wrap.rs:4816-4822`）。E-1 は**起動時指定**なので成立するが、**走行中切替（E-9）は capture と同時に検証できない**。走行中切替の判定は **`get_engine_state` の `daemon.output.device_name` の変化 + `daemon.callback.count` が切替後も進むこと**で行う（音ではなくカウンタ）。これが正本 §6.2「切り替わったことの確認」の E2E 形。

---

## 13. 失敗モード（握り潰される経路が無いこと）

| # | 失敗 | 現在 | 本書 |
|---|---|---|---|
| 1 | 要求したデバイスが見つからない | stderr に警告 1 行（`output.rs:214-218`）。**UI にも MCP にも出ない** | `output.device_fell_back` + 起動ログ（§5.2-1） |
| 2 | ストリームは開くがコールバックが回らない | 🔴 **完全に沈黙**（#661） | 起動失敗にする（§5.2-2）+ FATAL event（§4.2） |
| 3 | 走行中にコールバックが止まる | `device_lost` のみ検知（`session.rs:765-775`）。**止まっただけでは何も出ない** | `STREAM_CALLBACK_STALLED`（§4.2） |
| 4 | デバイス切替でレート / チャンネルが変わる | 🔴 **未検証**。engine は作り直されず insert bus の再確保も無い（`output.rs:1473-1508`）。`GetStatus` は古い値を返し続ける（`engine_wrap.rs:7865`） | §4.1 で真実を書き戻す + §17 (2) で属性を実測確定 |
| 5 | 切替が失敗して無音になる | build/play エラーなら旧 stream が残る（`engine_wrap.rs:4876-4879`）。**コールバックが死んだ場合は救われない** | §5.3 のロールバック |
| 6 | daemon 状態が取れない | — | `EngineState.daemonError` に理由（§7.1）。**既定値で埋めない** |
| 7 | プール拡張が失敗する（メモリ不足） | — | #663 受け入れ 4「沈黙しない」。ticker の warning event + `GetStatus` に反映 |
| 8 | 起床通知の取りこぼしで child が寝たまま | — | §9.3 のタイムアウト安全網（デッドロックしない） |
| 9 | env の非 UTF-8 | `best_effort_stderr` で警告して無視（`engine_wrap.rs:4160` / `:4180`） | 不変。`GetStatus` の実効値は**無視後の値**を返す（見た目と実際が一致する） |

---

## 14. 呼び出し元・出現箇所の全列挙（grep 出力）

```
$ grep -rn "spin_loop" rust/crates --include=*.rs | grep -v target | grep "/src/"
rust/crates/orbit-clap-instrument-child/src/main.rs:252:                    std::hint::spin_loop();
rust/crates/orbit-sandbox-spike/src/bin/sandbox-child.rs:160:            std::hint::spin_loop();
rust/crates/orbit-sandbox-spike/src/bin/sandbox-host.rs:494:                std::hint::spin_loop();
rust/crates/orbit-sandbox-spike/src/bin/sandbox-host.rs:647:                        std::hint::spin_loop();
rust/crates/orbit-vst3-instrument-child/src/main.rs:354:                    std::hint::spin_loop();
rust/crates/orbit-vst3-effect-child/src/main.rs:148:                    std::hint::spin_loop();
rust/crates/orbit-effect-rack-child/src/macos.rs:573:                    std::hint::spin_loop();
rust/crates/orbit-audio-sandbox/src/bin/sandbox-instrument-child.rs:104:            std::hint::spin_loop();
rust/crates/orbit-audio-sandbox/src/bin/sandbox-effect-child.rs:86:            std::hint::spin_loop();
rust/crates/orbit-clap-effect-child/src/main.rs:141:                    std::hint::spin_loop();
```

**#667 の対象は上のうち 5 本**（`orbit-clap-instrument-child` / `orbit-vst3-instrument-child` / `orbit-vst3-effect-child` / `orbit-effect-rack-child` / `orbit-clap-effect-child`）。`orbit-sandbox-spike` と `orbit-audio-sandbox/src/bin/*` は**スパイク / サンドボックスのバイナリ**で本番経路ではない（§9.3 の計測にはむしろこれを使う）。tests 配下（14 本）は対象外。

```
$ grep -rhoE "ORBIT(SCORE)?_[A-Z0-9_]+" rust/crates/*/src packages/engine/src packages/vscode-extension/src | sort -u
ORBITSCORE_DEBUG            ORBIT_EFFECT_BUSES               ORBIT_PLUGIN_CATALOG
ORBITSCORE_DSL   ← 🔴 誤検出（env ではない）  ORBIT_EFFECT_BUS_POOL   ORBIT_PLUGIN_PATH
ORBITSCORE_ENGINE           ORBIT_EFFECT_CHILD_BIN           ORBIT_PLUGIN_SCAN_PATH
ORBITSCORE_MCP_PORT         ORBIT_EFFECT_FORMAT              ORBIT_SCSYNTH_PATH
ORBITSCORE_SESSION_LOG      ORBIT_EFFECT_PLUGIN              ORBIT_STD_PLUGIN_DIR
ORBIT_AUDIO_DAEMON_PATH     ORBIT_EFFECT_PLUGIN_ID           ORBIT_SUM_BUS_POOL
ORBIT_AUDIO_DEVICE          ORBIT_INSTRUMENT_BUFFER_FRAMES   ORBIT_VST3_FACTORY_ABORT_CREATE_INSTANCE
ORBIT_AUX_BUS_POOL          ORBIT_INSTRUMENT_CHILD_BIN       ORBIT_VST3_FACTORY_ORACLE_LEVEL
ORBIT_CAPTURE_WAV           ORBIT_INSTRUMENT_PLUGIN          ORBIT_VST3_GAIN_EMPTY_STATE
ORBIT_DAEMON_ALLOW_FAULT_INJECTION  ORBIT_INSTRUMENT_PLUGIN_ID  ORBIT_VST3_SYNTH_EMPTY_STATE
ORBIT_EFFECT_BUFFER_FRAMES  ORBIT_OUTPROC_INSTRUMENT_SLOTS   ORBIT_VST3_SYNTH_STATE_DELAY_MS
（33 行 − 誤検出 1 = 実数 32）

$ grep -rn "ORBITSCORE_DSL" rust/crates/*/src packages/engine/src packages/vscode-extension/src
→ 13 件すべて `INSTRUCTION_ORBITSCORE_DSL.md` という **ファイル名を含む doc コメント**。env の読み出しは 0 件。
```

```
$ grep -rn "GetStatus\|getStatus" packages/engine/src packages/vscode-extension/src
packages/engine/src/audio/rust-engine/daemon-client.ts:716:  async getStatus(): Promise<Record<string, unknown>> {
packages/engine/src/audio/rust-engine/protocol-types.ts:50:  | 'GetStatus'
packages/engine/src/audio/rust-engine/rust-engine-player.ts:573:      const status = await this.daemon.getStatus()   ← クロック anchor 用
packages/engine/src/audio/rust-engine/rust-engine-player.ts:1794:    return this.daemon.getStatus()                  ← getDaemonStatus()（@internal・呼び出し元 0）
```

**拡張から `GetStatus` に届く経路は今日 1 本も無い。** §7.1 の `//#engineStatus` が最初の 1 本になる。

```
$ grep -rn "engineView\|EngineViewProvider" packages/vscode-extension/src/extension.ts | head
:127  let engineViewProvider: EngineViewProvider | null = null
:392  engineViewProvider = new EngineViewProvider()
:393  return vscode.window.registerTreeDataProvider('orbitscore.engineView', engineViewProvider)
:395-397  registerCommand: engineViewSelectDevice / engineViewToggleEngine / engineViewToggleDebug
:1625 refreshEngineView: () => engineViewProvider?.refresh()
:1779 class EngineViewProvider implements vscode.TreeDataProvider<EngineViewNode>
:1882 engineViewToggleEngine  :1925 engineViewSelectDevice
```

---

## 15. PR 分割

| PR | 件名 | 対象 | 触る場所（概算） | 依存 | 検証 | 一方通行 |
|---|---|---|---|---|---|---|
| **PR-1** | `chore(env): read env vars through one aliasing resolver` | #156 の**機構だけ** | Rust 1 ヘルパ + TS 1 ヘルパ + 全読み出し 32 箇所を経由（+150 / -80） | — | 既存全緑。**新規変数がヘルパを迂回したら red になるテスト**（`grep` ベース・`gated-assertion-hygiene.spec.ts` と同型） | ❌ |
| **PR-2** | `chore(env): unify the env prefix` | #156 の**改名** | 上のヘルパに旧名を alias として渡すだけ（+40 / -40） | PR-1・**§17 (3) の裁定** | 旧名でも新名でも起動する unit test | 🔴 **一方通行**（ユーザーの `settings.json` / CI に散る） |
| **PR-3** | `feat(daemon): report the real stream config and callback liveness in GetStatus` | バッチ A の土台 | `output.rs`（StreamStats に `callbacks` / `last_frames`・`OutputStream.device_name`）/ `engine_wrap.rs`（config snapshot・`record_stream_config`）/ `session.rs`（`GetStatus` 拡張・ticker に停止検知）（+400 / -60） | PR-1 | E-4 の daemon 部分を `cargo test` + 実機 `get_log` | ❌（追加のみ） |
| **PR-4** | `fix(daemon): make --audio-device produce a live stream` | **#661**（`must-fix`） | `main.rs`（CLI → typed 引数）/ `output.rs`（起動ログ・first-callback 検証・縮退）/ `engine_wrap.rs`（切替の確認とロールバック）（+250 / -80） | **PR-3**（`callbacks` が要る） | **E-1 / E-2 / E-9** + 実機で `--audio-device` 指定して音を聴く | ❌ |
| **PR-5** | `fix(mcp): list audio devices through the daemon on the rust path` | **#660** + `get_engine_state` 拡張 + child 一覧 | `extension.ts`（`listAudioDevicesForAgent` / `getEngineStateForAgent`）/ `mcp-server.ts`（型）/ `repl-mode.ts` + `rust-engine-player.ts`（`//#engineStatus`）/ 新 `engine-status-bridge.ts`（+350 / -40） | PR-3 | **E-3 / E-4 / E-5** | ❌（`AudioDeviceInfo` は optional 追加） |
| **PR-6** | `feat(orbitstudio): show device, headroom, dropouts and children in the Engine view` | バッチ B 本体（**closes #483**） | `engine-view.ts`（行の組み立て・pure）/ `extension.ts`（`ps` ポーリング）/ user docs `engine-settings.md` 日英（+450 / -60） | PR-5 | E-4 を UI 経由でも確認（実機スクリーンショット不要・MCP で同値） | ❌ |
| **PR-7** | `feat(orbitstudio): list engine settings with their scope` | §8 の 32 変数表を UI と MCP へ | `engine-view.ts` + 新 `engine-settings-table.ts`（pure・単一の表）（+300 / -10） | PR-6・**§17 (1) の裁定** | 表の内容が `GetStatus.config` と食い違ったら red にする unit test | ❌ |
| **PR-8a** | `perf(spike): measure cross-process wake latency for the child audio loop` | #667 の**計測だけ**（本番コードを触らない） | `orbit-sandbox-spike`（+200 / -0） | — | スパイクの出力を本書 §9.4 に追記 | ❌ |
| **PR-8b** | `perf(child): replace the busy-wait with a hybrid park` | **#667** | `orbit-audio-sandbox/src/transport.rs`（共有ヘルパ）+ 5 child の loop（+250 / -50） | PR-8a・**PR-3**（余裕の観測が要る） | **E-6** + `ps` の実測を報告に貼る（5 種すべて） | ❌ |
| **PR-9** | `docs(perf): record the measured thread and memory breakdown` | 地図 §7 (12) の答え | 本書 §10 への追記のみ | PR-6・PR-8b | `ps -M` の出力を貼る | ❌ |
| **PR-10** | `feat(orbitstudio): wire MIDI panic and live device selection` | バッチ C（**closes #484** のデバイス部分） | `extension.ts` + `mcp-server.ts`（`panic()` は `midi-output.ts:90` に実装済み・配線のみ）（+200 / -10） | PR-5 | **E-8 / E-9** | ❌ |
| **PR-11** | `feat(engine): grow the slot pools off-thread` | **#663**（バッチ D）。§11 の順に**さらに分ける** | `output.rs` / `outproc_instrument.rs`（+600 / -200） | PR-6（余裕の表示が前提・確定事項 4）・PR-8b | **E-7** + #663 受け入れ 5 項目 | 🔴 設定項目の消滅は**ユーザーに見える** |
| **PR-12** | `feat(orbitstudio): rework the Engine view as a WebviewView` | バッチ E（**closes #503**） | 新 webview（+500 / -300） | PR-7・PR-10・PR-11 | 既存 E2E がすべて通ること（ロジックは pure 関数のまま） | ❌ |

**#661 が `must-fix` なので PR-3 → PR-4 が最短経路。** PR-1/PR-2 は §17 (3) の裁定が要るので、**裁定が出るまでは PR-3 を先に着手してよい**（PR-1 は改名を含まないので後から入れても衝突は小さい）。

---

## 16. spec 改訂（実装より先・運用規則 6）

| 対象 | 改訂 | どの PR |
|---|---|---|
| `docs/core/INSTRUCTION_ORBITSCORE_DSL.md:1474-1477`（instrument slot pool の上限・「env を上げてエンジンを再起動する」） | #663 で**上限が消える**ので、「起動時に固定・env で拡張」から「実行中に伸びる・env は初期確保数」へ書き直す | PR-11 の**前** |
| 同 **新設「Engine Settings」節** | 32 変数の一覧と属性（§8）を core spec に置く。**UI と MCP と spec が同じ表を指す**（CLAUDE.md 運用規則 7） | PR-7 の**前** |
| `docs/design/662-engine-visibility-and-limits.md` §6.1（live の見立て表） | 🟡 の行を**実測結果**に置き換える（正本 §6「未検証は未検証と書く」） | PR-11 / §17 (2) の後 |
| `sites/user/getting-started/engine-settings.md`（日英） | #660 の指摘どおり「未実装」を実装に合わせる。**検証日の注記の扱いも直す**（古い注記が裏取りを止めた） | PR-6 |

---

## 17. 🔴 owner 裁定待ち（設計に混ぜていない・他は着手可能）

> **2026-09-03 owner 回答（裁定シート Q-662-1〜6）— 6 件すべて解消**
> - (1) **A 全部出す**（テスト専用 6 個は折りたたみ）→ PR-7
> - (2) **A バッチ D で 1 つずつ実測**（推測で書かない）
> - (3) **C プロセス境界の規則を明文化し例外 3 個だけ改名** → PR-2 は 3 個
> - (4) **A #368 を吸収**（env を作らず UI / RPC から）
> - (5) **A child の QoS を TIME_CONSTRAINT へ上げる（推奨から変更）** → PR-8b に含める。ただし §9.4 の「何を測るか」（CPU 使用率・wake レイテンシ）を **上げる前 / 後の両方**で取り、上げたことで RT の他スレッド（daemon の cpal callback）を圧迫していないかを `CallbackTimeStats` の p99 で確認する。macOS の `thread_policy_set(THREAD_TIME_CONSTRAINT_POLICY)` は period / computation / constraint の 3 値を要求するので、値はブロック長から算出し数値目標は置かない
> - (6) **A 現状維持（拒否・UI に理由）**

| # | 問い | 選択肢 | 推奨 | 影響範囲 |
|---|---|---|---|---|
| **(1)** | **32 変数のうちどれをユーザーに出すか**（地図 §4.H.1 論点 1・§9） | A 全部出す（開発向けは折りたたむ）/ B ユーザー向けだけ出す / C 出さずに「エンジンの状態」だけ出す | **A**。原則「エンジンが知っていることは原則ユーザーにも見せる」（正本 §1）に照らすと 5 / 32 は中途半端。テスト専用の 6 個（#17・#28-32）は**既定で隠す折りたたみ**に置き、隠す理由（故障注入）を書く | §8 の「候補」列が確定列になる。PR-7 |
| **(2)** | 各変数の **live / restart / build** 属性 | 実測して確定（正本 §6） | **本書では書かない。** 現時点で `live` と確認できたものは 1 つも無い。**バッチ D で 1 つずつ試して埋める** | §8 の「いつ効くか」列。PR-11 |
| **(3)** | **#156 の統一方向**（地図 §4.H.1 論点 3） | A `ORBIT_` に統一 / B `ORBITSCORE_` に統一 / C **プロセス境界の規則を明文化**して例外だけ直す（TS = `ORBITSCORE_` / daemon = `ORBIT_`。例外は `ORBIT_AUDIO_DAEMON_PATH`・`ORBIT_PLUGIN_CATALOG`・`ORBIT_SCSYNTH_PATH` が TS 側で読まれること） | **C**。#156 の棚卸しコメントが「実質的な境界はできている」と実測している。全面改名は**一方通行**（ユーザーの `settings.json` と CI に散る）で、得られるのは見た目の統一だけ。C なら改名は 3 個で済む | PR-2 の規模（3 個 vs 32 個）。**一覧（PR-7）より前に決める必要がある** — 公開してから改名すると 2 度手間 |
| **(4)** | **#368 を #662 バッチ D に吸収するか**（#368 チェックリスト・地図 §9） | A 吸収（`ORBIT_OUTPUT_BUFFER_FRAMES` を作らず、バッファは UI / RPC から変える）/ B 独立実装（env knob を先に作る） | **A**。`rebuild_output_stream` が既に `buffer_frames` 引数を持ち（`output.rs:1478`）、`EngineWrap.output_buffer_frames`（`:1629`）が切替時に再利用される配線もある。**env を足すと入口が 2 つになる**。ただし #368 の目的（gated RT を 64f/32f で回す）は env の方が安いので、**B を「テスト専用」として残す**選択もありうる | #368 を閉じる場所。PR-11 |
| **(5)** | child の QoS を **TIME_CONSTRAINT（実時間）へ上げるか** | A 上げる（スピンを短くできる）/ B USER_INTERACTIVE のまま | **B のまま着手し、PR-8a の計測後に再検討**。#667 の「RT 優先度が無いならスピンする理由が弱い」は**前提が誤り**（§9.1） | PR-8b |
| **(6)** | 走行中のデバイス切替を **capture 中も許すか** | A 現状維持（拒否・`engine_wrap.rs:4816`）/ B 許して capture を切り直す | **A**。「無音で録音が壊れるより先に fail する」という既存判断（`:4810-4813`）は正しい。**UI に理由を出す**ことで解決する（§4.3） | §12 E-9 の判定方法 |

---

## 18. 確信度と反証方法

| 主張 | 確信度 | 反証方法 |
|---|---|---|
| `GetStatus` は状態 8 個だけで設定を返さない | **高**（実測） | `session.rs:1349-1360` を読む |
| 掴んだデバイス名がどこにも残らない | **高**（実測） | `output.rs:168-217` / `:1380-1470` に `name()` の保存が無いことを確認 |
| 切替後に `output_sample_rate` が古い値を返す | **高**（コード上明白） | `apply_device_switch`（`:4857-4882`）が `self.sample_rate` を書かないことを確認。実機は「レートの違う 2 台」で切替して `GetStatus` を見る |
| #661 の最有力候補は C3（Device の入手方法） | **中**。#661 で指定されたのが**既定デバイスそのもの**だったことと、`requested` の有無で `Device` の入手経路が分岐する（`output.rs:172` vs `:180-197`）ことの一致による | §5.2-1 のログを入れて実機で 1 回起動する。C3 なら `default_output_device()` 経由で `callbacks` が回る。**回らなければ C3 は否定** |
| env の実数は 32（33 ではない） | **高**（`ORBITSCORE_DSL` の 13 件すべてがファイル名の doc コメント） | §14 の 2 番目の grep |
| child の audio thread は QoS 設定済み | **高**（実測） | `child-runtime/src/lib.rs:521-533` |
| host は child を待たない（1 block パイプライン） | **高**（実測 + モジュール doc） | `host.rs:130-140` / `transport.rs:7-11` |
| 「停止中に完全に寝かせる」は現実装では成立しない | **中**。host が毎コールバック publish していることに依存 | `instrument_host.rs` の `process_block` 相当が transport 停止中も呼ばれるかを実機ログで確認。呼ばれないなら #667 論点 4 が復活する |
| 二重レンダの窓（§5.3）が実在する | **中**。`render_state` / `engine` を共有することからの演繹で、**現在は窓が極小なので観測されていない** | 検証コードで `play()` と代入の間に待ちを入れ、`GetStatus.uptime_sec` / transport の進みが速くなるか見る |
| `ps -M` でスレッド別 CPU が取れる | **中**（macOS の一般的な手段。本リポジトリでの実行例は無い） | PR-9 で 1 回実行する |
