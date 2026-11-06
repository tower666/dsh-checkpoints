/**
 * The authenticated Host routes that back the Web UI.
 *
 * They live inside `ctx.connection.fetch`, the Connection authentication fence,
 * so only an owner peer (the authenticated page) reaches them. Every route is
 * read-only except `restore` and `undo`, and both require coordinates the
 * preview route minted in this Host process.
 */
import { httpFailure } from './errors.js'

/** Absolute API paths, as `connection.fetch.register` expects them. */
export const CHECKPOINT_ROUTES = {
  turns: '/api/checkpoints.turns',
  plan: '/api/checkpoints.plan',
  diff: '/api/checkpoints.diff',
  restore: '/api/checkpoints.restore',
  undo: '/api/checkpoints.undo',
}

/** A JSON response that no cache may keep. */
function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

/** Read a JSON request body, or undefined when it is absent or malformed. */
async function readBody(request) {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

/** The 400 body for a missing JSON body. */
const NO_BODY = {
  ok: false,
  error: { code: 'checkpoints/bad-request', message: 'A JSON body is required.' },
}

/**
 * Build one route handler.
 * @param service - the checkpoint service.
 * @param handler - the route's own logic.
 * @returns a fetch-shaped function that maps failures to their status.
 */
function route(service, handler) {
  return async (request) => {
    try {
      return await handler(request, service)
    } catch (error) {
      const failure = httpFailure(error)
      return json(failure.body, failure.status)
    }
  }
}

/**
 * Register every checkpoint route on the Connection authentication fence.
 * @param ctx - plugin context carrying the `connection` capability.
 * @param service - the checkpoint service.
 */
export function registerRoutes(ctx, service) {
  const routes = [
    {
      path: CHECKPOINT_ROUTES.turns,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: route(service, async (request, target) => {
        const sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
        return json({ ok: true, turns: await target.turns(sessionId) })
      }),
    },
    {
      path: CHECKPOINT_ROUTES.plan,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(service, async (request, target) => {
        const payload = await readBody(request)
        if (payload === undefined) return json(NO_BODY, 400)
        return json({ ok: true, plan: await target.prepare(payload) })
      }),
    },
    {
      path: CHECKPOINT_ROUTES.diff,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: route(service, async (request, target) => {
        const query = new URL(request.url).searchParams
        return json({ ok: true, diff: await target.diff({ planId: query.get('planId'), path: query.get('path') }) })
      }),
    },
    {
      path: CHECKPOINT_ROUTES.restore,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(service, async (request, target) => {
        const payload = await readBody(request)
        if (payload === undefined) return json(NO_BODY, 400)
        return json(await target.restore(payload))
      }),
    },
    {
      path: CHECKPOINT_ROUTES.undo,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(service, async (request, target) => {
        const payload = await readBody(request)
        if (payload === undefined) return json(NO_BODY, 400)
        return json(await target.undo(payload))
      }),
    },
  ]
  for (const entry of routes) {
    ctx.effect(() => ctx.connection.fetch.register(entry), `checkpoints: route ${entry.path}`)
  }
}
