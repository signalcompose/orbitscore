//! `PluginAllNotesOff` の台帳 snapshot 解放と集計を audio device / socket 無しで検証する。

#![cfg(feature = "outproc-instrument")]

use orbit_audio_daemon::backend::StubBackend;
use orbit_audio_daemon::engine_wrap::EngineWrap;

#[test]
fn empty_ledger_is_idempotent_and_injected_missing_destination_is_stale() {
    let (engine, _guard) =
        EngineWrap::start_with(StubBackend::default()).expect("start stub engine");

    let empty = engine
        .plugin_all_notes_off()
        .expect("empty ledger must succeed");
    assert_eq!(empty.released, 0);
    assert_eq!(empty.stale, 0);
    assert_eq!(empty.failed, 0);

    engine
        .inject_active_plugin_note("missing-instance", 2, 67)
        .expect("inject active note");
    assert_eq!(engine.active_plugin_note_count().expect("count notes"), 1);
    let stale = engine
        .plugin_all_notes_off()
        .expect("missing destination is a stale entry, not a runtime failure");
    assert_eq!(stale.released, 0);
    assert_eq!(stale.stale, 1);
    assert_eq!(stale.failed, 0);
    assert_eq!(engine.active_plugin_note_count().expect("count notes"), 0);
}
