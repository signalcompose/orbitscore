//! スキャン結果の集計（件数とパーセンタイル）（#888 子 3・orbit-plugin-scan）。
//!
//! 🔴 **これは純粋な移動である。** 本文は 1 行も書き換えていない（可視性を
//! `pub(crate)` へ上げたものを除く — 分割前は同一モジュール内だったため）。

#[allow(unused_imports)]
use crate::*;

pub(crate) fn summarize_artifacts(
    artifacts: &[CatalogArtifact],
    cache_hits: usize,
    probe_attempts: usize,
) -> ScanSummary {
    let mut summary = ScanSummary {
        success: 0,
        pending: 0,
        failure: 0,
        failure_reasons: BTreeMap::new(),
        duration_ms: DurationSummary {
            p50: None,
            p95: None,
            max: None,
        },
        timeouts: 0,
        crashes: 0,
        factory_versions: BTreeMap::new(),
        cache_hits,
        probe_attempts,
    };
    let mut durations = Vec::new();
    for artifact in artifacts {
        match &artifact.state {
            ArtifactState::StaticSuccess { .. } => summary.success += 1,
            ArtifactState::ProbePending { .. } => summary.pending += 1,
            ArtifactState::ProbeSucceeded {
                duration_ms,
                descriptor_apis,
                ..
            } => {
                summary.success += 1;
                durations.push(*duration_ms);
                for api in descriptor_apis
                    .iter()
                    .filter(|api| api.starts_with("factory"))
                {
                    *summary.factory_versions.entry(api.clone()).or_default() += 1;
                }
            }
            ArtifactState::ProbeFailed {
                duration_ms,
                failure,
            } => {
                summary.failure += 1;
                durations.push(*duration_ms);
                *summary
                    .failure_reasons
                    .entry(failure.code.clone())
                    .or_default() += 1;
            }
        }
    }
    summary.timeouts = summary
        .failure_reasons
        .get("timeout")
        .copied()
        .unwrap_or_default();
    summary.crashes = summary
        .failure_reasons
        .get("crash")
        .copied()
        .unwrap_or_default();
    durations.sort_unstable();
    summary.duration_ms = DurationSummary {
        p50: percentile(&durations, 50),
        p95: percentile(&durations, 95),
        max: durations.last().copied(),
    };
    summary
}

pub(crate) fn percentile(sorted: &[u64], percentile: usize) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (percentile * sorted.len()).div_ceil(100);
    sorted.get(rank.saturating_sub(1)).copied()
}
