use std::io::Write;
use std::sync::{Arc, Mutex, Once};

use tracing::metadata::LevelFilter;
use tracing::subscriber::Interest;
use tracing::{span, Event, Level, Metadata, Subscriber};

/// Keeps test callsites from caching `Interest::never()` while discarding events itself.
struct InterestAnchor;

impl Subscriber for InterestAnchor {
    fn register_callsite(&self, _: &'static Metadata<'static>) -> Interest {
        Interest::sometimes()
    }

    fn max_level_hint(&self) -> Option<LevelFilter> {
        // Scoped capture dispatchers raise the process-wide max while they exist. Outside those
        // scopes, retain the same macro fast path and cost as having no subscriber installed.
        Some(LevelFilter::OFF)
    }

    fn enabled(&self, _: &Metadata<'_>) -> bool {
        false
    }

    fn new_span(&self, _: &span::Attributes<'_>) -> span::Id {
        span::Id::from_u64(1)
    }

    fn record(&self, _: &span::Id, _: &span::Record<'_>) {}

    fn record_follows_from(&self, _: &span::Id, _: &span::Id) {}

    fn event(&self, _: &Event<'_>) {}

    fn enter(&self, _: &span::Id) {}

    fn exit(&self, _: &span::Id) {}
}

static ANCHOR: Once = Once::new();

pub(crate) fn install_interest_anchor() {
    ANCHOR.call_once(|| {
        tracing::subscriber::set_global_default(InterestAnchor)
            .expect("install test tracing interest anchor");
    });
}

#[derive(Clone)]
struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

struct CaptureGuard(Arc<Mutex<Vec<u8>>>);

impl Write for CaptureGuard {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("capture log mutex").extend(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for CaptureWriter {
    type Writer = CaptureGuard;

    fn make_writer(&'a self) -> Self::Writer {
        CaptureGuard(self.0.clone())
    }
}

/// Runs `f` with a thread-local tracing capture and returns its value and rendered output.
pub(crate) fn capture_tracing<T>(max: Level, f: impl FnOnce() -> T) -> (T, String) {
    let log = Arc::new(Mutex::new(Vec::new()));
    let subscriber = tracing_subscriber::fmt()
        .without_time()
        .with_ansi(false)
        .with_max_level(max)
        .with_writer(CaptureWriter(log.clone()))
        .finish();
    let value = tracing::subscriber::with_default(subscriber, f);
    let rendered = String::from_utf8(log.lock().expect("capture log mutex").clone())
        .expect("tracing output is utf8");
    (value, rendered)
}

/// Rebuilds callsite interests on a subscriber-less thread in the deterministic regression test.
pub(crate) fn simulate_subscriberless_rebuild() {
    tracing::callsite::rebuild_interest_cache();
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn tracing_dispatcher_controls_stay_in_test_tracing() {
        let forbidden = [
            concat!("with_", "default"),
            concat!("set_", "default"),
            concat!("set_global_", "default"),
            concat!("rebuild_interest_", "cache"),
        ];
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut pending = vec![src];

        while let Some(directory) = pending.pop() {
            for entry in std::fs::read_dir(&directory).expect("read daemon src directory") {
                let path = entry.expect("read daemon src entry").path();
                if path.is_dir() {
                    pending.push(path);
                    continue;
                }
                if path.extension().and_then(|extension| extension.to_str()) != Some("rs")
                    || path.file_name().and_then(|name| name.to_str()) == Some("test_tracing.rs")
                {
                    continue;
                }

                let source = std::fs::read_to_string(&path).expect("read daemon Rust source");
                for needle in forbidden {
                    assert!(
                        !source.contains(needle),
                        "{needle} must only appear in test_tracing.rs; found in {}",
                        path.display()
                    );
                }
            }
        }
    }
}
