use orbit_audio_native::BlockTransport;
use orbit_audio_sandbox::TransportContext;

pub(crate) fn transport_context(transport: &BlockTransport) -> TransportContext {
    const TEMPO_BPM: f64 = 120.0;
    let song_position_beats = if transport.sample_rate == 0 {
        0.0
    } else {
        transport.cursor_frames as f64 / transport.sample_rate as f64 * (TEMPO_BPM / 60.0)
    };
    TransportContext {
        tempo_bpm: TEMPO_BPM,
        time_sig_numerator: 4,
        time_sig_denominator: 4,
        is_playing: 1,
        is_looping: 0,
        song_position_beats,
    }
}
