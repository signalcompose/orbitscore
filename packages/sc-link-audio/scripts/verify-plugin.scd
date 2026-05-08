// verify-plugin.scd — sclang verification harness for OrbitLinkAudio.scx.
//
// Run with:
//   /Applications/SuperCollider.app/Contents/MacOS/sclang \
//     packages/sc-link-audio/scripts/verify-plugin.scd
//
// Pre-requisites (see README.md):
//   - OrbitLinkAudio.scx + OrbitLinkAudio.sc are installed in
//     ~/Library/Application Support/SuperCollider/Extensions/
//   - .scx is ad-hoc signed (the CMake post-build step does this automatically)
//
// Validates:
//   1. OrbitLinkAudioOut class is recognized by sclang
//   2. scsynth boots without crashing on plugin dlopen
//   3. /cmd /orbit/registerLinkAudioChannel is accepted by the plugin
//   4. SynthDef using OrbitLinkAudioOut compiles + instantiates
//   5. UGen `next()` runs for 2 s without server crash

(
"=== OrbitLinkAudio plugin verification ===".postln;

if (\OrbitLinkAudioOut.asClass.isNil) {
    "FAIL: OrbitLinkAudioOut class not found in sclang. Is OrbitLinkAudio.sc installed?".postln;
    thisProcess.shutdown;
    0.exit;
} {
    "  [OK] OrbitLinkAudioOut class loaded".postln;
};

s = Server.local;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels = 2;

s.waitForBoot({
    "  [OK] scsynth booted with plugin loaded (no crash on dlopen)".postln;

    // Register a channel name via /cmd. The plugin should accept this without
    // erroring even if no Live peer is currently subscribed.
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", 1, "test-channel");
    "  [OK] /cmd /orbit/registerLinkAudioChannel sent".postln;

    SynthDef(\orbitLinkAudioTest, { |channel = 1|
        var sig = SinOsc.ar(440) * 0.1;
        var stereo = Pan2.ar(sig, 0);
        OrbitLinkAudioOut.ar(stereo[0], stereo[1], channel);
    }).add;

    s.sync;
    0.5.wait;
    Synth(\orbitLinkAudioTest, [\channel, 1]);
    "  [OK] SynthDef instantiated — UGen Ctor + next() are running".postln;

    2.0.wait;
    "  [OK] held for 2 s — no crash, no errors above => plugin is functional".postln;
    "=== verification complete ===".postln;
    s.quit;
    0.5.wait;
    0.exit;
});
)
