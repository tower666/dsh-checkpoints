/**
 * Host half of the workspace-checkpoints bundle.
 *
 * Records a durable git snapshot of the workspace at the start and at the end
 * of every turn in a shadow repository that never touches the user's index,
 * objects, refs, or history, and serves previewed reverts of those snapshots
 * to the Web card and to the `workspace_checkpoint` tool.
 */
import { join } from 'node:path'
import { resolveConfig } from './lib/config.js'
import { GitRunner } from './lib/git.js'
import { storeRootOf } from './lib/paths.js'
import { Catalog } from './lib/store.js'
import { createRecorder } from './lib/recorder.js'
import { createService } from './lib/service.js'
import { registerRoutes } from './lib/routes.js'
import { registerTool } from './lib/tool.js'

/** Capabilities this plugin cannot work without. */
export const inject = ['subprocess', 'connection']

/**
 * The live Session store, when this Host provides one. Forgetting rewrites the
 * conversation surface, so it needs the live Session; the file-revert half
 * works even when the store is absent.
 */
function sessionStoreOf(ctx) {
  try {
    return ctx.get('sessions')
  } catch {
    return undefined
  }
}

/** A logger that never throws when the logging service is absent. */
function loggerOf(ctx) {
  try {
    const logger = ctx.logger('checkpoints')
    if (logger !== undefined && logger !== null && typeof logger.info === 'function') return logger
  } catch {
    // fall through to the console facade
  }
  return {
    debug: () => undefined,
    info: (...args) => console.log('[checkpoints]', ...args),
    warn: (...args) => console.warn('[checkpoints]', ...args),
    error: (...args) => console.error('[checkpoints]', ...args),
  }
}

/**
 * Mount the recorder, the service, the routes, and the agent tool.
 * @param ctx - Host plugin context.
 * @param rawConfig - the row's `config`, validated leniently.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const log = loggerOf(ctx)
  const storeRoot = storeRootOf(config)
  const git = new GitRunner(ctx.subprocess, config)
  const catalog = new Catalog(join(storeRoot, 'catalog.json'), config)
  const lifetime = new AbortController()
  const recorder = createRecorder({ config, git, catalog, log })
  const service = createService({
    config,
    git,
    catalog,
    ensureRepo: recorder.ensureRepo,
    sessions: sessionStoreOf(ctx),
    signal: lifetime.signal,
    log,
  })

  ctx.effect(
    () => () => {
      lifetime.abort()
      recorder.dispose()
      return catalog.flush()
    },
    'checkpoints: lifetime',
  )

  registerRoutes(ctx, service)
  registerTool(ctx, service, log)

  if (ctx.get('workspaceCheckpoints') === undefined) {
    ctx.provide('workspaceCheckpoints', service)
  }

  ctx.on('session/event', (session, event) => recorder.onEvent(session, event))
  ctx.on('tools/pre-execute', async (exec, next) => {
    await recorder.awaitBaseline(exec?.agent?.id)
    return next()
  })

  log.info(`workspace checkpoints are stored under ${storeRoot}`)
}
