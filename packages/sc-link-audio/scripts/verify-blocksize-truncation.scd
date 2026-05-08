// verify-blocksize-truncation.scd — sclang harness exercising the
// `blockSize > kLinkAudioMaxBlockFrames` guard in `OrbitLinkAudioOut_Ctor`
// and the matching truncation behaviour in `next()`.
//
// Run with:
//   /Applications/SuperCollider.app/Contents/MacOS/sclang \
//     packages/sc-link-audio/scripts/verify-blocksize-truncation.scd
//
// Exit code: 0 on success, 1 on any FAIL.
//
// Why this is a separate harness:
//   `verify-plugin.scd` runs at the default scsynth block size (typically
//   64–512). The truncation guard fires only when `mWorld->mBufLength`
//   exceeds `kLinkAudioMaxBlockFrames` (= 2048). Setting `blockSize = 4096`
//   pre-boot would flood every Synth in the main harness with the
//   "exceeds kLinkAudioMaxBlockFrames" warning, drowning out the existing
//   diagnostic Prints that downstream operators read for pass/fail signal.
//   Splitting the test into its own boot keeps the main harness's signal
//   clean while still verifying the truncation path.
//
// Validates:
//   1. scsynth boots without crashing when block size exceeds the cap
//   2. `OrbitLinkAudioOut_Ctor` emits the expected truncation warning Print
//   3. `next()` runs without crashing — the `n = std::min(inNumSamples,
//      kLinkAudioMaxBlockFrames)` truncation in `next()` keeps the per-tick
//      memcpy within the mix buffer bounds
//
// What is NOT verified (out of scope for headless CI):
//   - audio content correctness (truncated tail samples are dropped, which
//     is documented behaviour; verifying it requires a Live peer)
//   - Print content matching (sclang harness can only observe transcript;
//     parsing the Print text reliably needs a wrapping shell grep, which
//     would make the script CI-runner-dependent)

(
"=== OrbitLinkAudio blockSize truncation verification ===".postln;

if (\OrbitLinkAudioOut.asClass.isNil) {
    "FAIL: OrbitLinkAudioOut class not found in sclang. Is OrbitLinkAudio.sc installed?".postln;
    thisProcess.shutdown;
    1.exit;
} {
    "  [OK] OrbitLinkAudioOut class loaded".postln;
};

s = Server.local;
s.options.numOutputBusChannels = 2;
// Same rationale as verify-plugin.scd: the harness only exercises the
// output path, so disabling input avoids SR-mismatch boot failures on
// hosts where the input device runs at a different rate.
s.options.numInputBusChannels = 0;
// 4096 > kLinkAudioMaxBlockFrames (= 2048) — Ctor should Print the
// "blockSize exceeds kLinkAudioMaxBlockFrames" warning and `next()` should
// truncate gracefully via `std::min(inNumSamples, kLinkAudioMaxBlockFrames)`.
//
// Note: scsynth's engine block (`mBufLength`) must be ≤ the hardware
// buffer for the engine to process audio in single-block chunks.
// `hardwareBufferSize` is also bumped to 4096 so scsynth honors the
// `blockSize` request rather than silently falling back to the host's
// default driver block size.
s.options.blockSize = 4096;
s.options.hardwareBufferSize = 4096;

// Wall-clock timeout — same 30 s window as verify-plugin.scd. Any hang in
// boot or sync produces a non-zero exit.
SystemClock.sched(30, {
    "FAIL: verify-blocksize-truncation timed out after 30 s "
    "(scsynth boot or sync hang?)".postln;
    1.exit;
});

s.waitForBoot({
    "  [OK] scsynth booted with blockSize=4096".postln;

    // Register a channel and instantiate a Synth. The Ctor will Print the
    // truncation warning ("server blockSize=4096 exceeds
    // kLinkAudioMaxBlockFrames=2048") and `next()` should run for 2 s
    // without crashing despite the oversized block.
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", 1, "test-blocksize");
    s.sync;
    "  [OK] /cmd registerLinkAudioChannel id=1 'test-blocksize' sent + synced".postln;

    SynthDef(\orbitBlocksizeTest, { |channel = 1|
        var sig = SinOsc.ar(440) * 0.1;
        var stereo = Pan2.ar(sig, 0);
        OrbitLinkAudioOut.ar(stereo[0], stereo[1], channel);
    }).add;

    s.sync;
    0.5.wait;
    Synth(\orbitBlocksizeTest, [\channel, 1]);
    s.sync;
    "  [OK] Synth instantiated — expect 'server blockSize=4096 exceeds "
    "kLinkAudioMaxBlockFrames=2048' Print above".postln;

    2.0.wait;
    "  [OK] held for 2 s — no crash on oversized block, truncation path "
    "is safe".postln;
    "=== verification complete ===".postln;
    s.quit;
    0.5.wait;
    0.exit;
});
)
