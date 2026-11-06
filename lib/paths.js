/** Path arithmetic shared by the recorder and the revert service. */
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * The directory that holds every shadow repository and the catalog.
 * @param config - resolved plugin config.
 * @returns an absolute directory outside the user's workspace by default.
 */
export function storeRootOf(config) {
  if (config.storeDir !== undefined) return resolve(config.storeDir)
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return resolve(join(home, 'workspace-checkpoints'))
}

/**
 * Stable directory name for one workspace; the path itself never appears there.
 * @param workspace - absolute workspace directory.
 * @returns a short lowercase hex key.
 */
export function workspaceKey(workspace) {
  const normalized = process.platform === 'win32' ? resolve(workspace).toLowerCase() : resolve(workspace)
  return createHash('sha1').update(normalized).digest('hex').slice(0, 20)
}

/**
 * Whether a path lies strictly inside a directory.
 * @param parent - directory that must contain the child.
 * @param child - candidate path.
 * @returns true when the child is below the parent.
 */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Slash-separated form of a relative path, as git spells pathspecs.
 * @param path - native relative path.
 * @returns the same path with forward slashes.
 */
export function toPosix(path) {
  return sep === '/' ? path : path.split(sep).join('/')
}

/**
 * Reject any path a snapshot could not have produced, so a crafted plan can
 * never escape the workspace.
 * @param root - absolute workspace directory.
 * @param path - slash-separated repository-relative path.
 * @returns the absolute target path.
 */
export function safeWorkspacePath(root, path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('empty path')
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-zA-Z]:/.test(path)) throw new Error(`absolute path refused: ${path}`)
  const segments = path.split('/')
  if (segments.some((segment) => segment === '..' || segment === '' || segment === '.')) throw new Error(`unexpected path segment in ${path}`)
  const target = resolve(root, path)
  if (!isInside(root, target)) throw new Error(`path escapes the workspace: ${path}`)
  return target
}
