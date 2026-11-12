/**
 * Live-store check: a brand-new process drives the installed plugin's service
 * against the checkpoints the running Host recorded, proving the snapshots and
 * their comparisons do not depend on the process that made them.
 *
 * Usage: node test/live-check.mjs <sessionId> <storeDir> <workspace> <file> [turn]
 */
import { closeSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'

import { Catalog } from '../lib/store.js'
import { GitRunner } from '../lib/git.js'
import { createRecorder } from '../lib/recorder.js'
import { createService } from '../lib/service.js'

const [sessionId, storeDir, workspace, targetPath, turnArgument] = process.argv.slice(2)
if (!sessionId || !storeDir || !workspace || !targetPath) {
  console.error('usage: node test/live-check.mjs <sessionId> <storeDir> <workspace> <file> [turn]')
  process.exit(2)
}
const turn = turnArgument === undefined ? undefined : Number(turnArgument)
const scratch = join(storeDir, '..', 'live-check-spawn')
const config = {
  storeDir,
  timeoutMs: 30_000,
  outputMaxBytes: 8 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxDiffBytes: 512 * 1024,
  maxTurnsPerSession: 300,
  planTtlMs: 600_000,
}
let counter = 0

/** The Host subprocess stand-in: file-backed stdio, so it works under the DSH sandbox. */
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

const git = new GitRunner(fakeSubprocess(), config)
const catalog = new Catalog(join(storeDir, 'catalog.json'), config)
const recorder = createRecorder({ config, git, catalog, log: { info() {}, warn() {}, error() {}, debug() {} } })
const service = createService({
  config,
  git,
  catalog,
  ensureRepo: recorder.ensureRepo,
  signal: new AbortController().signal,
  log: { info() {}, warn() {}, error() {}, debug() {} },
})

async function main() {
  await mkdir(scratch, { recursive: true })
  const turns = await service.turns(sessionId)
  console.log('turns recorded by the Host for this Session:', JSON.stringify(turns.map((item) => ({ turn: item.turn, total: item.total, files: item.files.map((file) => file.path) }))))
  assert.ok(turns.length > 0, 'the Host recorded no turn for this Session')

  const chosen = turn ?? turns[0].turn
  const record = turns.find((item) => item.turn === chosen)
  assert.ok(record !== undefined, `turn ${chosen} is not recorded`)
  assert.ok(record.files.some((file) => file.path === targetPath), `${targetPath} is not listed by turn ${chosen}`)

  const before = await readFile(join(workspace, targetPath), 'utf8')
  const plan = await service.prepare({ sessionId, turn: chosen, side: 'start', paths: [targetPath] })
  console.log('plan:', JSON.stringify(plan.totals), JSON.stringify(plan.files))
  assert.equal(plan.files.length, 1, 'the single-file preview must list exactly one file')

  const diff = await service.diff({ planId: plan.planId, path: targetPath })
  assert.equal(diff.kind, 'text')
  console.log('diff preview:\n' + diff.text)

  const applied = await service.restore({ planId: plan.planId })
  const reverted = await readFile(join(workspace, targetPath), 'utf8')
  console.log('applied:', JSON.stringify(applied))
  console.log('content before revert:', JSON.stringify(before))
  console.log('content after revert :', JSON.stringify(reverted))
  assert.notEqual(reverted, before, 'the file did not change')
  assert.match(diff.text, /\+line two/, 'the preview shows the content the revert installs')

  console.log('\nPASS: a new process read the recorded turn, previewed it, and reverted one file')
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exitCode = 1
})
