// OrbitScore 用の PlayBuf SynthDef を作成してバイナリとして保存

(
// サンプル再生用の基本的な SynthDef
SynthDef(\orbitPlayBuf, {
    arg out = 0,           // 出力バス
        bufnum = 0,        // バッファ番号
        rate = 1,          // 再生速度
        amp = 0.5,         // 音量
        pan = 0,           // パン (-1 左, 0 中央, 1 右)
        startPos = 0,      // 開始位置（秒）
        loop = 0;          // ループするか（0=しない、1=する）
    
    var sig, env;
    
    // バッファから再生
    sig = PlayBuf.ar(
        numChannels: 1,
        bufnum: bufnum,
        rate: rate * BufRateScale.kr(bufnum),
        trigger: 1,
        startPos: startPos * BufSampleRate.kr(bufnum),
        loop: loop,
        doneAction: 2  // 再生終了後にシンセを自動削除
    );
    
    // ステレオ化してパン
    sig = Pan2.ar(sig, pan, amp);
    
    // 出力
    Out.ar(out, sig);
}).writeDefFile(
    dir: "/Users/yamato/Src/proj_livecoding/orbitscore/packages/engine/supercollider/synthdefs".standardizePath
);

"✅ SynthDef 'orbitPlayBuf' を保存しました！".postln;
)
