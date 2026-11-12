/**
 * Standalone smoke test for the workspace-checkpoints plugin core.
 *
 * It replaces the Host `subprocess` capability with a thin child_process
 * adapter (file-backed stdio, so it also runs under the DSH file sandbox),
 * drives the recorder with synthetic turn events, and exercises the service's
 * preview / restore / persistence paths. Run: node test/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { Catalog } from '../lib/store.js'
import { GitRunner } from '../lib/git.js'
import { createRecorder } from '../lib/recorder.js'
import { createService } from '../lib/service.js'

const root = 'D:\\Desktop\\插件\\.scratch\\smoke'
const workspace = join(root, 'ws')
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

const results = []
function check(name, fn) {
  results.push({ name, fn })
}

let catalog
let recorder
let service
const sessionId = 'session-smoke'
const session = { id: sessionId, header: { cwd: workspace } }
const log = { info() {}, warn() {}, error() {}, debug() {} }
const config = { storeDir, timeoutMs: 30_000, outputMaxBytes: 8 * 1024 * 1024, maxFileBytes: 2 * 1024 * 1024, maxDiffBytes: 512 * 1024, maxTurnsPerSession: 300, planTtlMs: 600_000 }
let git

/** Build one plugin generation over the same store. */
function boot() {
  git = new GitRunner(fakeSubprocess(), config)
  catalog = new Catalog(join(storeDir, 'catalog.json'), config)
  const lifetime = new AbortController()
  recorder = createRecorder({ config, git, catalog, log })
  service = createService({ config, git, catalog, ensureRepo: recorder.ensureRepo, signal: lifetime.signal, log })
}

async function main() {
  rmSync(root, { recursive: true, force: true })
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(scratch, { recursive: true })
  await writeFile(join(workspace, 'a.txt'), 'one\ntwo\nthree\n')
  await writeFile(join(workspace, 'src', 'b.txt'), 'alpha\n')
  await writeFile(join(workspace, 'ignored.log'), 'ignore me\n')
  await writeFile(join(workspace, '.gitignore'), 'ignored.log\n')

  boot()

  // ---- turn 1: modify a.txt, add src/c.txt, delete src/b.txt
  recorder.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  await recorder.awaitBaseline(sessionId)
  assert.equal(git !== undefined, true)
  const opened = await catalog.turn(sessionId, 1)
  assert.equal(typeof opened.beforeTree, 'string', 'baseline tree is recorded')

  await writeFile(join(workspace, 'a.txt'), 'one\nTWO-CHANGED\nthree\n')
  await writeFile(join(workspace, 'src', 'c.txt'), 'new file\n')
  await rm(join(workspace, 'src', 'b.txt'))
  recorder.onEvent(session, { type: 'turn/end', data: { turn: 1 } })
  await drain(async () => (await catalog.turn(sessionId, 1))?.afterTree != null, 'turn 1 close')
  const closed = await catalog.turn(sessionId, 1)
  assert.equal(typeof closed.afterTree, 'string')
  const changed = closed.files.map((file) => `${file.status}:${file.path}`).sort()
  assert.deepEqual(changed, ['A:src/c.txt', 'D:src/b.txt', 'M:a.txt'])
  check('records a durable before/after tree pair and the changed file list', async () => changed)

  // ---- the catalog is on disk and excludes ignored files
  await catalog.flush()
  const onDisk = JSON.parse(await readFile(join(storeDir, 'catalog.json'), 'utf8'))
  assert.equal(onDisk.sessions[sessionId].turns['1'].afterTree, closed.afterTree)
  check('persists the catalog to disk', async () => join(storeDir, 'catalog.json'))

  // ---- preview the start side
  const plan = await service.prepare({ sessionId, turn: 1, side: 'start' })
  assert.equal(plan.totals.restore, 2)
  assert.equal(plan.totals.delete, 1)
  assert.equal(plan.totals.unsupported, 0)
  const byPath = Object.fromEntries(plan.files.map((file) => [file.path, file]))
  assert.equal(byPath['a.txt'].action, 'restore')
  assert.equal(byPath['src/b.txt'].action, 'restore')
  assert.equal(byPath['src/c.txt'].action, 'delete')
  check('previews a whole-turn revert without touching the workspace', async () => JSON.stringify(plan.totals))

  // ---- the diff is the one the revert applies
  const diff = await service.diff({ planId: plan.planId, path: 'a.txt' })
  assert.equal(diff.kind, 'text')
  assert.match(diff.text, /-TWO-CHANGED/)
  assert.match(diff.text, /\+two/)
  check('serves the pending comparison for one file', async () => diff.text.split('\n').filter((line) => /^[+-][^+-]/.test(line)).join(' | '))

  // ---- a file changed after the preview refuses the revert
  await writeFile(join(workspace, 'a.txt'), 'one\nEDITED-DURING-PREVIEW\nthree\n')
  await assert.rejects(() => service.restore({ planId: plan.planId }), (error) => error.code === 'checkpoints/stale')
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'one\nEDITED-DURING-PREVIEW\nthree\n')
  check('refuses a stale preview and leaves the workspace untouched', async () => 'checkpoints/stale')

  // ---- single-file revert touches one file only
  await writeFile(join(workspace, 'a.txt'), 'one\nTWO-CHANGED\nthree\n')
  const single = await service.prepare({ sessionId, turn: 1, side: 'start', paths: ['src/c.txt'] })
  assert.equal(single.files.length, 1)
  const singleResult = await service.restore({ planId: single.planId })
  assert.equal(singleResult.restored, 0)
  assert.equal(singleResult.deleted, 1)
  await assert.rejects(() => stat(join(workspace, 'src', 'c.txt')))
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'one\nTWO-CHANGED\nthree\n')
  check('reverts exactly one requested file', async () => 'deleted src/c.txt only')

  // ---- a fresh whole-turn preview applies to what is left
  const fresh = await service.prepare({ sessionId, turn: 1, side: 'start' })
  const restored = await service.restore({ planId: fresh.planId })
  assert.equal(restored.restored, 2)
  assert.equal(restored.deleted, 0)
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n')
  assert.equal(await readFile(join(workspace, 'src', 'b.txt'), 'utf8'), 'alpha\n')
  await assert.rejects(() => stat(join(workspace, 'src', 'c.txt')))
  check('restores a whole turn with no leftover deletion', async () => `restored ${restored.restored}, deleted ${restored.deleted}`)

  // ---- end side: keep everything up to that turn and drop what came after it
  const endPlan = await service.prepare({ sessionId, turn: 1, side: 'end' })
  assert.deepEqual(
    endPlan.files.map((file) => `${file.action}:${file.path}`).sort(),
    ['delete:src/b.txt', 'restore:a.txt', 'restore:src/c.txt'],
  )
  await service.restore({ planId: endPlan.planId })
  assert.equal(await readFile(join(workspace, 'src', 'c.txt'), 'utf8'), 'new file\n')
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'one\nTWO-CHANGED\nthree\n')
  await assert.rejects(() => stat(join(workspace, 'src', 'b.txt')))
  check('restores the workspace to the end of the selected turn', async () => JSON.stringify(endPlan.totals))

  // ---- the user git repository is untouched: no repository was ever created here
  await assert.rejects(() => stat(join(workspace, '.git')))
  check('never creates a repository inside the workspace', async () => 'no .git in the workspace')

  // ---- a new Host generation reads the same catalog and snapshots
  boot()
  const afterRestart = await service.prepare({ sessionId, turn: 1, side: 'start' })
  // a.txt and src/b.txt come back; src/c.txt is removed again.
  assert.equal(afterRestart.totals.restore, 2)
  assert.equal(afterRestart.totals.delete, 1)
  const restartDiff = await service.diff({ planId: afterRestart.planId, path: 'a.txt' })
  assert.equal(restartDiff.kind, 'text')
  check('reads checkpoints and diffs after a Host restart', async () => 'new generation served the same turn')

  const turns = await service.turns(sessionId)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].total, 3)
  check('lists the turn for the card', async () => JSON.stringify(turns[0].files.map((file) => file.path)))

  // ---- oversized snapshot blobs are marked unsupported
  const tiny = { ...config, maxFileBytes: 4 }
  const tinyCatalog = new Catalog(join(storeDir, 'catalog.json'), tiny)
  const tinyGit = new GitRunner(fakeSubprocess(), tiny)
  const tinyRecorder = createRecorder({ config: tiny, git: tinyGit, catalog: tinyCatalog, log })
  const tinyService = createService({ config: tiny, git: tinyGit, catalog: tinyCatalog, ensureRepo: tinyRecorder.ensureRepo, signal: new AbortController().signal, log })
  const tinyPlan = await tinyService.prepare({ sessionId, turn: 1, side: 'start', paths: ['a.txt'] })
  assert.equal(tinyPlan.files[0].action, 'unsupported')
  assert.equal(tinyPlan.files[0].reason, 'oversized')
  check('marks an oversized snapshot blob as unsupported', async () => 'oversized')

  let failed = 0
  for (const entry of results) {
    console.log(`PASS ${entry.name} → ${await entry.fn()}`)
  }
  console.log(`\n${results.length} checks passed, ${failed} failed`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exitCode = 1
})
