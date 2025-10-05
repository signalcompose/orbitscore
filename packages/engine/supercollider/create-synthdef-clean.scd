(
SynthDef(\orbitPlayBuf, {
    arg out = 0, bufnum = 0, rate = 1, amp = 0.5, pan = 0, startPos = 0;
    var sig = PlayBuf.ar(1, bufnum, rate * BufRateScale.kr(bufnum), 
                         startPos: startPos * BufSampleRate.kr(bufnum),
                         loop: 0, doneAction: 2);
    Out.ar(out, Pan2.ar(sig, pan, amp));
}).writeDefFile("/Users/yamato/Src/proj_livecoding/orbitscore/packages/engine/supercollider/synthdefs".standardizePath);

"✅ SynthDef saved!".postln;
)