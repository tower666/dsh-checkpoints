/**
 * Resolved plugin configuration.
 *
 * The bundle deliberately declares no `Config` schema: a plugin package
 * installed from a workspace directory resolves its imports from that
 * directory, so it cannot depend on the schema library the Host ships. Every
 * field therefore has a default here and an invalid value falls back instead
 * of failing activation.
 */

/** A positive finite number, floored, or the fallback. */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Resolve one row's raw config object.
 * @param raw - the `config` value of the Loader row, possibly absent.
 * @returns every tunable the plugin reads.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const text = (value) => (typeof value === 'string' && value.trim().length > 0 ? value : undefined)
  return {
    /** Absolute directory holding the shadow repositories and the catalog; inside the Harness home by default. */
    storeDir: text(input.storeDir),
    /** Milliseconds one git command may run. */
    timeoutMs: positive(input.timeoutMs, 30_000),
    /** Bytes of git output retained per command. */
    outputMaxBytes: positive(input.outputMaxBytes, 8 * 1024 * 1024),
    /** Largest file this plugin will restore or diff; a bigger snapshot blob is reported as unsupported. */
    maxFileBytes: positive(input.maxFileBytes, 2 * 1024 * 1024),
    /** Bytes of unified-diff text one preview may carry. */
    maxDiffBytes: positive(input.maxDiffBytes, 512 * 1024),
    /** Turns the catalog keeps per Session before the oldest are forgotten. */
    maxTurnsPerSession: positive(input.maxTurnsPerSession, 300),
    /** Milliseconds an unapplied revert preview stays valid. */
    planTtlMs: positive(input.planTtlMs, 10 * 60 * 1000),
  }
}
