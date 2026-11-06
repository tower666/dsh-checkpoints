/**
 * Route test: the exact fetch handlers the Web card calls.
 *
 * Registers the plugin's routes against a stub Connection fetch registry and
 * drives them with real Request/Response objects, so the JSON shapes, status
 * codes, and the plan → diff → restore → undo handshake are checked without a
 * browser.
 *
 * Run: node test/routes.mjs
 */
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

import { Catalog } from '../lib/store.js'
import { GitRunner } from '../lib/git.js'
import { createRecorder } from '../lib/recorder.js'
import { createService } from '../lib/service.js'
import { CHECKPOINT_ROUTES, registerRoutes } from '../lib/routes.js'

const root = 'D:\\Desktop\\插件\\.scratch\\routes'
const workspace = join(root, 'ws')
const storeDir = join(root, 'store')
const scratch = join(root, 'spawn')
let counter = 0

const config = {
  storeDir,
  timeoutMs: 30_000,
  outputMaxBytes: 8 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxDiffBytes: 512 * 1024,
  maxTurnsPerSession: 300,
  planTtlMs: 600_000,
}

const log = { info() {}, warn() {}, error() {}, debug() {} }

function fakeSubprocess() {
  return {
    async resolveExecutable(command) {
      return command
    },
    spawn(spec) {
      counter += 1
      const outPath = join(scratch, `out-${counter}.txt`)
      const errPath = join(scratch, `err-${counter}.txt`)
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
          collected.stdout = { readFrom: () => ({ text: readFileSync(outPath, 'utf8'), lossy: false }) }
          collected.stderr = { readFrom: () => ({ text: readFileSync(errPath, 'utf8') }) }
          resolve({ exitCode: code ?? 1 })
        })
      })
      return { done, collected }
    },
  }
}

async function drain(predicate, label) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const sessionId = 'session-routes'
const session = { id: sessionId, header: { cwd: workspace } }

/** One route handler by its path. */
const routes = new Map()

/** Invoke a handler and decode its JSON, or return the raw response for text bodies. */
async function call(target, init) {
  const key = target.split('?')[0]
  const route = routes.get(key)
  assert.ok(route !== undefined, `route ${key} is registered`)
  const response = await route.fetch(new Request(`http://localhost${target}`, init))
  const text = await response.text()
  assert.equal(response.headers.get('cache-control'), 'no-store', 'responses are not cacheable')
  try {
    return { status: response.status, body: JSON.parse(text) }
  } catch {
    return { status: response.status, body: text }
  }
}

async function main() {
  rmSync(root, { recursive: true, force: true })
  await mkdir(workspace, { recursive: true })
  await mkdir(scratch, { recursive: true })
  await writeFile(join(workspace, 'x.txt'), 'first\nsecond\n')
  await writeFile(join(workspace, 'gone.txt'), 'delete me\n')

  const git = new GitRunner(fakeSubprocess(), config)
  const catalog = new Catalog(join(storeDir, 'catalog.json'), config)
  const recorder = createRecorder({ config, git, catalog, log })
  const service = createService({ config, git, catalog, ensureRepo: recorder.ensureRepo, signal: new AbortController().signal, log })

  recorder.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  await recorder.awaitBaseline(sessionId)
  await writeFile(join(workspace, 'x.txt'), 'first\nSECOND CHANGED\n')
  await rm(join(workspace, 'gone.txt'))
  await writeFile(join(workspace, 'added.txt'), 'hello\n')
  recorder.onEvent(session, { type: 'turn/end', data: { turn: 1 } })
  await drain(async () => (await catalog.turn(sessionId, 1))?.afterTree != null, 'turn 1')

  // ---- registration
  const stub = {
    effect: (fn) => fn(),
    connection: { fetch: { register: (route) => {
      routes.set(route.path, route)
      return async () => {}
    } } },
  }
  registerRoutes(stub, service)
  assert.deepEqual([...routes.keys()].sort(), [
    CHECKPOINT_ROUTES.diff,
    CHECKPOINT_ROUTES.plan,
    CHECKPOINT_ROUTES.restore,
    CHECKPOINT_ROUTES.turns,
    CHECKPOINT_ROUTES.undo,
  ].sort())
  for (const route of routes.values()) {
    assert.ok(route.path.startsWith('/api/'), 'routes live under /api')
    assert.equal(route.requestBody, 'buffered')
  }
  console.log('PASS registers five buffered /api routes:', [...routes.keys()].join(', '))

  // ---- turns
  const listed = await call(`${CHECKPOINT_ROUTES.turns}?sessionId=${sessionId}`)
  assert.equal(listed.status, 200)
  assert.equal(listed.body.ok, true)
  assert.equal(listed.body.turns.length, 1)
  assert.equal(listed.body.turns[0].total, 3)
  console.log('PASS GET turns →', JSON.stringify(listed.body.turns[0].files.map((file) => file.path)))

  const missing = await call(`${CHECKPOINT_ROUTES.turns}?sessionId=`)
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'checkpoints/bad-request')
  console.log('PASS GET turns without a session → 400 checkpoints/bad-request')

  // ---- plan
  const planned = await call(CHECKPOINT_ROUTES.plan, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, turn: 1, side: 'start' }),
  })
  assert.equal(planned.status, 200)
  const plan = planned.body.plan
  assert.equal(plan.totals.restore, 2)
  assert.equal(plan.totals.delete, 1)
  console.log('PASS POST plan →', JSON.stringify(plan.totals))

  const unknownTurn = await call(CHECKPOINT_ROUTES.plan, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, turn: 99, side: 'start' }),
  })
  assert.equal(unknownTurn.status, 404)
  assert.equal(unknownTurn.body.error.code, 'checkpoints/not-found')

  const badBody = await call(CHECKPOINT_ROUTES.plan, { method: 'POST' })
  assert.equal(badBody.status, 400)
  console.log('PASS POST plan rejects an unknown turn (404) and a missing body (400)')

  // ---- diff
  const diff = await call(`${CHECKPOINT_ROUTES.diff}?planId=${plan.planId}&path=x.txt`)
  assert.equal(diff.status, 200)
  assert.equal(diff.body.diff.kind, 'text')
  assert.match(diff.body.diff.text, /-SECOND CHANGED/)
  assert.match(diff.body.diff.text, /\+second/)
  console.log('PASS GET diff →', diff.body.diff.text.split('\n').filter((line) => /^[+-][^+-]/.test(line)).join(' | '))

  // ---- restore
  const applied = await call(CHECKPOINT_ROUTES.restore, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: plan.planId }),
  })
  assert.equal(applied.status, 200)
  assert.equal(applied.body.ok, true)
  assert.equal(applied.body.restored, 2)
  assert.equal(applied.body.deleted, 1)
  assert.equal(await readFile(join(workspace, 'x.txt'), 'utf8'), 'first\nsecond\n')
  console.log('PASS POST restore →', JSON.stringify({ restored: applied.body.restored, deleted: applied.body.deleted }))

  const replay = await call(CHECKPOINT_ROUTES.restore, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: plan.planId }),
  })
  assert.equal(replay.status, 409)
  assert.equal(replay.body.error.code, 'checkpoints/plan-consumed')
  console.log('PASS POST restore refuses a consumed plan → 409 checkpoints/plan-consumed')

  // ---- undo
  const undone = await call(CHECKPOINT_ROUTES.undo, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ undoId: applied.body.undo.id }),
  })
  assert.equal(undone.status, 200)
  assert.equal(undone.body.restored, 2)
  assert.equal(await readFile(join(workspace, 'x.txt'), 'utf8'), 'first\nSECOND CHANGED\n')
  console.log('PASS POST undo →', JSON.stringify({ restored: undone.body.restored, deleted: undone.body.deleted }))

  // ---- "go back to this turn": keep everything up to turn 1, drop every later change
  await writeFile(join(workspace, 'x.txt'), 'first\nEDITED LATER\n')
  await writeFile(join(workspace, 'later.txt'), 'added by a later turn\n')
  const toEnd = await call(CHECKPOINT_ROUTES.plan, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, turn: 1, side: 'end' }),
  })
  assert.equal(toEnd.status, 200)
  assert.equal(toEnd.body.plan.side, 'end')
  assert.deepEqual(
    toEnd.body.plan.files.map((file) => `${file.action}:${file.path}`).sort(),
    ['delete:later.txt', 'restore:x.txt'],
  )
  const backToTurn = await call(CHECKPOINT_ROUTES.restore, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ planId: toEnd.body.plan.planId }),
  })
  assert.equal(backToTurn.status, 200)
  assert.equal(backToTurn.body.side, 'end')
  assert.equal(await readFile(join(workspace, 'x.txt'), 'utf8'), 'first\nSECOND CHANGED\n')
  await assert.rejects(() => readFile(join(workspace, 'later.txt'), 'utf8'))
  await call(CHECKPOINT_ROUTES.undo, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ undoId: backToTurn.body.undo.id }),
  })
  assert.equal(await readFile(join(workspace, 'x.txt'), 'utf8'), 'first\nEDITED LATER\n')
  assert.equal(await readFile(join(workspace, 'later.txt'), 'utf8'), 'added by a later turn\n')
  console.log('PASS POST plan side=end →', JSON.stringify(toEnd.body.plan.totals), '(keeps up to the turn, drops what followed)')

  console.log('\nPASS: every route the card calls answers with the documented status and JSON shape')
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exitCode = 1
})
