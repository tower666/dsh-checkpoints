/**
 * Integration test: checkpointing a real git repository must never write to it.
 *
 * A real repository is created and committed, its whole `.git` tree is hashed,
 * the plugin's own recorder and service then snapshot two turns (through the
 * read-only alternate object store), and the same `.git` tree is hashed again.
 * Any new object, ref, index entry, or pack file would change a hash.
 *
 * Run: node test/integration-git.mjs
 */
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

import { Catalog } from '../lib/store.js'
import { GitRunner } from '../lib/git.js'
import { createRecorder } from '../lib/recorder.js'
import { createService } from '../lib/service.js'

const root = 'D:\\Desktop\\插件\\.scratch\\integration'
const workspace = join(root, 'repo')
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

/** Run a real git command in the fixture repository through file-backed stdio (no pipes). */
function gitIn(args) {
  counter += 1
  const outPath = join(scratch, `probe-${counter}.out`)
  const errPath = join(scratch, `probe-${counter}.err`)
  const fo = openSync(outPath, 'w+')
  const fe = openSync(errPath, 'w+')
  const result = spawnSync('git', args, { cwd: workspace, stdio: ['ignore', fo, fe], windowsHide: true })
  closeSync(fo)
  closeSync(fe)
  const stdout = readFileSync(outPath, 'utf8').trim()
  const stderr = readFileSync(errPath, 'utf8').trim()
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  return stdout
}

/** Hash every file under `.git`, so any write anywhere shows up. */
function hashGitTree() {
  const gitDir = join(workspace, '.git')
  const entries = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const info = statSync(full)
      if (info.isDirectory()) walk(full)
      else entries.push(`${relative(gitDir, full).split('\\').join('/')}|${info.size}|${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
    }
  }
  walk(gitDir)
  return { count: entries.length, digest: createHash('sha256').update(entries.sort().join('\n')).digest('hex'), entries }
}

/** Let the recorder settle. */
async function drain(predicate, label) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const sessionId = 'session-integration'
const session = { id: sessionId, header: { cwd: workspace } }
const log = { info() {}, warn() {}, error() {}, debug() {} }

async function main() {
  rmSync(root, { recursive: true, force: true })
  await mkdir(join(workspace, 'src'), { recursive: true })
  await mkdir(scratch, { recursive: true })
  await writeFile(join(workspace, 'a.txt'), 'line 1\nline 2\nline 3\n')
  await writeFile(join(workspace, 'src', 'keep.txt'), 'kept\n')
  await writeFile(join(workspace, '.gitignore'), 'node_modules/\n')
  gitIn(['init', '--quiet', '.'])
  gitIn(['config', 'user.email', 'test@example.com'])
  gitIn(['config', 'user.name', 'Test'])
  gitIn(['add', '-A'])
  gitIn(['commit', '--quiet', '-m', 'initial'])

  const headBefore = gitIn(['rev-parse', 'HEAD'])
  const logBefore = gitIn(['log', '--oneline'])
  const objectsBefore = gitIn(['count-objects', '-v'])
  // Hash .git last, so no observation of my own can disturb the comparison.
  const gitBefore = hashGitTree()

  const git = new GitRunner(fakeSubprocess(), config)
  const catalog = new Catalog(join(storeDir, 'catalog.json'), config)
  const lifetime = new AbortController()
  const recorder = createRecorder({ config, git, catalog, log })
  const service = createService({ config, git, catalog, ensureRepo: recorder.ensureRepo, signal: lifetime.signal, log })

  // turn 1: modify one tracked file and add an untracked one
  recorder.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  await recorder.awaitBaseline(sessionId)
  await writeFile(join(workspace, 'a.txt'), 'line 1\nCHANGED IN TURN 1\nline 3\n')
  await writeFile(join(workspace, 'src', 'new.txt'), 'created in turn 1\n')
  recorder.onEvent(session, { type: 'turn/end', data: { turn: 1 } })
  await drain(async () => (await catalog.turn(sessionId, 1))?.afterTree != null, 'turn 1')

  // Hash again before running any git command of my own: `git status` refreshes the index stat cache.
  const gitAfterRecording = hashGitTree()

  // revert the whole of turn 1 to its start
  const plan = await service.prepare({ sessionId, turn: 1, side: 'start' })
  const applied = await service.restore({ planId: plan.planId })
  const revertedA = await readFile(join(workspace, 'a.txt'), 'utf8')
  const newGone = await stat(join(workspace, 'src', 'new.txt')).then(() => false, () => true)

  // turn 2: edit the tracked file again, so the repository still has a local change
  recorder.onEvent(session, { type: 'turn/start', data: { turn: 2 } })
  await recorder.awaitBaseline(sessionId)
  await writeFile(join(workspace, 'a.txt'), 'line 1\nTURN 2\nline 3\n')
  recorder.onEvent(session, { type: 'turn/end', data: { turn: 2 } })
  await drain(async () => (await catalog.turn(sessionId, 2))?.afterTree != null, 'turn 2')

  const gitAfterRevert = hashGitTree()
  const finalState = {
    head: gitIn(['rev-parse', 'HEAD']),
    log: gitIn(['log', '--oneline']),
    objects: gitIn(['count-objects', '-v']),
    status: gitIn(['status', '--porcelain']),
  }

  // ---- assertions
  assert.equal(gitAfterRecording.digest, gitBefore.digest, 'a file under .git changed while the plugin snapshotted the repository')
  assert.equal(gitAfterRevert.digest, gitBefore.digest, 'a file under .git changed during the revert')
  assert.equal(finalState.head, headBefore, 'HEAD moved')
  assert.equal(finalState.log, logBefore, 'history changed')
  assert.equal(finalState.objects, objectsBefore, 'the repository object store changed')
  assert.equal(finalState.status, 'M a.txt', 'the working tree holds only the edit the turns made')

  assert.equal(revertedA, 'line 1\nline 2\nline 3\n', 'a.txt was not restored to the turn-start content')
  assert.equal(newGone, true, 'the file created by the turn was not removed')
  assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'line 1\nTURN 2\nline 3\n', 'turn 2 did not land on the reverted tree')

  /** The shadow store really holds the snapshot objects. */
  const shadowRepo = join(storeDir, 'repos')
  const shadowDirectories = readdirSync(shadowRepo)
  assert.equal(shadowDirectories.length, 1, 'exactly one shadow repository was created')
  const shadowObjects = readdirSync(join(shadowRepo, shadowDirectories[0], '.git', 'objects'))
  assert.ok(shadowObjects.includes('info') && shadowObjects.includes('pack'), 'the shadow repository has its own object store')

  console.log('HEAD before          :', headBefore)
  console.log('HEAD after           :', finalState.head)
  console.log('git log --oneline    :', JSON.stringify(finalState.log))
  console.log('git count-objects -v :', JSON.stringify(objectsBefore))
  console.log('git status --porcelain:', JSON.stringify(finalState.status))
  console.log('.git files hashed    :', gitBefore.count)
  console.log('.git digest before   :', gitBefore.digest)
  console.log('.git digest after    :', gitAfterRecording.digest)
  console.log('.git digest post-revert:', gitAfterRevert.digest)
  console.log('turn 1 files         :', JSON.stringify((await catalog.turn(sessionId, 1)).files))
  console.log('turn 2 files         :', JSON.stringify((await catalog.turn(sessionId, 2)).files))
  console.log('revert               :', JSON.stringify(applied))
  console.log('\nPASS: a real repository keeps its index, objects, refs, and history while checkpoints are recorded and reverted')
}

main().catch((error) => {
  console.error('FAIL', error)
  process.exitCode = 1
})
