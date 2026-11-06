/**
 * The revert service: preview a turn's checkpoint, apply it, and undo it.
 *
 * One operation serves both callers — the Client routes and the agent tool.
 * A preview never writes to the workspace; applying one requires the exact
 * plan the preview produced, and it refuses when a planned file changed while
 * the preview was open. The state that a revert overwrites is snapshotted into
 * the shadow repository first, so the revert itself can be undone.
 */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { blobOid, changedPaths, checkoutPaths, diffOne, snapshotTree, treeBlob, withRepoLock } from './git.js'
import { fail } from './errors.js'
import { safeWorkspacePath } from './paths.js'

/** Sides of a turn a checkpoint can restore. */
export const SIDES = ['start', 'end']

/** Whether a value is a positive safe integer. */
function isTurn(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/** Public projection of a stored turn record. */
function turnView(record) {
  const files = Array.isArray(record.files) ? record.files : []
  return {
    turn: record.turn,
    workspace: record.workspace,
    startedAt: record.startedAt ?? null,
    endedAt: record.endedAt ?? null,
    files,
    total: files.length,
    added: files.reduce((sum, file) => sum + (typeof file.added === 'number' ? file.added : 0), 0),
    deleted: files.reduce((sum, file) => sum + (typeof file.deleted === 'number' ? file.deleted : 0), 0),
    hasStart: typeof record.beforeTree === 'string',
    hasEnd: typeof record.afterTree === 'string',
  }
}

/** Public projection of a prepared plan; internal tree ids and object ids stay on the Host. */
function planView(plan) {
  const files = plan.entries.map((entry) => ({
    path: entry.path,
    display: entry.path,
    action: entry.action,
    status: entry.status,
    ...(entry.added === undefined ? {} : { added: entry.added }),
    ...(entry.deleted === undefined ? {} : { deleted: entry.deleted }),
    ...(entry.binary === true ? { binary: true } : {}),
    ...(entry.size === null ? {} : { size: entry.size }),
    ...(entry.reason === undefined ? {} : { reason: entry.reason }),
  }))
  return {
    planId: plan.planId,
    sessionId: plan.sessionId,
    turn: plan.turn,
    side: plan.side,
    workspace: plan.workspace,
    createdAt: plan.createdAt,
    files,
    totals: {
      files: files.length,
      restore: files.filter((file) => file.action === 'restore').length,
      delete: files.filter((file) => file.action === 'delete').length,
      unsupported: files.filter((file) => file.action === 'unsupported').length,
    },
  }
}

/**
 * Build the service that the routes, the agent tool, and other Host plugins call.
 * @param options - config, git runner, catalog, repository resolver, and lifetime signal.
 * @returns the `workspaceCheckpoints` service face.
 */
export function createService({ config, git, catalog, ensureRepo, signal, plans = new Map(), undos = new Map(), log }) {
  /** Drop previews that outlived their TTL. */
  function prunePlans() {
    const now = Date.now()
    for (const [id, plan] of plans) {
      if (now - plan.createdAt > config.planTtlMs) plans.delete(id)
    }
  }

  /**
   * Every checkpoint this Host recorded for one Session.
   * @param sessionId - the Session to read.
   * @returns the public records, oldest turn first.
   */
  async function turns(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      fail(400, 'checkpoints/bad-request', 'sessionId is required.')
    }
    const records = await catalog.turns(sessionId)
    return records.map(turnView)
  }

  /**
   * Classify one path list against the snapshot tree a revert installs.
   * @param repo - repository record.
   * @param targetTree - the tree holding the content to restore.
   * @param changed - the paths the preview may touch, with their recorded counts.
   * @param currentTree - the workspace snapshot this preview is based on.
   * @returns one entry per path that would actually change.
   */
  async function classify(repo, targetTree, changed, currentTree) {
    const entries = []
    for (const file of changed) {
      const target = await treeBlob(git, repo, targetTree, file.path, signal)
      const currentOid = await blobOid(git, repo, currentTree, file.path, signal)
      const base = {
        path: file.path,
        status: file.status,
        ...(file.added === undefined ? {} : { added: file.added }),
        ...(file.deleted === undefined ? {} : { deleted: file.deleted }),
        ...(file.binary === true ? { binary: true } : {}),
        currentOid,
      }
      if (target === null) {
        if (currentOid === null) continue
        entries.push({ ...base, action: 'delete', size: null, targetOid: null })
        continue
      }
      if (target.size > config.maxFileBytes) {
        entries.push({ ...base, action: 'unsupported', reason: 'oversized', size: target.size, targetOid: target.oid })
        continue
      }
      entries.push({ ...base, action: 'restore', size: target.size, targetOid: target.oid })
    }
    return entries
  }

  /**
   * Prepare a revert preview. Reads only; the workspace is untouched.
   *
   * The two sides answer the two questions a turn's row can ask:
   *
   * - `side: 'start'` — "undo this turn": restore the files *this turn changed*
   *   to their content at the opening snapshot, leaving every file the turn did
   *   not touch alone.
   * - `side: 'end'` — "go back to this turn": make the workspace look like the
   *   closing snapshot of this turn, so everything any later turn changed is
   *   dropped and everything up to here is kept. Its file list is therefore
   *   every path that differs between that closing snapshot and now, not just
   *   the files the turn itself touched.
   *
   * @param request - Session, turn, side, and an optional file subset.
   * @returns the public plan.
   */
  async function prepare(request) {
    const { sessionId, turn, side = 'start', paths } = request ?? {}
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      fail(400, 'checkpoints/bad-request', 'sessionId is required.')
    }
    if (!isTurn(turn)) fail(400, 'checkpoints/bad-request', 'turn must be a positive integer.')
    if (!SIDES.includes(side)) fail(400, 'checkpoints/bad-request', `side must be one of ${SIDES.join(', ')}.`)
    const record = await catalog.turn(sessionId, turn)
    if (record === undefined) fail(404, 'checkpoints/not-found', 'No checkpoint was recorded for this turn.')
    const targetTree = side === 'start' ? record.beforeTree : record.afterTree
    if (typeof targetTree !== 'string') {
      fail(409, 'checkpoints/not-ready', side === 'end' ? 'This turn has no closing snapshot yet.' : 'This turn has no opening snapshot.')
    }
    if (typeof record.afterTree !== 'string') {
      fail(409, 'checkpoints/not-ready', 'This turn’s changed files are not recorded yet.')
    }
    const repo = await ensureRepo(record.workspace)
    const currentTree = await withRepoLock(repo, () => snapshotTree(git, repo, signal))
    const changed = side === 'start'
      ? await changedPaths(git, repo, record.beforeTree, record.afterTree, signal)
      : await changedPaths(git, repo, record.afterTree, currentTree, signal)
    const selected = Array.isArray(paths) && paths.length > 0
      ? changed.filter((file) => paths.includes(file.path))
      : changed
    if (Array.isArray(paths) && paths.length > 0 && selected.length === 0) {
      fail(404, 'checkpoints/not-found', 'None of the requested files changed in the selected scope.')
    }
    const entries = await classify(repo, targetTree, selected, currentTree)
    return store({
      sessionId,
      turn,
      side,
      workspace: record.workspace,
      repo,
      targetTree,
      currentTree,
      entries,
    })
  }

  /**
   * Register one prepared plan so only its exact coordinates can apply it later.
   * @param plan - the plan body without identity or lifetime.
   * @returns the public projection.
   */
  function store(plan) {
    prunePlans()
    const record = { planId: randomUUID(), createdAt: Date.now(), consumed: false, ...plan }
    plans.set(record.planId, record)
    return planView(record)
  }

  /**
   * One file's comparison, as the pending revert would apply it.
   * @param request - plan id and repository-relative path.
   * @returns the comparison text or its refusal kind.
   */
  async function diff(request) {
    const { planId, path } = request ?? {}
    const plan = plans.get(String(planId))
    if (plan === undefined) fail(404, 'checkpoints/plan-not-found', 'This preview is no longer available.')
    const entry = plan.entries.find((candidate) => candidate.path === path)
    if (entry === undefined) fail(404, 'checkpoints/not-found', 'This file is not part of the preview.')
    if (entry.action === 'unsupported') return { kind: 'unsupported', reason: entry.reason, path: entry.path }
    const result = await diffOne(git, plan.repo, plan.currentTree, plan.targetTree, entry.path, config.maxDiffBytes, signal)
    if (result.kind === 'text') {
      return { kind: 'text', path: entry.path, text: result.text, truncated: result.truncated === true }
    }
    return { kind: result.kind, path: entry.path }
  }

  /**
   * Apply one prepared plan.
   * @param request - the plan id returned by {@link prepare}.
   * @returns what changed and the undo handle.
   */
  async function restore(request) {
    const plan = plans.get(String(request?.planId))
    if (plan === undefined) fail(404, 'checkpoints/plan-not-found', 'This preview is no longer available.')
    if (plan.consumed) fail(409, 'checkpoints/plan-consumed', 'This preview was already applied.')
    if (Date.now() - plan.createdAt > config.planTtlMs) {
      plans.delete(plan.planId)
      fail(409, 'checkpoints/plan-expired', 'This preview expired; open it again.')
    }
    const repo = plan.repo
    const currentTree = await withRepoLock(repo, () => snapshotTree(git, repo, signal))
    const stale = []
    const restorePaths = []
    const deletePaths = []
    const skipped = []
    for (const entry of plan.entries) {
      const nowOid = await blobOid(git, repo, currentTree, entry.path, signal)
      if (nowOid !== entry.currentOid) stale.push(entry.path)
      if (entry.action === 'restore') restorePaths.push(entry.path)
      else if (entry.action === 'delete') deletePaths.push(entry.path)
      else if (entry.action === 'unsupported') skipped.push(entry.path)
    }
    if (stale.length > 0) {
      fail(409, 'checkpoints/stale', 'Files changed while the preview was open; open the preview again.', { paths: stale })
    }
    plan.consumed = true
    await checkoutPaths(git, repo, plan.targetTree, restorePaths, signal)
    for (const path of deletePaths) {
      await rm(safeWorkspacePath(repo.root, path), { force: true })
    }
    const undoId = randomUUID()
    const undo = {
      id: undoId,
      at: Date.now(),
      sessionId: plan.sessionId,
      turn: plan.turn,
      side: plan.side,
      workspace: plan.workspace,
      repo,
      tree: currentTree,
      paths: [...restorePaths, ...deletePaths],
    }
    undos.set(undoId, undo)
    log.info(`reverted ${restorePaths.length + deletePaths.length} file(s) of ${plan.sessionId} turn ${plan.turn} to its ${plan.side}`)
    return {
      ok: true,
      planId: plan.planId,
      turn: plan.turn,
      side: plan.side,
      workspace: plan.workspace,
      restored: restorePaths.length,
      deleted: deletePaths.length,
      skipped,
      undo: { id: undoId, paths: undo.paths.length, at: undo.at },
    }
  }

  /**
   * Put back what the most recent {@link restore} overwrote.
   * @param request - the undo id returned by {@link restore}.
   * @returns what changed.
   */
  async function undo(request) {
    const record = undos.get(String(request?.undoId))
    if (record === undefined) fail(404, 'checkpoints/undo-not-found', 'This undo record is no longer available.')
    const repo = record.repo
    const restorePaths = []
    const deletePaths = []
    const skipped = []
    for (const path of record.paths) {
      const blob = await treeBlob(git, repo, record.tree, path, signal)
      if (blob === null) {
        deletePaths.push(path)
        continue
      }
      if (blob.size > config.maxFileBytes) {
        skipped.push(path)
        continue
      }
      restorePaths.push(path)
    }
    await checkoutPaths(git, repo, record.tree, restorePaths, signal)
    for (const path of deletePaths) {
      await rm(safeWorkspacePath(repo.root, path), { force: true })
    }
    return {
      ok: true,
      restored: restorePaths.length,
      deleted: deletePaths.length,
      skipped,
      turn: record.turn,
      side: record.side,
    }
  }

  /** Store facts for diagnostics and for the delivery report. */
  async function describe() {
    return {
      storeDir: catalog.file,
      plans: plans.size,
      undos: undos.size,
    }
  }

  return { turns, prepare, diff, restore, undo, describe }
}
