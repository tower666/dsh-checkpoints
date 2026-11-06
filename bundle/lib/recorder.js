/**
 * The turn recorder.
 *
 * `turn/start` queues a baseline snapshot of the workspace in the Session's
 * shadow repository, and every `tools/pre-execute` waits for that baseline so
 * no file mutation can precede it. `turn/end` writes the closing snapshot,
 * diffs the two trees, and persists the record in the catalog. Nothing here
 * touches the user's repository, and nothing lives only in this process.
 */
import { mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import {
  changedPaths,
  locateAlternates,
  prepareShadowRepo,
  repoEnv,
  snapshotTree,
  withRepoLock,
} from './git.js'
import { isInside, storeRootOf, toPosix, workspaceKey } from './paths.js'

/**
 * Build the recorder and its repository registry.
 * @param options - plugin services, config, catalog, and logger.
 * @returns recording entry points and a disposer.
 */
export function createRecorder({ config, git, catalog, log }) {
  const storeRoot = storeRootOf(config)
  /** workspace key → pending or resolved repository record. */
  const repos = new Map()
  /** Session id → its serialisation slot. */
  const sessions = new Map()
  const lifetime = new AbortController()

  /**
   * Resolve (and cache) the shadow repository that snapshots one workspace.
   * @param workspace - absolute Session working directory.
   * @returns the repository record.
   */
  async function ensureRepo(workspace) {
    const key = workspaceKey(workspace)
    const cached = repos.get(key)
    if (cached !== undefined) return cached
    const pending = (async () => {
      // One directory per workspace; its `.git` is the shadow repository.
      const dir = join(storeRoot, 'repos', key)
      const emptyConfigFile = join(storeRoot, 'empty-gitconfig')
      const { gitDir } = await prepareShadowRepo(git, { dir, emptyConfigFile, signal: lifetime.signal })
      const alternates = await locateAlternates(git, workspace, lifetime.signal).catch(() => undefined)
      const tmpDir = join(dir, 'tmp')
      await mkdir(tmpDir, { recursive: true })
      const repo = {
        key,
        dir,
        gitDir,
        root: workspace,
        tmpDir,
        indexFile: join(dir, 'index'),
        emptyConfigFile,
        alternates,
        excludes: isInside(workspace, storeRoot) ? [toPosix(relative(workspace, storeRoot))] : [],
        lockTail: Promise.resolve(),
      }
      repo.env = repoEnv(repo)
      return repo
    })()
    repos.set(key, pending)
    try {
      return await pending
    } catch (error) {
      repos.delete(key)
      throw error
    }
  }

  /** The serialisation slot of one Session. */
  function slotOf(sessionId) {
    let slot = sessions.get(sessionId)
    if (slot === undefined) {
      slot = { queue: Promise.resolve(), open: undefined, baseline: undefined }
      sessions.set(sessionId, slot)
    }
    return slot
  }

  /**
   * Serialise work per Session so an ending turn cannot outrun its baseline.
   * @param slot - the Session slot.
   * @param task - work to run in order.
   */
  function enqueue(slot, task) {
    const run = slot.queue.then(task, task)
    slot.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Snapshot the workspace at the start of one turn.
   * @param session - the appending Session.
   * @param turn - the turn number from `turn/start`.
   */
  function beginTurn(session, turn) {
    const workspace = session.header?.cwd
    if (typeof workspace !== 'string' || workspace.length === 0) return
    const slot = slotOf(session.id)
    const startedAt = Date.now()
    const task = enqueue(slot, async () => {
      try {
        const repo = await ensureRepo(workspace)
        const beforeTree = await withRepoLock(repo, () => snapshotTree(git, repo, lifetime.signal))
        slot.open = { sessionId: session.id, turn, workspace, repo, beforeTree, startedAt }
        await catalog.put(session.id, {
          sessionId: session.id,
          turn,
          workspace,
          startedAt,
          endedAt: null,
          beforeTree,
          afterTree: null,
          files: [],
        })
      } catch (error) {
        log.warn(`checkpoint baseline for turn ${turn} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
    slot.baseline = task
  }

  /**
   * Snapshot the workspace again when the turn closes and persist its file list.
   * @param session - the appending Session.
   * @param turn - the turn number from `turn/end`.
   */
  function endTurn(session, turn) {
    const slot = slotOf(session.id)
    enqueue(slot, async () => {
      const open = slot.open
      if (open === undefined || open.turn !== turn) return
      slot.open = undefined
      try {
        const afterTree = await withRepoLock(open.repo, () => snapshotTree(git, open.repo, lifetime.signal))
        const files = await withRepoLock(open.repo, () => changedPaths(git, open.repo, open.beforeTree, afterTree, lifetime.signal))
        await catalog.put(session.id, {
          sessionId: session.id,
          turn,
          workspace: open.workspace,
          startedAt: open.startedAt,
          endedAt: Date.now(),
          beforeTree: open.beforeTree,
          afterTree,
          files,
        })
      } catch (error) {
        log.warn(`checkpoint record for turn ${turn} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  }

  /**
   * Route one durable Session event.
   * @param session - the appending Session.
   * @param event - the committed event.
   */
  function onEvent(session, event) {
    if (event === null || typeof event !== 'object') return
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') beginTurn(session, event.data.turn)
    else if (event.type === 'turn/end' && typeof event.data?.turn === 'number') endTurn(session, event.data.turn)
  }

  /**
   * Wait for a Session's pending baseline so a tool cannot mutate a file before it.
   * @param sessionId - the Session the tool runs for.
   */
  async function awaitBaseline(sessionId) {
    if (typeof sessionId !== 'string') return
    const slot = sessions.get(sessionId)
    if (slot === undefined || slot.baseline === undefined) return
    await slot.baseline.catch(() => undefined)
  }

  /** Stop accepting work and abandon queued snapshots. */
  function dispose() {
    lifetime.abort()
    sessions.clear()
  }

  return { ensureRepo, onEvent, awaitBaseline, dispose, storeRoot }
}
