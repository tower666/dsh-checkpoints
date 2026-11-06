/** Failure vocabulary shared by the service, the routes, and the agent tool. */

/** A failure the caller can report verbatim, carrying the HTTP status it maps to. */
export class CheckpointError extends Error {
  /**
   * @param status - HTTP status the route answers with.
   * @param code - stable machine code the client and the model may branch on.
   * @param message - human-readable reason.
   * @param details - optional structured payload, such as the conflicting paths.
   */
  constructor(status, code, message, details) {
    super(message)
    this.name = 'CheckpointError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * Throw a {@link CheckpointError}.
 * @param status - HTTP status the route answers with.
 * @param code - stable machine code.
 * @param message - human-readable reason.
 * @param details - optional structured payload.
 */
export function fail(status, code, message, details) {
  throw new CheckpointError(status, code, message, details)
}

/**
 * Translate any thrown value into the JSON response the routes serve.
 * @param error - the rejection.
 * @returns status plus response body.
 */
export function httpFailure(error) {
  if (error instanceof CheckpointError) {
    return {
      status: error.status,
      body: {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { status: 500, body: { ok: false, error: { code: 'checkpoints/internal', message } } }
}
