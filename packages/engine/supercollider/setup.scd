// ============================================
// OrbitScore SuperCollider Setup
// ============================================
// このファイルは SynthDef を生成・更新するために使用します
// 
// 使い方:
//   /Applications/SuperCollider.app/Contents/MacOS/sclang setup.scd
//
// 注意:
//   - このファイルは削除しないでください
//   - 新しいエフェクトを追加する時はこのファイルを更新してください
//   - 実行すると synthdefs/ ディレクトリに .scsyndef ファイルが生成されます
// ============================================

// orbitPlayBuf SynthDef (chop サポート付き)
SynthDef(\orbitPlayBuf, {
    arg out = 0, bufnum = 0, rate = 1, amp = 0.5, pan = 0, 
        startPos = 0,      // 開始位置（秒）
        duration = 0;      // 再生時間（秒、0 = 全体）
    
    var sig, env, actualDuration, fadeIn, fadeOut, sustain;
    
    // 実際の再生時間を計算（0なら全体、それ以外なら指定された時間）
    actualDuration = Select.kr(duration > 0, [
        BufDur.kr(bufnum) - startPos,  // duration <= 0 の場合
        duration                         // duration > 0 の場合
    ]);
    
    // バッファから再生
    sig = PlayBuf.ar(
        numChannels: 1,
        bufnum: bufnum,
        rate: rate * BufRateScale.kr(bufnum),
        trigger: 1,
        startPos: startPos * BufSampleRate.kr(bufnum),
        loop: 0,
        doneAction: 0  // duration制御はエンベロープで行う
    );
    
    // エンベロープで再生時間を制御（クリック音防止のためフェードアウト）
    // フェード時間を再生時間に応じて調整（短い音ほど短いフェード）
    // アタック感を保つためフェードインなし、フェードアウトのみ
    fadeIn = 0;  // フェードインなし
    fadeOut = min(0.008, actualDuration * 0.04);  // 再生時間の4%、最大8ms
    sustain = max(0, actualDuration - fadeOut);
    
    env = EnvGen.kr(
        Env.linen(fadeIn, sustain, fadeOut),
        doneAction: 2  // 再生終了後にシンセを自動削除
    );
    
    sig = sig * env;
    
    // ステレオ化してパン
    sig = Pan2.ar(sig, pan, amp);
    
    // 出力
    Out.ar(out, sig);
}).writeDefFile("/Users/yamato/Src/proj_livecoding/orbitscore/packages/engine/supercollider/synthdefs".standardizePath);

"✅ orbitPlayBuf SynthDef saved!".postln;

// ============================================
// Global Mastering Effect SynthDefs
// ============================================

// Compressor (Compander)
SynthDef(\fxCompressor, {
    arg threshold = 0.5,    // 圧縮開始レベル (0-1)
        ratio = 0.5,        // 圧縮比 (0-1, 0=1:1, 1=inf:1)
        attack = 0.01,      // アタックタイム（秒）
        release = 0.1,      // リリースタイム（秒）
        makeupGain = 1.0;   // メイクアップゲイン (0-2)
    
    var in, compressed;
    
    // バス0から読み取り
    in = In.ar(0, 2);
    
    // Compander で圧縮
    compressed = Compander.ar(
        in,
        in,
        threshold,
        1.0,                    // Below threshold: 1:1
        ratio,                  // Above threshold: compression ratio
        attack,
        release
    );
    
    // メイクアップゲインを適用
    compressed = compressed * makeupGain;
    
    // バス0に書き戻し（ReplaceOut）
    ReplaceOut.ar(0, compressed);
}).writeDefFile("/Users/yamato/Src/proj_livecoding/orbitscore/packages/engine/supercollider/synthdefs".standardizePath);

"✅ fxCompressor SynthDef saved!".postln;

// Limiter
SynthDef(\fxLimiter, {
    arg level = 0.99,       // リミッターレベル (0-1)
        duration = 0.01;    // ルックアヘッドタイム（秒）
    
    var in, limited;
    
    // バス0から読み取り
    in = In.ar(0, 2);
    
    // Limiter で制限
    limited = Limiter.ar(in, level, duration);
    
    // バス0に書き戻し
    ReplaceOut.ar(0, limited);
}).writeDefFile("/Users/yamato/Src/proj_livecoding/orbitscore/packages/engine/supercollider/synthdefs".standardizePath);

"✅ fxLimiter SynthDef saved!".postln;

// Normalizer
SynthDef(\fxNormalizer, {
    arg level = 1.0,        // 正規化レベル (0-1)
        duration = 0.01;    // ルックアヘッドタイム（秒）
    
    var in, normalized;
    
    // バス0から読み取り
    in = In.ar(0, 2);
    
    // Normalizer で正規化
    normalized = Normalizer.ar(in, level, duration);
    
    // バス0に書き戻し
    ReplaceOut.ar(0, normalized);
}).writeDefFile("/Users/yamato/Src/proj_livecoding/orbitscore/packages/engine/supercollider/synthdefs".standardizePath);

"✅ fxNormalizer SynthDef saved!".postln;

"✅ All SynthDefs saved!".postln;
0.exit;