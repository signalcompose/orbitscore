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

// 出力先 synthdefs/ ディレクトリ。旧来は proj_livecoding を絶対パスで
// ハードコードしていたが、チェックアウト場所に依存しないよう、この .scd の
// 位置 (nowExecutingPath) を基準に相対解決する。
~synthdefDir = PathName(thisProcess.nowExecutingPath).pathOnly ++ "synthdefs";
("synthdefs dir: " ++ ~synthdefDir).postln;

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
}).writeDefFile(~synthdefDir);

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
}).writeDefFile(~synthdefDir);

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
}).writeDefFile(~synthdefDir);

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
}).writeDefFile(~synthdefDir);

"✅ fxNormalizer SynthDef saved!".postln;

// ============================================
// LinkAudio: orbitPlayBufLink (#209)
// orbitPlayBuf と同じ再生/エンベロープロジック。出力のみ Out.ar から
// OrbitLinkAudioOut(L, R, channel) に差し替えて Ableton Link Audio に commit する。
// 引数はエンジンの link 経路 dispatch と一致: bufnum/amp/pan/rate/startPos/duration/channel。
// OrbitLinkAudio.scx (OrbitLinkAudioOut UGen) が無い環境ではコンパイルできないため
// プラグイン有無でガードする (hardware-only ビルドを壊さない)。
// ============================================
if (\OrbitLinkAudioOut.asClass.notNil) {
    SynthDef(\orbitPlayBufLink, {
        arg bufnum = 0, rate = 1, amp = 0.5, pan = 0,
            startPos = 0,      // 開始位置（秒）
            duration = 0,      // 再生時間（秒、0 = 全体）
            channel = 0;       // LinkAudio channel id (registry が解決)

        var sig, env, actualDuration, fadeOut, sustain, stereo;

        actualDuration = Select.kr(duration > 0, [
            BufDur.kr(bufnum) - startPos,
            duration
        ]);

        sig = PlayBuf.ar(
            numChannels: 1,
            bufnum: bufnum,
            rate: rate * BufRateScale.kr(bufnum),
            trigger: 1,
            startPos: startPos * BufSampleRate.kr(bufnum),
            loop: 0,
            doneAction: 0
        );

        // クリック音防止のフェードアウト + 再生終了で自動削除 (hardware 経路と同じ)
        fadeOut = min(0.008, actualDuration * 0.04);
        sustain = max(0, actualDuration - fadeOut);
        env = EnvGen.kr(
            Env.linen(0, sustain, fadeOut),
            doneAction: 2
        );
        sig = sig * env;

        // ステレオ化してパン → Out.ar の代わりに LinkAudio へ commit
        stereo = Pan2.ar(sig, pan, amp);
        OrbitLinkAudioOut.ar(stereo[0], stereo[1], channel);
    }).writeDefFile(~synthdefDir);
    "✅ orbitPlayBufLink SynthDef saved!".postln;

    // orbitLinkAudioKeepalive (#209): a PERSISTENT per-channel committer that
    // commits silence every audio block. LinkAudio is a CONTINUOUS audio stream;
    // if we only commit while a transient sample synth is alive, the stream has
    // gaps between hits (0.5s on / 1.5s off) → the receiver underruns (level
    // drift at low latency) or plays the holes (choppy at high latency). One
    // keepalive per channel keeps the stream unbroken; orbitPlayBufLink synths
    // sum their audio on top via the plugin's per-channel mix accumulator.
    SynthDef(\orbitLinkAudioKeepalive, { |channel = 0|
        OrbitLinkAudioOut.ar(DC.ar(0), DC.ar(0), channel);
    }).writeDefFile(~synthdefDir);
    "✅ orbitLinkAudioKeepalive SynthDef saved!".postln;
} {
    "⚠️ OrbitLinkAudioOut not installed — skipping LinkAudio SynthDefs (hardware-only build)".postln;
};

"✅ All SynthDefs saved!".postln;
0.exit;