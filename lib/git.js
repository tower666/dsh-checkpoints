/**
 * Git plumbing for the shadow repositories.
 *
 * Every command runs through the Host `subprocess` capability with a scrubbed
 * environment. The shadow repository owns its own `GIT_DIR`, persistent index,
 * and object store; the user's repository is attached read-only as an object
 * alternate so committed content is read from it and never written back. No
 * command addresses the user's index, refs, or object store, and no commit is
 * ever created.
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

/** Milliseconds a git child gets to exit after termination starts. */
const TERMINATE_GRACE_MS = 2_000
/** Retained stderr tail for diagnostics. */
const STDERR_TAIL_BYTES = 16 * 1024
/** Paths one `checkout-index` invocation carries, keeping the argv below the platform limit. */
const CHECKOUT_CHUNK = 64

/** Runs one resolved git executable with a scrubbed environment, timeout, and bounded output. */
export class GitRunner {
  /**
   * @param subprocess - the Host subprocess capability.
   * @param limits - timeout and output caps.
   */
  constructor(subprocess, limits) {
    this.subprocess = subprocess
    this.limits = limits
    this.executable = undefined
  }

  /** Resolve `git` once per Host process. */
  async exe() {
    if (this.executable === undefined) {
      this.executable = await this.subprocess.resolveExecutable('git')
    }
    return this.executable
  }

  /**
   * Run `git <args>` to completion.
   * @param args - git arguments; never shell-interpreted.
   * @param options - working directory, extra environment, cancellation, and output cap.
   * @returns exit facts and collected output.
   */
  async run(args, options = {}) {
    const executable = await this.exe()
    const timeout = AbortSignal.timeout(this.limits.timeoutMs)
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
    const handle = this.subprocess.spawn({
      argv: [executable, ...args],
      cwd: options.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: options.maxBytes ?? this.limits.outputMaxBytes },
        stderr: { maxBytes: STDERR_TAIL_BYTES },
      },
      graceMs: TERMINATE_GRACE_MS,
      signal,
      // The subprocess credential scrub removes ambient GIT_CONFIG_KEY_n entries.
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
        ...options.env,
      },
    })
    const outcome = await handle.done
    if (signal.aborted) {
      throw new Error(`git ${args.join(' ')} ${timeout.aborted ? `timed out after ${this.limits.timeoutMs}ms` : 'was aborted'}`)
    }
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr, truncated: stdout.lossy }
  }
}

/** Whether a path exists. */
export async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Reject a failed command with its stderr.
 * @param result - settled command facts.
 * @param what - command description for the error message.
 * @returns the same result when it exited zero.
 */
export function ok(result, what) {
  if (result.exitCode !== 0) {
    throw new Error(`${what} failed (exit ${result.exitCode}): ${result.stderr.trim()}`)
  }
  return result
}

/**
 * Initialise the shadow repository once, then hand back its git directory.
 * `core.autocrlf=false` and `core.safecrlf=false` keep snapshot blobs and
 * restored files byte-exact, and an empty global config file keeps the user's
 * global git configuration from reshaping the stored content.
 * @param git - command runner.
 * @param options - shadow directory, empty config file, and cancellation.
 * @returns the git directory and whether this call created it.
 */
export async function prepareShadowRepo(git, { dir, emptyConfigFile, signal }) {
  await mkdir(dir, { recursive: true })
  const gitDir = join(dir, '.git')
  const fresh = !(await exists(gitDir))
  if (fresh) {
    ok(await git.run(['init', '--quiet', dir], { cwd: dir, signal }), 'git init')
    for (const [key, value] of [
      ['core.autocrlf', 'false'],
      ['core.safecrlf', 'false'],
      ['core.logallrefupdates', 'false'],
      ['gc.auto', '0'],
    ]) {
      ok(await git.run(['--git-dir', gitDir, 'config', key, value], { cwd: dir, signal }), 'git config')
    }
  }
  await mkdir(dirname(emptyConfigFile), { recursive: true })
  await writeFile(emptyConfigFile, '')
  return { gitDir, fresh }
}

/**
 * The environment every shadow-repository command runs under.
 * @param repo - repository record.
 * @returns variables for `GitRunner.run`.
 */
export function repoEnv(repo) {
  const env = {
    GIT_DIR: repo.gitDir,
    GIT_WORK_TREE: repo.root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: repo.emptyConfigFile,
  }
  if (repo.alternates !== undefined) env.GIT_ALTERNATE_OBJECT_DIRECTORIES = repo.alternates
  return env
}

/**
 * Locate the user's repository enclosing a workspace so its committed objects
 * can be read without being copied. Nothing is written there.
 * @param git - command runner.
 * @param root - absolute workspace directory.
 * @param signal - cancellation.
 * @returns the absolute objects directory, or undefined outside any repository.
 */
export async function locateAlternates(git, root, signal) {
  const found = await git.run(['rev-parse', '--absolute-git-dir', '--git-path', 'objects'], { cwd: root, signal })
  if (found.exitCode !== 0) return undefined
  const lines = found.stdout.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length < 2) return undefined
  return resolve(root, lines[1].trim())
}

/**
 * Write the whole work tree — untracked and modified files included, ignored
 * ones excluded — as a tree object through the shadow index.
 * @param git - command runner.
 * @param repo - repository record.
 * @param signal - cancellation.
 * @returns the tree object id.
 */
export async function snapshotTree(git, repo, signal) {
  const env = { ...repo.env, GIT_INDEX_FILE: repo.indexFile }
  const pathspec = repo.excludes.length === 0
    ? []
    : ['--', '.', ...repo.excludes.map((path) => `:(exclude)${path}`)]
  // `--ignore-errors` skips unreadable files and reports them through exit code 1; the index is still complete.
  const added = await git.run(['add', '--all', '--ignore-errors', ...pathspec], { cwd: repo.root, env, signal })
  if (added.exitCode !== 0 && added.exitCode !== 1) ok(added, `git add in ${repo.root}`)
  return ok(await git.run(['write-tree'], { cwd: repo.root, env, signal }), 'git write-tree').stdout.trim()
}

/**
 * Split a `-z` byte stream into its records.
 * @param text - collected stdout.
 * @returns records without the trailing empty member.
 */
function records(text) {
  return text.split('\0').filter((record, index, all) => !(record === '' && index === all.length - 1))
}

/**
 * Files that differ between two snapshot trees.
 * @param git - command runner.
 * @param repo - repository record.
 * @param before - older tree id.
 * @param after - newer tree id.
 * @param signal - cancellation.
 * @returns one entry per path with its status and line counts.
 */
export async function changedPaths(git, repo, before, after, signal) {
  if (before === after) return []
  const numstat = ok(
    await git.run(['diff-tree', '-r', '-z', '--numstat', before, after], { cwd: repo.root, env: repo.env, signal }),
    'git diff-tree --numstat',
  )
  const nameStatus = ok(
    await git.run(['diff-tree', '-r', '-z', '--name-status', before, after], { cwd: repo.root, env: repo.env, signal }),
    'git diff-tree --name-status',
  )
  const counts = new Map()
  for (const record of records(numstat.stdout)) {
    const first = record.indexOf('\t')
    const second = record.indexOf('\t', first + 1)
    if (first < 0 || second < 0) continue
    const added = record.slice(0, first)
    const deleted = record.slice(first + 1, second)
    counts.set(record.slice(second + 1), {
      added: added === '-' ? undefined : Number(added),
      deleted: deleted === '-' ? undefined : Number(deleted),
      binary: added === '-' || deleted === '-',
    })
  }
  const statuses = records(nameStatus.stdout)
  const files = []
  for (let index = 0; index + 1 < statuses.length; index += 2) {
    const status = statuses[index][0]
    const path = statuses[index + 1]
    const counted = counts.get(path)
    files.push({
      path,
      status,
      ...(counted === undefined ? {} : { added: counted.added, deleted: counted.deleted, binary: counted.binary || undefined }),
    })
  }
  return files
}

/**
 * The blob a snapshot tree holds at one path.
 * @param git - command runner.
 * @param repo - repository record.
 * @param tree - snapshot tree id.
 * @param path - slash-separated repository-relative path.
 * @param signal - cancellation.
 * @returns the blob id and size, or null when the tree holds a tree or gitlink there — or nothing.
 */
export async function treeBlob(git, repo, tree, path, signal) {
  const result = await git.run(['ls-tree', '-z', '-l', tree, '--', path], {
    cwd: repo.root,
    env: { ...repo.env, GIT_LITERAL_PATHSPECS: '1' },
    signal,
  })
  if (result.exitCode !== 0) return null
  const entry = result.stdout.split('\0')[0]
  const match = /^\d+ (\S+) ([0-9a-f]+) +(\d+)\t/.exec(entry)
  if (match === null || match[1] !== 'blob') return null
  return { oid: match[2], size: Number(match[3]) }
}

/**
 * Whether two snapshot trees hold a different blob at one path.
 * @returns the newer side's blob id, or null when the path is absent.
 */
export async function blobOid(git, repo, tree, path, signal) {
  const entry = await treeBlob(git, repo, tree, path, signal)
  return entry === null ? null : entry.oid
}

/**
 * One file's unified comparison between two snapshot trees.
 * @param git - command runner.
 * @param repo - repository record.
 * @param from - tree holding the current content.
 * @param to - tree holding the content the revert installs.
 * @param path - slash-separated repository-relative path.
 * @param maxBytes - cap on the returned text.
 * @param signal - cancellation.
 * @returns the comparison kind and, for text, the unified diff.
 */
export async function diffOne(git, repo, from, to, path, maxBytes, signal) {
  const env = { ...repo.env, GIT_LITERAL_PATHSPECS: '1' }
  const numstat = await git.run(['diff-tree', '-r', '-z', '--numstat', from, to, '--', path], { cwd: repo.root, env, signal })
  if (numstat.exitCode !== 0) throw new Error(`git diff-tree failed: ${numstat.stderr.trim()}`)
  const counts = records(numstat.stdout)[0]
  if (counts !== undefined && counts.startsWith('-\t-\t')) return { kind: 'binary' }
  const text = await git.run(['diff', '--no-color', '--no-ext-diff', '-U3', from, to, '--', path], {
    cwd: repo.root,
    env,
    signal,
    maxBytes,
  })
  if (text.exitCode !== 0) throw new Error(`git diff failed: ${text.stderr.trim()}`)
  return { kind: 'text', text: text.stdout, truncated: text.truncated }
}

/**
 * Write selected paths from a snapshot tree into the work tree.
 * Binary-safe and byte-exact: content comes from the shadow object store, not
 * from a decoded text stream.
 * @param git - command runner.
 * @param repo - repository record.
 * @param tree - snapshot tree id.
 * @param paths - slash-separated repository-relative paths.
 * @param signal - cancellation.
 */
export async function checkoutPaths(git, repo, tree, paths, signal) {
  if (paths.length === 0) return
  const indexFile = join(repo.tmpDir, `restore-${randomUUID()}`)
  const env = { ...repo.env, GIT_INDEX_FILE: indexFile }
  try {
    ok(await git.run(['read-tree', tree], { cwd: repo.root, env, signal }), 'git read-tree')
    for (let offset = 0; offset < paths.length; offset += CHECKOUT_CHUNK) {
      const chunk = paths.slice(offset, offset + CHECKOUT_CHUNK)
      for (const path of chunk) {
        // checkout-index creates leading directories, but only when the parent chain is absent; make it explicit.
        await mkdir(dirname(join(repo.root, path)), { recursive: true })
      }
      ok(await git.run(['checkout-index', '-f', '--', ...chunk], { cwd: repo.root, env, signal }), 'git checkout-index')
    }
  } finally {
    await rm(indexFile, { force: true })
  }
}

/**
 * Per-repository serialisation, so a preview snapshot and a turn snapshot
 * never share the persistent index at the same time.
 * @param repo - repository record.
 * @param task - work to run exclusively.
 */
export function withRepoLock(repo, task) {
  const run = repo.lockTail.then(task, task)
  repo.lockTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
