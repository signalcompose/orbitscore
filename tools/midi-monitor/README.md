# OrbitScore MIDI Monitor + Synth

`.orbs` の MIDI 出力 (Phase 1 / #228) を、DAW やソフトシンセのセットアップなしで確認するためのブラウザツール。
**Web MIDI API** で IAC ポートを受信し、**Web Audio API** で発音 + 受信内容をモニター表示する。

## 用途

- **`.orbs` の動作確認**: IAC を受けてその場で音を鳴らす (ゼロセットアップ)
- **MIDI モニター**: note-on/off・velocity・pitch bend・CC・パニックをログ表示、発音中ノートを可視化
- **WCTM リハの Disklavier 代替ソフトシンセ** (WCTM_SYSTEM_SPEC §9 / #232)

CI 自動テスト用ではない (エンジン側はモック単体テストでカバー)。あくまで人間/リハ用の検証ハーネス。

## 楽器

Instrument セレクタで切替:

- **Piano** (既定): 打鍵→減衰の音色 (triangle + 倍音、サステインなし)
- **Organ**: 加算合成 (ドローバー風の正弦倍音、フラットなサステイン)
- **Synth**: 素の波形 (triangle / sawtooth / square / sine)

velocity → 音量、pitch bend → ±2半音 detune (エンジンの bend range に一致)。

## 使い方

Web MIDI は secure context (localhost) が必要なので、ローカルサーバで配信して開く。

**素の静的配信** (モニター + シンセだけ使う場合):

```bash
cd tools/midi-monitor
python3 -m http.server 8137
# → Chrome で http://localhost:8137/ を開く
```

**dev サーバ** (受信イベントを stdout に流して外部から観測する場合、後述):

```bash
cd tools/midi-monitor
python3 dev-server.py 8137
# → Chrome で http://localhost:8137/index.html?report=1 を開く
```

手順:

1. **「Enable audio & MIDI」** をクリック (AudioContext の起動と MIDI 許可に user gesture が必要)
2. MIDI input で **IACドライバ バス1** を選択 (自動選択を試みる)
3. Instrument を選ぶ (Piano / Organ / Synth)
4. VS Code 拡張で `.orbs` を実行 → 音が鳴り、モニターにイベントが流れる

> ⚠️ **Chrome のタブを前面に**しておくこと。バックグラウンドだと AudioContext がスロットルされ、
> 先頭の音が落ちる (鳴り始めが 1 音ずれて聞こえる) ことがある。

### IAC が一覧に出ないとき

macOS の **Audio MIDI 設定 → IAC ドライバ → 「装置はオンライン」を ON**。
日本語環境ではポート名が `IACドライバ バス1` になる (英語例の `IAC Driver Bus 1` ではない)。

### MIDI なしで音だけ確認

**「Test tone」** ボタンで Web Audio 経路だけを単体確認できる (C4 を 0.5 秒、選択中の楽器で)。

## `.orbs` 例

[`example.orbs`](example.orbs) — IAC へ C メジャースケールを送る最小例。
port は substring `"IAC"` 指定なので日英どちらの環境でも解決する。

## エンジン実機で .orbs を鳴らす (headless MIDI runner)

`.orbs` を**実エンジンのロジック**（パーサー → 度数解決 → MidiOutput → IAC）で評価して鳴らす。
SuperCollider はブートしない（MIDI シーケンスは TransportClock で動くため）。手で MIDI を作るのではなく
**エンジンが実際に DSL から生成した MIDI** が出るので、これが Phase 1 の正しい実機検証になる。

```bash
# dev サーバを起動し、 ?report=1 でブラウザを開いておく（前項）。
npm run midi-run -- tools/midi-monitor/example.orbs
# → IAC に MIDI が出てブラウザが発音、 評価した DSL ソースが /pattern に報告され
#   「Now playing (DSL)」に表示される（表示=エンジンの実評価ソースなので音と必ず一致）
# Ctrl+C で停止（全 note-off のパニックを送って終了）
```

第2引数で monitor の URL を変更可（既定 `http://localhost:8137`）。実装: `packages/engine/src/cli/midi-run.ts`。

## dev サーバ + イベントレポート (共同テスト用)

`index.html?report=1` で開くと、受信した各イベントを `POST /events` で送る。`dev-server.py` はそれを
**stdout に出力**するので、別の観測者 (人間のもう一台 / 端末 `tail` / 連携エージェント) が
「ブラウザが何を受信したか」をリアルタイムに読める。人間がブラウザ/音/IAC を担当し、観測側が
イベントストリームを読む、という分担でテストできる。

`?report` を付けなければ POST しない (既定オフ、外部通信なし)。

### CLI から鳴らす例

エンジンを介さず生の MIDI を IAC に送って動作確認する (`@julusian/midi` が node_modules にある前提):

```js
const midi = require('@julusian/midi')
const out = new midi.Output()
const n = out.getPortCount()
let idx = -1
for (let i = 0; i < n; i++) if (/iac/i.test(out.getPortName(i))) idx = i
out.openPort(idx)
out.sendMessage([0x90, 60, 100]) // note-on C4
setTimeout(() => { out.sendMessage([0x80, 60, 0]); out.closePort() }, 500)
```

## 対応している MIDI メッセージ

| メッセージ | 挙動 |
|---|---|
| note-on (0x90, vel>0) | 発音 (velocity → 音量) |
| note-off (0x80 / 0x90 vel0) | リリース |
| pitch bend (0xE0) | ±2半音 detune (エンジンの bend range に一致) |
| CC123 / CC120 | 全 note-off (パニック) |
| その他 CC | ログのみ |

## 実装メモ

- 単一の `index.html` (ビルド不要、依存なし、vanilla JS)
- ポリフォニックシンセ: ノートごとに OscillatorNode 群 + GainNode (楽器別エンベロープ) + 共有 lowpass
- pitch bend はチャンネル単位で保持し、発音中・新規ノートの detune に反映
- `dev-server.py`: 静的配信 + `POST /events` を stdout へ (共同テスト用)
