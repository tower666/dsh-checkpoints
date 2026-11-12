/**
 * Forget tests: the "revert and forget" half that rewrites the conversation
 * surface so the model stops receiving a turn range.
 *
 * A faithful fake Session models the parts the service reads: the current
 * surface nodes, the ordered log, and append with surface markers. The
 * workspace, shadow repository, and catalog are real, matching smoke.mjs.
 * Run: node test/forget.mjs
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

import { Catalog } from '../lib/store.js'
import { GitRunner } from '../lib/git.js'
import { createRecorder } from '../lib/recorder.js'
import { createService } from '../lib/service.js'

const root = 'D:\\Desktop\\插件\\.scratch\\forget'
const storeDir = join(root, 'store')
const scratch = join(root, 'spawn')
let spawnCounter = 0

/** A subprocess capability stand-in with file-backed stdio. */
function fakeSubprocess() {
  return {
    async resolveExecutable(command) {
      return command
    },
    spawn(spec) {
      spawnCounter += 1
      const id = spawnCounter
      const outPath = join(scratch, `out-${id}.txt`)
      const errPath = join(scratch, `err-${id}.txt`)
      const fo = openSync(outPath, 'w')
      const fe = openSync(errPath, 'w')
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ['ignore', fo, fe],
        windowsHide: true,
      })
      closeSync(fo)
      closeSync(fe)
      const collected = {}
      const done = new Promise((resolve) => {
        child.on('close', (code) => {
          const text = readFileSync(outPath, 'utf8')
          const stderr = readFileSync(errPath, 'utf8')
          collected.stdout = { readFrom: () => ({ text, lossy: false }) }
          collected.stderr = { readFrom: () => ({ text: stderr }) }
          resolve({ exitCode: code ?? 1 })
        })
      })
      return { done, collected }
    },
  }
}

/** Let the recorder's queued work finish. */
async function drain(predicate, label) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * A Session stand-in: an ordered log and the same positional-replacement
 * surface rules the real Session enforces for `replace`.
 */
function createFakeSession(id, workspaceDir) {
  let seq = 0
  const events = []
  function append(type, data, opts) {
    const event = { type, seq: seq, time: Date.now(), data, ...(opts ?? {}) }
    seq += 1
    events.push(event)
    return event
  }
  function nodesOf() {
    const nodes = []
    for (const event of events) {
      if (event.surfaceOp === undefined) continue
      if (event.surfaceOp === 'append') {
        nodes.push(event.seq)
        continue
      }
      if (event.surfaceOp.op === 'replace') {
        const start = nodes.indexOf(event.surfaceOp.startSeq)
        const end = nodes.indexOf(event.surfaceOp.endSeq)
        if (start === -1 || end === -1) throw new Error('fake session: replace edges must be current surface nodes')
        nodes.splice(start, end - start + 1, event.seq)
      }
    }
    return nodes
  }
  return {
    id,
    header: { cwd: workspaceDir },
    get surface() {
      return { nodes: nodesOf() }
    },
    snapshotEvents() {
      return events
    },
    append,
    events,
  }
}

const results = []
function check(name, fn) {
  results.push({ name, fn })
}

let catalog
let recorder
let service
let git
const sessionsById = new Map()
const sessions = {
  get(id) {
    return sessionsById.get(id)
  },
  async flush() {
    return true
  },
}
const log = { info() {}, warn() {}, error() {}, debug() {} }
const config = { storeDir, timeoutMs: 30_000, outputMaxBytes: 8 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, maxDiffBytes: 512 * 1024, maxTurnsPerSession: 300, planTtlMs: 600_000 }

/** Build one plugin generation over the same store. */
function boot() {
  git = new GitRunner(fakeSubprocess(), config)
  catalog = new Catalog(join(storeDir, 'catalog.json'), config)
  const lifetime = new AbortController()
  recorder = createRecorder({ config, git, catalog, log })
  service = createService({ config, git, catalog, ensureRepo: recorder.ensureRepo, sessions, signal: lifetime.signal, log })
}

/** Append a user message on the surface. */
function appendUser(session, text) {
  return session.append(
    'user/message',
    { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
    { surfaceOp: 'append' },
  )
}

/** Append an assistant message that carries its turn, as the real loop does. */
function appendAssistant(session, turn) {
  return session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'text', text: `done ${turn}` }],
        source: { kind: 'model', provider: 'fake', model: 'fake' },
      },
      stream: [],
    },
    { surfaceOp: 'append' },
  )
}

/**
 * Record one completed turn: the log gets turn/start, its messages, and
 * turn/end; the recorder takes the real snapshots.
 * @returns the seqs of the turn's two surface nodes.
 */
async function recordTurn(session, turn, write) {
  const startEvent = session.append('turn/start', { turn })
  recorder.onEvent(session, startEvent)
  await recorder.awaitBaseline(session.id)
  await write()
  const userEvent = appendUser(session, `prompt ${turn}`)
  const assistantEvent = appendAssistant(session, turn)
  const endEvent = session.append('turn/end', { turn, reason: { kind: 'completed' } })
  recorder.onEvent(session, endEvent)
  await drain(async () => (await catalog.turn(session.id, turn))?.afterTree != null, `turn ${turn} close`)
  return { userSeq: userEvent.seq, assistantSeq: assistantEvent.seq }
}

async function main() {
  rmSync(root, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  boot()

  // ---- newest turn: revert its files and forget exactly that turn
  {
    const ws = join(root, 'ws-newest')
    await mkdir(ws, { recursive: true })
    await writeFile(join(ws, 'a.txt'), 'base\n')
    const session = createFakeSession('session-forget-newest', ws)
    sessionsById.set(session.id, session)
    await recordTurn(session, 1, () => writeFile(join(ws, 'a.txt'), 'turn1\n'))
    await recordTurn(session, 2, () => writeFile(join(ws, 'a.txt'), 'turn2\n'))
    const turn3 = await recordTurn(session, 3, () => writeFile(join(ws, 'a.txt'), 'turn3\n'))

    const plan = await service.prepare({ sessionId: session.id, turn: 3, side: 'start', forget: true })
    assert.equal(plan.forget.from, 3)
    assert.equal(plan.forget.to, 3)
    assert.equal(plan.forget.turns, 1)

    const result = await service.restore({ planId: plan.planId })
    assert.equal(result.forgotten.from, 3)
    assert.equal(result.forgotten.to, 3)

    const replacement = session.events[session.events.length - 1]
    assert.equal(replacement.type, 'user/message')
    assert.equal(replacement.surfaceOp.op, 'replace')
    assert.equal(replacement.surfaceOp.startSeq, turn3.userSeq)
    assert.equal(replacement.surfaceOp.endSeq, turn3.assistantSeq)
    assert.deepEqual(replacement.sourceEventSeqs, [turn3.userSeq, turn3.assistantSeq])
    assert.match(replacement.data.content[0].text, /第 3 轮对话已被遗忘/)

    const nodes = session.surface.nodes
    assert.equal(nodes.includes(turn3.userSeq), false)
    assert.equal(nodes.includes(turn3.assistantSeq), false)

    const turns = await service.turns(session.id)
    assert.equal(turns.find((item) => item.turn === 3).forgotten, true)
    assert.equal(turns.find((item) => item.turn === 1).forgotten, false)
    check('newest turn reverts its files and forgets exactly that turn', async () => 'turn 3')
  }

  // ---- earlier turn: revert to its end and forget every later turn
  {
    const ws = join(root, 'ws-earlier')
    await mkdir(ws, { recursive: true })
    await writeFile(join(ws, 'a.txt'), 'base\n')
    const session = createFakeSession('session-forget-earlier', ws)
    sessionsById.set(session.id, session)
    const turn1 = await recordTurn(session, 1, () => writeFile(join(ws, 'a.txt'), 'turn1\n'))
    const turn2 = await recordTurn(session, 2, () => writeFile(join(ws, 'b.txt'), 'b2\n'))
    const turn3 = await recordTurn(session, 3, () => writeFile(join(ws, 'c.txt'), 'c3\n'))

    const plan = await service.prepare({ sessionId: session.id, turn: 1, side: 'end', forget: true })
    assert.equal(plan.forget.from, 2)
    assert.equal(plan.forget.to, 3)
    assert.equal(plan.forget.turns, 2)

    const result = await service.restore({ planId: plan.planId })
    assert.equal(result.forgotten.from, 2)
    assert.equal(result.forgotten.to, 3)

    const replacement = session.events[session.events.length - 1]
    assert.equal(replacement.surfaceOp.startSeq, turn2.userSeq)
    assert.equal(replacement.surfaceOp.endSeq, turn3.assistantSeq)
    assert.deepEqual(replacement.sourceEventSeqs, [
      turn2.userSeq, turn2.assistantSeq, turn3.userSeq, turn3.assistantSeq,
    ])

    const nodes = session.surface.nodes
    assert.equal(nodes.includes(turn1.userSeq), true, 'the kept turn stays on the surface')
    assert.equal(nodes.includes(turn2.userSeq), false)
    assert.equal(nodes.includes(turn3.userSeq), false)

    const turns = await service.turns(session.id)
    assert.equal(turns.find((item) => item.turn === 2).forgotten, true)
    assert.equal(turns.find((item) => item.turn === 3).forgotten, true)
    assert.equal(turns.find((item) => item.turn === 1).forgotten, false)
    check('an earlier turn reverts to its end and forgets every later turn', async () => 'turns 2-3')
  }

  // ---- a running turn refuses the forget
  {
    const ws = join(root, 'ws-busy')
    await mkdir(ws, { recursive: true })
    await writeFile(join(ws, 'a.txt'), 'base\n')
    const session = createFakeSession('session-forget-busy', ws)
    sessionsById.set(session.id, session)
    await recordTurn(session, 1, () => writeFile(join(ws, 'a.txt'), 'turn1\n'))
    session.append('turn/start', { turn: 2 })
    await assert.rejects(
      () => service.prepare({ sessionId: session.id, turn: 1, side: 'end', forget: true }),
      (error) => error.code === 'checkpoints/busy',
    )
    check('a turn still running refuses a forget', async () => 'checkpoints/busy')
  }

  // ---- a surface that gained a turn between preview and apply is stale
  {
    const ws = join(root, 'ws-stale')
    await mkdir(ws, { recursive: true })
    await writeFile(join(ws, 'a.txt'), 'base\n')
    const session = createFakeSession('session-forget-stale', ws)
    sessionsById.set(session.id, session)
    await recordTurn(session, 1, () => writeFile(join(ws, 'a.txt'), 'turn1\n'))
    await recordTurn(session, 2, () => writeFile(join(ws, 'b.txt'), 'b2\n'))
    const plan = await service.prepare({ sessionId: session.id, turn: 2, side: 'start', forget: true })
    // A new turn that changes an unrelated file: the file plan stays valid,
    // so only the surface stability check can reject the apply.
    await recordTurn(session, 3, () => writeFile(join(ws, 'c.txt'), 'c3\n'))
    await assert.rejects(
      () => service.restore({ planId: plan.planId }),
      (error) => error.code === 'checkpoints/stale',
    )
    assert.equal(session.events.some((event) => event.surfaceOp?.op === 'replace'), false)
    check('a conversation that gained a turn refuses the stale forget', async () => 'checkpoints/stale')
  }

  // ---- no live Session service: the file tool still works, forget does not
  {
    const ws = join(root, 'ws-files-only')
    await mkdir(ws, { recursive: true })
    await writeFile(join(ws, 'a.txt'), 'base\n')
    const session = createFakeSession('session-forget-files-only', ws)
    sessionsById.set(session.id, session)
    await recordTurn(session, 1, () => writeFile(join(ws, 'a.txt'), 'turn1\n'))
    const filesOnly = createService({ config, git, catalog, ensureRepo: recorder.ensureRepo, signal: new AbortController().signal, log })
    const filePlan = await filesOnly.prepare({ sessionId: session.id, turn: 1, side: 'start' })
    assert.equal(filePlan.forget, null, 'a plan without the forget flag carries no forget range')
    await assert.rejects(
      () => filesOnly.prepare({ sessionId: session.id, turn: 1, side: 'start', forget: true }),
      (error) => error.code === 'checkpoints/forget-unavailable',
    )
    check('without a live Session a file-only revert still plans, and forget fails closed', async () => 'checkpoints/forget-unavailable')
  }

  let failed = 0
  for (const item of results) {
    try {
      const detail = await item.fn()
      console.log(`PASS ${item.name}${detail === undefined ? '' : ` → ${detail}`}`)
    } catch (error) {
      failed += 1
      console.error(`FAIL ${item.name}: ${error instanceof Error ? error.stack : String(error)}`)
    }
  }
  console.log(`\n${results.length - failed} checks passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
