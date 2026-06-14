/**
 * Engine + DSL version identity. Mirrors the root package.json `version`; used
 * for the session-log meta header (SESSION_LOG_SPEC §3) and any other place that
 * needs to stamp the running engine/DSL version. Bump alongside package.json.
 */
export const ENGINE_VERSION = '1.1.0'
export const DSL_VERSION = '1.1'
