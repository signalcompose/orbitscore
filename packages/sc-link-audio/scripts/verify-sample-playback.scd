// verify-sample-playback.scd — prove that a real SAMPLE plays through the
// `orbitPlayBufLink` SynthDef (#209) and reaches Ableton Live over Link Audio.
//
// Unlike `verify-live-receive.scd` (synthesized test tones straight from
// OrbitLinkAudioOut), this exercises the FULL §4b path the engine uses:
//   Buffer (.wav) → orbitPlayBufLink (PlayBuf + envelope) → OrbitLinkAudioOut → Live.
//
// Pre-requisites:
//   1. OrbitLinkAudio.scx + OrbitLinkAudio.sc installed in
//      ~/Library/Application Support/SuperCollider/Extensions/
//   2. orbitPlayBufLink.scsyndef compiled (run packages/engine/supercollider/setup.scd)
//   3. Ableton Live 12.4+ open, Link ENABLED, an audio track whose input is set to
//      receive Link Audio channel "test" from peer "OrbitScore", monitor/arm ON.
//   4. Live's session sample rate = 48000 (matches the scsynth boot below).
//
// Run:
//   /Applications/SuperCollider.app/Contents/MacOS/sclang \
//     packages/sc-link-audio/scripts/verify-sample-playback.scd
//
// Expected: a C-major chord sample fires ~every 1.5 s for ~30 s on channel "test".
//   You should HEAR it in Live and see the track meter move. If you hear nothing
//   but verify-plugin.scd passed, check: Live SR = 48000, Link ON, track input =
//   OrbitScore/"test", track monitoring ON.

(
var repoRoot, scsyndefPath, wavPath, chanId = 1, chanName = "test";

// repo root = three levels up from this script (.../packages/sc-link-audio/scripts/)
repoRoot = PathName(thisProcess.nowExecutingPath).pathOnly ++ "../../../";
scsyndefPath = (repoRoot ++ "packages/engine/supercollider/synthdefs/orbitPlayBufLink.scsyndef").standardizePath;
wavPath = (repoRoot ++ "test-assets/audio/chord_c_major.wav").standardizePath;

if (\OrbitLinkAudioOut.asClass.isNil) {
    "FAIL: OrbitLinkAudioOut class not found. Install OrbitLinkAudio.{scx,sc} in Extensions.".postln;
    1.exit;
};
if (File.exists(scsyndefPath).not) {
    ("FAIL: " ++ scsyndefPath ++ " not found. Run setup.scd first.").postln;
    1.exit;
};
if (File.exists(wavPath).not) {
    ("FAIL: sample not found: " ++ wavPath).postln;
    1.exit;
};

s = Server.local;
s.options.sampleRate = 48000;   // must match Live's session SR
s.options.numInputBusChannels = 0;
s.waitForBoot({
    var buf;
    // Load the compiled production SynthDef (the exact artifact the engine ships).
    s.sendMsg(\d_load, scsyndefPath);
    s.sync;
    // Register the channel name with the plugin (engine sends this via /cmd).
    s.sendMsg(\cmd, "/orbit/registerLinkAudioChannel", chanId, chanName);
    s.sync;
    buf = Buffer.read(s, wavPath);
    s.sync;

    "".postln;
    "================================================================".postln;
    ("  Publishing channel '" ++ chanName ++ "' as Link Audio peer 'OrbitScore'.").postln;
    "  1) In Ableton, the 'OrbitScore' peer should now appear in Preferences →".postln;
    "     Link → Peers (and channel 'test' in a track's 'Audio From' input).".postln;
    "  2) Make an audio track, set Audio From = OrbitScore / 'test', Monitor In.".postln;
    "  3) You should HEAR a C-major chord ~every 1.5 s.".postln;
    "  Runs until you press Ctrl+C (take your time setting up Live).".postln;
    "================================================================".postln;
    "".postln;

    // Keep the peer alive and firing until interrupted, so there is time to
    // configure the Live track. Ctrl+C stops it.
    Routine({
        var i = 0;
        loop {
            s.sendMsg(\s_new, \orbitPlayBufLink, -1, 0, 0,
                \bufnum, buf.bufnum,
                \amp, 0.8,
                \pan, 0,
                \rate, 1,
                \startPos, 0,
                \duration, 0,
                \channel, chanId
            );
            i = i + 1;
            ("  hit " ++ i ++ " (Ctrl+C to stop)").postln;
            1.5.wait;
        };
    }).play;
});
)
