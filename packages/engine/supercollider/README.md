# SuperCollider SynthDef Management

このディレクトリには、OrbitScoreで使用するSuperColliderのSynthDef定義とビルドスクリプトが含まれています。

## ディレクトリ構成

```
supercollider/
├── README.md           # このファイル
├── setup.scd           # SynthDef定義とビルドスクリプト
└── synthdefs/          # コンパイル済み.scsyndefファイル
    ├── orbitPlayBuf.scsyndef
    ├── fxCompressor.scsyndef
    ├── fxLimiter.scsyndef
    └── fxNormalizer.scsyndef
```

## SynthDefのビルド方法

### 前提条件

- SuperCollider 3.14.0以上がインストールされていること
- macOSの場合: `/Applications/SuperCollider.app/Contents/MacOS/sclang` が存在すること

### ビルド手順

1. **既存のsclangプロセスを確認・終了**
   ```bash
   # 既存のsclangプロセスを確認
   ps aux | grep -E "(sclang|scsynth)" | grep -v grep
   
   # もし起動していたら終了
   killall sclang
   ```

2. **SynthDefをビルド**
   ```bash
   cd packages/engine/supercollider
   /Applications/SuperCollider.app/Contents/MacOS/sclang setup.scd
   ```

3. **ビルド成功の確認**
   
   以下のメッセージが表示されればOK：
   ```
   ✅ orbitPlayBuf SynthDef saved!
   ✅ fxCompressor SynthDef saved!
   ✅ fxLimiter SynthDef saved!
   ✅ fxNormalizer SynthDef saved!
   ✅ All SynthDefs saved!
   ```

4. **生成されたファイルを確認**
   ```bash
   ls -la synthdefs/
   ```
   
   各`.scsyndef`ファイルのタイムスタンプが更新されていることを確認してください。

### トラブルシューティング

#### ❌ sclangが終了しない

**症状**: コマンドが終了せず、ハングする

**原因**: `setup.scd`の最後の`0.exit;`が実行されていない

**解決策**:
```bash
# 別のターミナルで強制終了
killall sclang

# setup.scdの最後に0.exit;があることを確認
tail packages/engine/supercollider/setup.scd
```

#### ❌ 構文エラー: `ERROR: syntax error, unexpected VAR`

**症状**: 
```
ERROR: syntax error, unexpected VAR, expecting '}'
  in interpreted text
  line XX char X:
      var fadeIn, fadeOut, sustain;
```

**原因**: SuperColliderでは`var`宣言はブロックの最初に置く必要がある

**解決策**: SynthDef内の`var`宣言をすべて関数の最初にまとめる
```supercollider
SynthDef(\example, {
    arg out = 0;
    
    // ✅ 正しい: すべてのvar宣言を最初に
    var sig, env, fadeIn, fadeOut, sustain;
    
    // ❌ 間違い: 途中でvar宣言
    sig = SinOsc.ar(440);
    var env;  // これはエラー
});
```

#### ❌ .scsyndefファイルが更新されない

**症状**: ビルドは成功するが、タイムスタンプが古いまま

**原因**: 
1. sclangプロセスが複数起動している
2. `0.exit;`が実行される前にプロセスが終了している

**解決策**:
```bash
# すべてのsclangプロセスを終了
killall sclang

# 再度ビルド
cd packages/engine/supercollider
/Applications/SuperCollider.app/Contents/MacOS/sclang setup.scd

# 成功メッセージを確認
# ✅ All SynthDefs saved! が表示されるまで待つ
```

## SynthDefの編集

### orbitPlayBuf (メインの再生SynthDef)

`setup.scd`の`SynthDef(\orbitPlayBuf, { ... })`セクションを編集します。

**主要なパラメータ**:
- `bufnum`: バッファ番号
- `rate`: 再生速度（1.0 = 通常、0.5 = 半分、2.0 = 2倍速）
- `amp`: 振幅（音量）
- `pan`: パン（-1.0 = 左、0 = 中央、1.0 = 右）
- `startPos`: 開始位置（秒）
- `duration`: 再生時間（秒、0 = 全体）

**エンベロープ設定**:
```supercollider
fadeIn = 0;  // フェードイン時間（秒）
fadeOut = min(0.008, actualDuration * 0.04);  // フェードアウト時間（秒）
```

- `fadeIn`: アタック感を保つため現在は0（フェードインなし）
- `fadeOut`: クリックノイズ防止のため、再生時間の4%（最大8ms）

### エフェクトSynthDef

- `fxCompressor`: コンプレッサー
- `fxLimiter`: リミッター
- `fxNormalizer`: ノーマライザー

これらは`setup.scd`の後半で定義されています。

## 注意事項

1. **SynthDefを変更したら必ずビルド**: `.scd`ファイルを編集しただけでは反映されません
2. **既存のプロセスを終了**: ビルド前に`killall sclang`を実行することを推奨
3. **成功メッセージを確認**: `✅ All SynthDefs saved!`が表示されるまで待つ
4. **タイムスタンプを確認**: `ls -la synthdefs/`でファイルが更新されていることを確認

## 参考

- SuperCollider公式ドキュメント: https://doc.sccode.org/
- SynthDef: https://doc.sccode.org/Classes/SynthDef.html
- Env (Envelope): https://doc.sccode.org/Classes/Env.html
