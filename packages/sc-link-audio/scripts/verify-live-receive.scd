// verify-live-receive.scd — manual end-to-end harness against Ableton Live.
//
// Unlike `verify-plugin.scd` (which only checks that the plugin loads and
// runs without crashing in scsynth), this script publishes a continuous,
// recognizable test tone to the LinkAudio session for ~30 s so the operator
// can verify in Live's UI that:
//   - the channel name appears in the Link Audio dropdown
//   - audio is actually received (level meters move, signal is audible)
//
// Pre-requisites:
//   1. OrbitLinkAudio.scx + OrbitLinkAudio.sc installed (see README.md)
//   2. Ableton Live 12.4+ open with an audio track set to receive Link Audio
//      from "OrbitScore" (the peer name the plugin advertises)
//   3. Link enabled in Live
//
// Run:
//   /Applications/SuperCollider.app/Contents/MacOS/sclang \
//     packages/sc-link-audio/scripts/verify-live-receive.scd
//
// Expected operator observations (E2E checklist §B "single channel publish"):
//   - "test-tone" appears in Live's Link Audio source list within ~2 s
//   - Routing the track to that channel produces a 440 Hz / 660 Hz alternating
//     tone at -20 dBFS (quiet enough not to startle, loud enough to read on
//     a meter)
//   - Tempo / phase follow Live's transport (verify by changing Live's BPM —
//     scsynth side has no transport of its own, so the tone keeps playing
//     but Link clock advances at Live's rate)
//
// Sum-by-name (E2E checklist §C) is NOT exercised here — Step 2.3 work.

(
"=== OrbitLinkAudio live-receive verification ===".postln;
"  Open Live now and route an audio track to receive 'test-tone'.".postln;
"  This script will publish for 30 s, then exit.".postln;

s = Server.local;
s.options.numOutputBusChannels = 2;
s.options.numInputBusChannels = 2;

s.waitForBoot({
    "  [OK] scsynth booted".postln;

    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", 1, "test-tone");
    "  [OK] registered channel id=1 name='test-tone'".postln;

    SynthDef(\orbitLinkAudioLiveTest, { |channel = 1|
        // 440 Hz / 660 Hz alternating every second so Live's meter clearly
        // shows the signal is changing (a flat tone could be mistaken for DC).
        // LFPulse outputs 0 or 1 directly, so it can drive Select.kr without
        // a comparison.
        var freq = Select.kr(LFPulse.kr(0.5), [440, 660]);
        var sig = SinOsc.ar(freq) * 0.1;  // ~ -20 dBFS
        var stereo = Pan2.ar(sig, 0);
        OrbitLinkAudioOut.ar(stereo[0], stereo[1], channel);
    }).add;

    s.sync;
    0.5.wait;
    Synth(\orbitLinkAudioLiveTest, [\channel, 1]);
    "  [OK] publishing 'test-tone' (440/660 Hz alternating @ -20 dBFS)".postln;
    "  --> Verify in Live UI now. Holding for 30 s...".postln;

    30.0.wait;
    "  [OK] hold complete — stopping".postln;
    s.quit;
    0.5.wait;
    0.exit;
});
)
