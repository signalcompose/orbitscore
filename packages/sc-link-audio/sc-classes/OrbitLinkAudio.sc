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
// production dispatch path. (TS-side `/cmd` wiring lands in Step 4.)

OrbitLinkAudioOut : UGen {
    *ar { |left, right, channel = 0|
        ^this.multiNew('audio', left, right, channel);
    }

    checkInputs {
        // OrbitLinkAudioOut has no audible output; treat it as a sink and skip
        // SC's default rate-checks. We still need both audio inputs to be
        // audio-rate so the C++ side reads valid sample buffers.
        if (rate != 'audio', { ^("OrbitLinkAudioOut must be audio rate").format });
        if (inputs[0].rate != 'audio', { ^("left input must be audio rate") });
        if (inputs[1].rate != 'audio', { ^("right input must be audio rate") });
        ^this.checkValidInputs;
    }
}
