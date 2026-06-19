/**
 * Engine + DSL version identity. Used for the session-log meta header
 * (SESSION_LOG_SPEC §3) and anywhere the running engine/DSL version is stamped.
 *
 * v2.0.0 is the WCTM milestone: MIDI output + Pitch DSL + comping + the session
 * log all landed since v1.1.1. The changes are additive (audio `play()` semantics
 * preserved), but a whole new MIDI pillar + recording is a generational leap, so
 * the milestone is cut as a major (product-positioning decision, 2026-06-15).
 *
 * `-dev` marks the unreleased development line; at the release, drop the suffix
 * and bump the package.json files + tag. (Auto-sync from package.json is deferred
 * — SESSION_LOG_SPEC §7 / #276.)
 */
export const ENGINE_VERSION = '2.0.0'

/** DSL spec version (PITCH_DSL_SPEC) — a separate axis from the product version. */
export const DSL_VERSION = '1.1'
