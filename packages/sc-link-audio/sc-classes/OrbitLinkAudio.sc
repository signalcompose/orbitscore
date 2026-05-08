// OrbitLinkAudio.sc — sclang class stub for the `OrbitLinkAudioOut` UGen.
//
// This file makes the C++ UGen visible to `SynthDef` builders in sclang.
// Pair it with `OrbitLinkAudio.scx` in `~/Library/Application Support/
// SuperCollider/Extensions/` so sclang's class library picks it up at
// startup.
//
// Usage:
//
//   SynthDef(\orbitPlayBufLink, { |bufnum, amp = 1, pan = 0, channel = 0|
//     var sig = PlayBuf.ar(1, bufnum, doneAction: 2);
//     var stereo = Pan2.ar(sig * amp, pan);
//     OrbitLinkAudioOut.ar(stereo[0], stereo[1], channel);
//   }).add;
//
// Channel-name registration is delivered out-of-band via OSC:
//
//   s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", channelId, name);
//
// See `packages/engine/src/audio/supercollider/event-scheduler.ts` for the
// production dispatch path that emits the `/cmd` from the engine side.

OrbitLinkAudioOut : UGen {
    *ar { |left, right, channel = 0|
        ^this.multiNew('audio', left, right, channel);
    }

    checkInputs {
        // *ar forces this UGen's own rate to 'audio', so no self-rate check.
        // Both stereo inputs must be audio-rate so the C++ side reads valid
        // sample buffers. `channel` must NOT be audio-rate — the C++ Ctor
        // reads it once via IN0(2), so an audio-rate signal would silently
        // use only the first sample.
        if (inputs[0].rate != 'audio', { ^"left input must be audio rate" });
        if (inputs[1].rate != 'audio', { ^"right input must be audio rate" });
        if (inputs[2].rate == 'audio', { ^"channel must be control or scalar rate" });
        ^this.checkValidInputs;
    }
}
