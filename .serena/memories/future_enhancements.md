# Future Enhancements

## Audio File Format Support

### 現状
- 現在、`audio-slicer.ts`（および`slicing/`モジュール）はWAVファイルのみをサポート
- `WaveFile`ライブラリを使用してWAVファイルの読み込み・スライス・書き込みを行っている

### 改善案
**SuperColliderをオーディオエンジンに使っているのだから、WAV以外のファイルフォーマットにも対応する**

#### 対応すべきフォーマット
- **AIFF** - Apple標準フォーマット
- **FLAC** - ロスレス圧縮
- **MP3** - 一般的な圧縮フォーマット
- **OGG** - オープンソース圧縮フォーマット
- **M4A/AAC** - Apple/iTunes標準

#### 実装方針
1. **SuperColliderのバッファロード機能を活用**
   - SuperColliderは`/b_allocRead`で多様なフォーマットをサポート
   - スライス処理もSuperCollider側で行う可能性を検討

2. **Node.js側での変換**
   - `ffmpeg`や`sox`を使って、読み込み時にWAVに変換
   - または、各フォーマットに対応したライブラリを使用

3. **ハイブリッドアプローチ**
   - SuperColliderで直接サポートされているフォーマットはそのまま使用
   - それ以外は変換してからスライス

#### 関連ファイル
- `packages/engine/src/audio/slicing/wav-processor.ts` → より汎用的な`audio-processor.ts`に拡張
- `packages/engine/src/audio/supercollider-player.ts` → 既に`loadBuffer()`で任意のファイルパスを受け取っている

#### 優先度
- **中**: ユーザビリティ向上に寄与するが、現在の機能で基本的な使用は可能

#### 関連Issue
- 将来的に新しいIssueとして作成予定

---

## その他の将来的な機能拡張

### グラニュラーシンセシス再生モード
- 現在：テープレコーダー風の再生（ピッチが変わる）
- 将来：元の音のまま長さだけ変わる再生モード
- 実装：SuperColliderのグラニュラーシンセシスSynthDefを作成

### MIDI出力サポート（アーカイブ済み）
- v1.0ではMIDIベースだったが、v2.0でオーディオベースに移行
- 将来的にMIDI出力を再度サポートする可能性あり