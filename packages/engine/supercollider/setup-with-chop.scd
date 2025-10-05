s.boot;

s.waitForBoot({
    (
    // chop サポート付き SynthDef
    SynthDef(\orbitPlayBuf, {
        arg out = 0, bufnum = 0, rate = 1, amp = 0.5, pan = 0, 
            startPos = 0,      // 開始位置（秒）
            duration = -1;     // 再生時間（秒、-1 = 全体）
        
        var sig, env, actualDuration;
        
        // 実際の再生時間を計算
        actualDuration = duration;
        if (duration <= 0) {
            actualDuration = BufDur.kr(bufnum) - startPos;
        };
        
        // バッファから再生
        sig = PlayBuf.ar(
            numChannels: 1,
            bufnum: bufnum,
            rate: rate * BufRateScale.kr(bufnum),
            trigger: 1,
            startPos: startPos * BufSampleRate.kr(bufnum),
            loop: 0
        );
        
        // エンベロープで再生時間を制御
        env = EnvGen.kr(
            Env.linen(0.001, actualDuration - 0.002, 0.001),
            doneAction: 2  // 再生終了後にシンセを自動削除
        );
        
        sig = sig * env;
        
        // ステレオ化してパン
        sig = Pan2.ar(sig, pan, amp);
        
        // 出力
        Out.ar(out, sig);
    }).writeDefFile("/Users/yamato/Src/proj_livecoding/orbitscore/packages/engine/supercollider/synthdefs".standardizePath);
    
    "✅ chop サポート付き SynthDef saved!".postln;
    )
});