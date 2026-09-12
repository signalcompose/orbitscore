//! スキャンの実行（キャッシュ復元・probe キュー・並行実行）（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

pub(crate) const ARTIFACT_PROBE_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const PROCESS_KILL_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
pub(crate) const PROBE_CONCURRENCY: usize = 4;

/// 全ディレクトリを走査した結果。`entries` は v1 reader 向け互換投影。
pub struct ScanOutcome {
    pub entries: Vec<CatalogEntry>,
    pub artifacts: Vec<CatalogArtifact>,
    pub skipped: Vec<String>,
    pub failures: Vec<ScanFailure>,
    pub summary: ScanSummary,
}

/// 通常起動用。fingerprint が一致する native probe の成功・失敗は既存 catalog から復元する。
pub fn scan_all_with_cache(dirs: &[PathBuf], previous: Option<&Catalog>) -> ScanOutcome {
    scan_candidates(
        collect_all_bundle_candidates(dirs),
        false,
        previous,
        &|_, _| unreachable!("metadata-only scan must never invoke the child probe"),
    )
}

/// ユーザーが明示した rescan 用。pending artifact を 1 artifact / 1 child で probe する。
pub fn scan_all_with_probes(dirs: &[PathBuf], scanner_executable: &Path) -> ScanOutcome {
    scan_all_with_probes_and_cache(dirs, scanner_executable, None)
}

/// ユーザーが明示した rescan 用。fingerprint が一致する positive/negative cache を再利用し、
/// 未知または更新済みの artifact だけを 1 artifact / 1 child で probe する。
pub fn scan_all_with_probes_and_cache(
    dirs: &[PathBuf],
    scanner_executable: &Path,
    previous: Option<&Catalog>,
) -> ScanOutcome {
    scan_candidates(
        collect_all_bundle_candidates(dirs),
        true,
        previous,
        &|path, format| run_child_probe(scanner_executable, path, format),
    )
}

pub(crate) fn is_inconclusive_failure(code: &str) -> bool {
    matches!(
        code,
        "timeout" | "killTimeout" | "crash" | "spawnError" | "protocolError"
    )
}

pub(crate) fn refresh_cached_arch_failure(
    path: &Path,
    state: ArtifactState,
) -> Option<ArtifactState> {
    match &state {
        ArtifactState::ProbeFailed { .. } => {}
        _ => return Some(state),
    }
    // Revalidate every cached failure, including `unsupportedArch`: CoreFoundation or fallback
    // executable resolution can recover independently of the old cached diagnosis. If a formerly
    // unsupported artifact now passes preflight, discard the negative cache and probe it again.
    match preflight_artifact_architecture(path) {
        Err(error) => Some(ArtifactState::ProbeFailed {
            duration_ms: 0,
            failure: error.into_probe_failure(None, None),
        }),
        Ok(()) => match &state {
            ArtifactState::ProbeFailed { failure, .. } if failure.code == "unsupportedArch" => None,
            _ => Some(state),
        },
    }
}

pub(crate) struct ScanCandidateAccumulation {
    pub(crate) entries: Vec<CatalogEntry>,
    pub(crate) artifacts: Vec<CatalogArtifact>,
    pub(crate) pending: Vec<(usize, PathBuf, Format)>,
    pub(crate) cache_hits: usize,
}

pub(crate) fn restore_cached_or_queue_probe(
    path: PathBuf,
    format: Format,
    fingerprint: ArtifactFingerprint,
    pending_reason: String,
    cached_by_fingerprint: &HashMap<ArtifactFingerprint, ArtifactState>,
    accumulation: &mut ScanCandidateAccumulation,
) {
    let index = accumulation.artifacts.len();
    let path_string = path.to_string_lossy().into_owned();
    if let Some(state) = cached_by_fingerprint
        .get(&fingerprint)
        .cloned()
        .and_then(|state| refresh_cached_arch_failure(&path, state))
    {
        if let ArtifactState::ProbeSucceeded { plugins, .. } = &state {
            accumulation.entries.extend(plugins.iter().cloned());
        }
        accumulation.cache_hits += 1;
        accumulation.artifacts.push(CatalogArtifact {
            format,
            path: path_string,
            fingerprint: Some(fingerprint),
            state,
        });
    } else {
        accumulation.artifacts.push(CatalogArtifact {
            format,
            path: path_string,
            fingerprint: Some(fingerprint),
            state: ArtifactState::ProbePending {
                reason: pending_reason,
            },
        });
        accumulation.pending.push((index, path, format));
    }
}

pub(crate) fn scan_candidates<F>(
    candidates: Vec<(PathBuf, Format)>,
    explicit_probe: bool,
    previous: Option<&Catalog>,
    probe_runner: &F,
) -> ScanOutcome
where
    F: Fn(&Path, Format) -> ProbeExecution + Sync,
{
    let mut accumulation = ScanCandidateAccumulation {
        entries: Vec::new(),
        artifacts: Vec::new(),
        pending: Vec::new(),
        cache_hits: 0,
    };
    let cached_by_fingerprint = previous
        .into_iter()
        .flat_map(|catalog| &catalog.artifacts)
        .filter_map(|artifact| {
            let fingerprint = artifact.fingerprint.as_ref()?;
            match &artifact.state {
                ArtifactState::ProbeSucceeded { .. } => {
                    Some((fingerprint.clone(), artifact.state.clone()))
                }
                ArtifactState::ProbeFailed { failure, .. }
                    if !explicit_probe || !is_inconclusive_failure(&failure.code) =>
                {
                    Some((fingerprint.clone(), artifact.state.clone()))
                }
                ArtifactState::ProbeFailed { .. } => None,
                ArtifactState::StaticSuccess { .. } | ArtifactState::ProbePending { .. } => None,
            }
        })
        .collect::<HashMap<_, _>>();

    for (path, format) in candidates {
        let fingerprint = artifact_fingerprint(&path, format);
        match format {
            Format::Clap if explicit_probe => {
                restore_cached_or_queue_probe(
                    path,
                    format,
                    fingerprint,
                    "nativeDescriptorNotProbed".to_owned(),
                    &cached_by_fingerprint,
                    &mut accumulation,
                );
            }
            Format::Clap => {
                let found = scan_clap_bundle(&path);
                accumulation.entries.extend(found.iter().cloned());
                accumulation.artifacts.push(CatalogArtifact {
                    format,
                    path: path.to_string_lossy().into_owned(),
                    fingerprint: Some(fingerprint),
                    state: ArtifactState::StaticSuccess {
                        source: "clapDescriptor".to_owned(),
                        plugins: found,
                    },
                });
            }
            Format::Vst3 => match scan_vst3_bundle(&path) {
                VstScanResult::StaticSuccess(found) => {
                    accumulation.entries.extend(found.iter().cloned());
                    accumulation.artifacts.push(CatalogArtifact {
                        format,
                        path: path.to_string_lossy().into_owned(),
                        fingerprint: Some(fingerprint),
                        state: ArtifactState::StaticSuccess {
                            source: "moduleinfo".to_owned(),
                            plugins: found,
                        },
                    });
                }
                VstScanResult::ProbePending { reason } => {
                    restore_cached_or_queue_probe(
                        path,
                        format,
                        fingerprint,
                        reason,
                        &cached_by_fingerprint,
                        &mut accumulation,
                    );
                }
            },
        }
    }

    let ScanCandidateAccumulation {
        mut entries,
        mut artifacts,
        pending,
        cache_hits,
    } = accumulation;
    let mut probe_attempts = 0;
    if explicit_probe {
        // Four workers implement the agreed temporary policy. Keeping each artifact in its own
        // process preserves crash attribution, while a small fixed pool keeps the 261 × 20s
        // worst-case below the extension's 30-minute parent timeout. Fingerprint cache hits have
        // already been removed from `pending`, including negative-cache quarantine entries.
        let next = std::sync::atomic::AtomicUsize::new(0);
        let collected = std::sync::Mutex::new(Vec::with_capacity(pending.len()));
        thread::scope(|scope| {
            let worker_count = PROBE_CONCURRENCY.min(pending.len());
            for _ in 0..worker_count {
                let next = &next;
                let collected = &collected;
                let pending = &pending;
                scope.spawn(move || loop {
                    let job = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let Some((artifact_index, path, format)) = pending.get(job) else {
                        break;
                    };
                    let result = probe_runner(path, *format);
                    collected
                        .lock()
                        .expect("probe result mutex poisoned")
                        .push((*artifact_index, result));
                });
            }
        });
        let results = collected.into_inner().expect("probe result mutex poisoned");
        probe_attempts = results.len();

        for (artifact_index, execution) in results {
            match execution.result {
                Ok(probe) => {
                    entries.extend(probe.plugins.iter().cloned());
                    artifacts[artifact_index].state = ArtifactState::ProbeSucceeded {
                        source: probe.source,
                        duration_ms: execution.duration_ms,
                        descriptor_apis: probe.descriptor_apis,
                        plugins: probe.plugins,
                    };
                }
                Err(failure) => {
                    artifacts[artifact_index].state = ArtifactState::ProbeFailed {
                        duration_ms: execution.duration_ms,
                        failure,
                    };
                }
            }
        }
    }

    let skipped = artifacts
        .iter()
        .filter_map(|artifact| match artifact.state {
            ArtifactState::ProbeFailed { .. } => Some(artifact.path.clone()),
            _ => None,
        })
        .collect();
    let failures = artifacts
        .iter()
        .filter_map(|artifact| {
            let ArtifactState::ProbeFailed { failure, .. } = &artifact.state else {
                return None;
            };
            Some(ScanFailure {
                path: artifact.path.clone(),
                code: failure.code.clone(),
                message: failure.message.clone(),
                host_arch: failure.host_arch.clone(),
                slices: failure.slices.clone(),
            })
        })
        .collect();
    let summary = summarize_artifacts(&artifacts, cache_hits, probe_attempts);
    ScanOutcome {
        entries: dedup_entries(entries),
        artifacts,
        skipped,
        failures,
        summary,
    }
}
