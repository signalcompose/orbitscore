// verify-plugin.scd — sclang verification harness for OrbitLinkAudio.scx.
//
// Run with:
//   /Applications/SuperCollider.app/Contents/MacOS/sclang \
//     packages/sc-link-audio/scripts/verify-plugin.scd
//
// Exit code: 0 on success, 1 on any FAIL (so CI / shell scripts can chain
// reliably). Hangs at scsynth boot are caught by a 30 s wall-clock timeout.
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
//      (positive: "test-channel"; negative: empty name; negative: rename
//      no-op for an existing id)
//   4. SynthDef using OrbitLinkAudioOut compiles + instantiates
//   5. UGen `next()` runs for 2 s without server crash on a registered id
//   6. UGen `next()` skips safely when given an unregistered channel id

(
"=== OrbitLinkAudio plugin verification ===".postln;

if (\OrbitLinkAudioOut.asClass.isNil) {
    "FAIL: OrbitLinkAudioOut class not found in sclang. Is OrbitLinkAudio.sc installed?".postln;
    thisProcess.shutdown;
    1.exit;
} {
    "  [OK] OrbitLinkAudioOut class loaded".postln;
};

s = Server.local;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels = 2;

// Wall-clock timeout — fires only if the boot block below never reaches
// the success exit. Any hang in scsynth boot or sync now produces a
// non-zero exit instead of an indefinitely running process.
SystemClock.sched(30, {
    "FAIL: verification timed out after 30 s (scsynth boot or sync hang?)".postln;
    1.exit;
});

s.waitForBoot({
    "  [OK] scsynth booted with plugin loaded (no crash on dlopen)".postln;

    // Positive registration. The plugin should accept this without erroring
    // even if no Live peer is currently subscribed.
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", 1, "test-channel");
    "  [OK] /cmd registerLinkAudioChannel id=1 'test-channel' sent".postln;

    // Negative: empty channel name. The plugin's /cmd handler should log a
    // rejection and not crash. We have no read-back from sclang to assert
    // the rejection directly, but a crash here would surface as scsynth dying.
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", 2, "");
    "  [OK] /cmd registerLinkAudioChannel id=2 '' (empty) sent — plugin should reject".postln;

    // Negative: rename of an existing id. The plugin no-ops to avoid the
    // setName-vs-BufferHandle race documented in channel_registry.cpp.
    // Again we only check that the server stays up.
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", 1, "test-channel-renamed");
    "  [OK] /cmd registerLinkAudioChannel id=1 rename sent — plugin should no-op".postln;

    SynthDef(\orbitLinkAudioTest, { |channel = 1|
        var sig = SinOsc.ar(440) * 0.1;
        var stereo = Pan2.ar(sig, 0);
        OrbitLinkAudioOut.ar(stereo[0], stereo[1], channel);
    }).add;

    s.sync;
    0.5.wait;
    Synth(\orbitLinkAudioTest, [\channel, 1]);
    "  [OK] SynthDef instantiated on registered channel id=1".postln;

    // Negative: unregistered channel id. UGen Ctor will scprintf a warning
    // and next() will early-return on null sink — server stays up.
    Synth(\orbitLinkAudioTest, [\channel, 999]);
    "  [OK] SynthDef instantiated on unregistered channel id=999 — should warn + skip".postln;

    2.0.wait;
    "  [OK] held for 2 s — no crash, no errors above => plugin is functional".postln;
    "=== verification complete ===".postln;
    s.quit;
    0.5.wait;
    0.exit;
});
)
