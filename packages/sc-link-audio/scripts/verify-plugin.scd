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
//      no-op for an existing id; negative: malformed/missing id rejected
//      via sentinel default)
//   4. SynthDef using OrbitLinkAudioOut compiles + instantiates
//   5. UGen `next()` runs for 2 s without server crash on a registered id
//   6. UGen `next()` skips safely when given an unregistered channel id
//   7. Two Synths sharing one channel id (sum-by-name) accumulate into a
//      single LinkAudioSink without crashing — exercises the tick-transition
//      flush path in `next()`. Note: with no Live peer subscribed during the
//      headless run, the int16 conversion + `bh.commit(...)` paths are not
//      exercised (BufferHandle is falsy). Audio content correctness requires
//      the Live-side check in `verify-live-receive.scd`.
//   8. Two Synths on two distinct registered channel ids run concurrently
//      (cross-channel isolation no-crash check)
//
// Note on assertion strength: this harness can only detect a crash, missing
// class, or boot timeout. The Print diagnostics added in iter 1 (sink null
// at Ctor, /cmd reject paths, re-register no-op) are visible in the
// transcript but not asserted from sclang — verifying their content
// requires either an OSC reply protocol or a wrapper that grep's stdout.
// Each `/cmd` is followed by `s.sync` so a regression that would crash
// scsynth from inside the handler surfaces immediately rather than at the
// next sync point.

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
    // even if no Live peer is currently subscribed. s.sync flushes the
    // command queue so a crash inside the handler is observed before the
    // next test step.
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", 1, "test-channel");
    s.sync;
    "  [OK] /cmd registerLinkAudioChannel id=1 'test-channel' sent + synced".postln;

    // Negative: empty channel name. Handler should log a rejection and not
    // crash. Look for "empty channel name rejected" in the transcript above.
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", 2, "");
    s.sync;
    "  [OK] /cmd registerLinkAudioChannel id=2 '' (empty) sent — expect 'rejected' Print above".postln;

    // Negative: rename of an existing id. Handler is a no-op + Print to avoid
    // the setName-vs-BufferHandle race documented in channel_registry.cpp.
    // Look for "re-registration of channel id 1 ignored" above.
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", 1, "test-channel-renamed");
    s.sync;
    "  [OK] /cmd registerLinkAudioChannel id=1 rename sent — expect 're-registration ignored' Print above".postln;

    // Negative: non-positive id. The handler's `geti(-1)` default + `id <= 0`
    // sentinel reject should fire and Print, simulating a TS-side
    // serialization regression that drops the integer argument.
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", -5, "should-not-register");
    s.sync;
    "  [OK] /cmd registerLinkAudioChannel id=-5 sent — expect 'malformed integer id' Print above".postln;

    SynthDef(\orbitLinkAudioTest, { |channel = 1|
        var sig = SinOsc.ar(440) * 0.1;
        var stereo = Pan2.ar(sig, 0);
        OrbitLinkAudioOut.ar(stereo[0], stereo[1], channel);
    }).add;

    s.sync;
    0.5.wait;
    Synth(\orbitLinkAudioTest, [\channel, 1]);
    "  [OK] SynthDef instantiated on registered channel id=1 (no 'no registered sink' Print expected)".postln;

    // Negative: unregistered channel id. Ctor logs a Print + next() early
    // returns on null sink. Look for "channel id 999 has no registered sink".
    // s.sync ensures the Ctor's Print flushes before the [OK] line, matching
    // the pattern used for the registered Synth above.
    Synth(\orbitLinkAudioTest, [\channel, 999]);
    s.sync;
    "  [OK] SynthDef instantiated on unregistered channel id=999 — expect 'no registered sink' Print above".postln;

    // Sum-by-name: two Synths bound to the same registered channel id should
    // accumulate into the SinkEntry's mix buffer rather than last-writer-wins.
    // We can't assert the actual mixed audio from sclang — verifying a clean
    // tick-transition flush requires a Live peer or an OSC-replyable
    // diagnostic — so this step only verifies that the accumulation +
    // deferred-commit code path doesn't crash scsynth when two Synths run
    // concurrently on the same channel.
    Synth(\orbitLinkAudioTest, [\channel, 1]);
    Synth(\orbitLinkAudioTest, [\channel, 1]);
    s.sync;
    1.0.wait;
    "  [OK] two Synths on channel id=1 ran concurrently (sum-by-name path no-crash)".postln;

    // Cross-channel isolation: register a second channel and run a Synth on
    // each id concurrently. A regression that aliased SinkEntry pointers (e.g.
    // a hash collision or a refactor that shared mix state across channels)
    // would either crash here or silently corrupt — neither would be caught by
    // the same-channel sum step alone, since that exercises only one entry.
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", 3, "test-channel-3");
    s.sync;
    Synth(\orbitLinkAudioTest, [\channel, 1]);
    Synth(\orbitLinkAudioTest, [\channel, 3]);
    s.sync;
    1.0.wait;
    "  [OK] Synths on channels id=1 and id=3 ran concurrently (cross-channel isolation no-crash)".postln;

    2.0.wait;
    "  [OK] held for 2 s — no crash, no errors above => plugin is functional".postln;
    "=== verification complete ===".postln;
    s.quit;
    0.5.wait;
    0.exit;
});
)
