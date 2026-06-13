# OrbitScore MIDI Monitor + Synth

`.orbs` の MIDI 出力 (Phase 1 / #228) を、DAW やソフトシンセのセットアップなしで確認するためのブラウザツール。
**Web MIDI API** で IAC ポートを受信し、**Web Audio API** で発音 + 受信内容をモニター表示する。

## 用途

- **`.orbs` の動作確認**: IAC を受けてその場で音を鳴らす (ゼロセットアップ)
- **MIDI モニター**: note-on/off・velocity・pitch bend・CC・パニックをログ表示、発音中ノートを可視化
- **WCTM リハの Disklavier 代替ソフトシンセ** (WCTM_SYSTEM_SPEC §9 / #232)

CI 自動テスト用ではない (エンジン側はモック単体テストでカバー)。あくまで人間/リハ用の検証ハーネス。

## 使い方

Web MIDI は secure context (localhost) が必要なので、ローカルサーバで配信して開く:

```bash
cd tools/midi-monitor
python3 -m http.server 8080
# → ブラウザ (Chrome 推奨) で http://localhost:8080/ を開く
```

1. **「Enable audio & MIDI」** をクリック (AudioContext の起動と MIDI 許可に user gesture が必要)
2. MIDI input で **IACドライバ バス1** を選択 (自動選択を試みる)
3. VS Code 拡張で `.orbs` を実行 → 音が鳴り、モニターにイベントが流れる

### IAC が一覧に出ないとき

macOS の **Audio MIDI 設定 → IAC ドライバ → 「装置はオンライン」を ON**。
日本語環境ではポート名が `IACドライバ バス1` になる (英語例の `IAC Driver Bus 1` ではない)。

### MIDI なしで音だけ確認

**「Test tone」** ボタンで Web Audio 経路だけを単体確認できる (C4 を 0.4 秒)。

## `.orbs` 例

[`example.orbs`](example.orbs) — IAC へ C メジャースケールを送る最小例。
VS Code 拡張でポートを `IACドライバ バス1` に合わせて実行する。

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
- ポリフォニックシンセ: ノートごとに OscillatorNode + GainNode (ADSR 風エンベロープ) + 共有 lowpass
- pitch bend はチャンネル単位で保持し、発音中・新規ノートの detune に反映
