/**
 * The revert service: preview a turn's checkpoint and apply it, optionally
 * forgetting the turn's conversation for the model.
 *
 * One operation serves both callers — the Client routes and the agent tool.
 * A preview never writes to the workspace; applying one requires the exact
 * plan the preview produced, and it refuses when a planned file changed (or
 * the conversation moved) while the preview was open. An applied revert is
 * final: the dialog does not offer to undo it.
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
    forgotten: record.forgotten === true,
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
    forget: plan.forget == null
      ? null
      : { from: plan.forget.from, to: plan.forget.to, turns: plan.forget.to - plan.forget.from + 1 },
  }
}

/**
 * Walk the log once and map every current surface node to the turn that
 * produced it. `turn/start` and `turn/end` are log-only, and a `user/message`
 * carries no turn of its own, so the turn of a node is read in sequence order:
 * the latest `turn/start` still inside an open turn owns the nodes after it.
 * @param session - the live Session whose surface is read.
 * @returns the seq → turn map, and the turn still open (undefined between turns).
 */
function scanSurface(session) {
  const surface = new Set(session.surface.nodes)
  const nodeBySeq = new Map()
  let currentTurn
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') {
      currentTurn = event.data.turn
      continue
    }
    if (event.type === 'turn/end') {
      currentTurn = undefined
      continue
    }
    if (surface.has(event.seq)) nodeBySeq.set(event.seq, { turn: currentTurn, type: event.type })
  }
  return { nodeBySeq, openTurn: currentTurn }
}

/** The latest completed turn that still has model-visible nodes. */
function latestSurfaceTurn(scan) {
  let latest
  for (const node of scan.nodeBySeq.values()) {
    if (node.turn !== undefined && (latest === undefined || node.turn > latest)) latest = node.turn
  }
  return latest
}

/**
 * The contiguous surface span that covers turns [from, to]. The replacement
 * contract shadows exactly the surface positions between its two edges, so the
 * span is every surface node from the first to the last matching position.
 *
 * A `system/message` is never an edge: the prompt at surface node 0 must stay,
 * and forgetting turn 1 must not try to replace it. A later in-history prompt
 * node that sits between the edges is still shadowed, because the slice covers
 * every position in between.
 * @param session - the live Session.
 * @param from - first turn (inclusive).
 * @param to - last turn (inclusive).
 * @param scan - a scan of the same surface, when the caller already has one.
 * @returns the edges and every shadowed seq, or null when the range has no nodes.
 */
function surfaceSpan(session, from, to, scan = scanSurface(session)) {
  const nodes = session.surface.nodes
  let first = -1
  let last = -1
  for (let index = 0; index < nodes.length; index += 1) {
    const node = scan.nodeBySeq.get(nodes[index])
    if (node === undefined || node.turn === undefined || node.turn < from || node.turn > to) continue
    if (node.type === 'system/message') continue
    if (first === -1) first = index
    last = index
  }
  if (first === -1) return null
  const shadowed = nodes.slice(first, last + 1)
  return { startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1], shadowed: [...shadowed] }
}

/** The one-line context marker left for a forgotten turn range. */
function forgetMarker(from, to) {
  return from === to
    ? `【第 ${from} 轮对话已被遗忘，不进入上下文】`
    : `【第 ${from}–${to} 轮对话已被遗忘，不进入上下文】`
}

/** Whether two seq lists are equal. */
function sameSeqs(left, right) {
  return left.length === right.length && left.every((seq, index) => seq === right[index])
}

/**
 * Append the replacement user/message that shadows a turn range, so the model
 * no longer receives those messages. The raw events stay in the append-only
 * log; only the derived model-visible history loses them.
 * @param session - the live Session.
 * @param forget - the planned range: edges, every shadowed seq, and bounds.
 * @returns what was forgotten, for the response.
 */
function applyForget(session, forget) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: forgetMarker(forget.from, forget.to) }],
    source: { kind: 'user' },
  }
  session.append('user/message', message, {
    surfaceOp: { op: 'replace', startSeq: forget.startSeq, endSeq: forget.endSeq },
    sourceEventSeqs: forget.shadowed,
  })
  return { from: forget.from, to: forget.to, messages: forget.shadowed.length }
}

/**
 * Build the service that the routes, the agent tool, and other Host plugins call.
 * @param options - config, git runner, catalog, repository resolver, live Session store, and lifetime signal.
 * @returns the `workspaceCheckpoints` service face.
 */
export function createService({ config, git, catalog, ensureRepo, sessions, signal, plans = new Map(), log }) {
  /** Drop previews that outlived their TTL. */
  function prunePlans() {
    const now = Date.now()
    for (const [id, plan] of plans) {
      if (now - plan.createdAt > config.planTtlMs) plans.delete(id)
    }
  }

  /**
   * Resolve the live Session that can have its surface rewritten, or fail.
   * Forgetting mutates the conversation, so it needs the Session object this
   * Host holds in memory; the file-revert half does not.
   * @param sessionId - the conversation id.
   * @returns the live Session.
   */
  function liveSessionOf(sessionId) {
    if (sessions === undefined || typeof sessions.get !== 'function') {
      fail(409, 'checkpoints/forget-unavailable', 'Forgetting needs the live Session service in this Host.')
    }
    const session = sessions.get(sessionId)
    if (session === undefined) {
      fail(409, 'checkpoints/forget-unavailable', 'This conversation is not live in this Host; open it and try again.')
    }
    return session
  }

  /**
   * Resolve the surface span to forget for one turn and side, or null when the
   * chosen side leaves nothing after it (a revert on the newest turn).
   *
   * The newest turn forgets itself; an earlier turn forgets every turn after it.
   * Both are refused while a turn is still running, because the surface is not
   * stable then.
   * @param sessionId - the conversation id.
   * @param turn - the clicked turn.
   * @param side - 'start' (newest turn) or 'end' (an earlier turn).
   * @returns the planned forget, or null.
   */
  function planForget(sessionId, turn, side) {
    const session = liveSessionOf(sessionId)
    const scan = scanSurface(session)
    if (scan.openTurn !== undefined) {
      fail(409, 'checkpoints/busy', 'A turn is still running; wait for it to finish before forgetting.')
    }
    const latest = latestSurfaceTurn(scan)
    if (latest === undefined) fail(409, 'checkpoints/not-ready', 'This conversation has no completed turn to forget.')
    const from = side === 'end' ? turn + 1 : turn
    const to = side === 'end' ? latest : turn
    if (from > to) return null
    const span = surfaceSpan(session, from, to, scan)
    if (span === null) fail(409, 'checkpoints/not-ready', 'No model-visible messages were found for the turns to forget.')
    return { from, to, latest, startSeq: span.startSeq, endSeq: span.endSeq, shadowed: span.shadowed }
  }

  /**
   * Reject a forget whose surface changed since the preview: a new turn, a
   * compaction, or another forget all invalidate the planned edges.
   * @param session - the live Session.
   * @param forget - the planned forget.
   */
  function assertForgetStable(session, forget) {
    const scan = scanSurface(session)
    if (scan.openTurn !== undefined) {
      fail(409, 'checkpoints/busy', 'A turn is still running; wait for it to finish before forgetting.')
    }
    if (latestSurfaceTurn(scan) !== forget.latest) {
      fail(409, 'checkpoints/stale', 'The conversation gained a turn while the preview was open; open the preview again.')
    }
    const span = surfaceSpan(session, forget.from, forget.to, scan)
    if (span === null || span.startSeq !== forget.startSeq || span.endSeq !== forget.endSeq || !sameSeqs(span.shadowed, forget.shadowed)) {
      fail(409, 'checkpoints/stale', 'The conversation changed while the preview was open; open the preview again.')
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
    const { sessionId, turn, side = 'start', paths, forget } = request ?? {}
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
    // Plan the conversation half first: a busy or stale surface must fail before
    // any repository work, and the plan keeps the exact edges it validated.
    const forgetPlan = forget === true ? planForget(sessionId, turn, side) : null
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
      forget: forgetPlan,
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
   * @returns what changed and, when requested, what was forgotten.
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
    // A forget is a surface mutation as well: refuse a stale surface before the
    // first file write, so a failed preview leaves the workspace untouched.
    let forgetSession
    if (plan.forget != null) {
      forgetSession = liveSessionOf(plan.sessionId)
      assertForgetStable(forgetSession, plan.forget)
    }
    plan.consumed = true
    await checkoutPaths(git, repo, plan.targetTree, restorePaths, signal)
    for (const path of deletePaths) {
      await rm(safeWorkspacePath(repo.root, path), { force: true })
    }
    // The file writes above are the slow part; re-check the surface immediately
    // before the append so a turn that started meanwhile cannot desync the range.
    /** @type {null | { from: number, to: number, messages: number }} */
    let forgotten = null
    if (plan.forget != null) {
      assertForgetStable(forgetSession, plan.forget)
      forgotten = applyForget(forgetSession, plan.forget)
      await catalog.markForgotten(plan.sessionId, plan.forget.from, plan.forget.to)
      try {
        await sessions.flush(forgetSession)
      } catch (error) {
        log.warn(`checkpoint forget flush failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    log.info(
      `reverted ${restorePaths.length + deletePaths.length} file(s) of ${plan.sessionId} turn ${plan.turn} to its ${plan.side}`
        + (forgotten === null ? '' : `, forgot turns ${forgotten.from}-${forgotten.to}`),
    )
    return {
      ok: true,
      planId: plan.planId,
      turn: plan.turn,
      side: plan.side,
      workspace: plan.workspace,
      restored: restorePaths.length,
      deleted: deletePaths.length,
      skipped,
      forgotten,
    }
  }

  /** Store facts for diagnostics and for the delivery report. */
  async function describe() {
    return {
      storeDir: catalog.file,
      plans: plans.size,
    }
  }

  return { turns, prepare, diff, restore, describe }
}
