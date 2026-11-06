/**
 * The durable checkpoint catalog: which trees each Session's turn produced.
 *
 * Shapes live in one JSON file under the plugin's store directory, written
 * atomically; the tree objects themselves live in the per-workspace shadow
 * repositories, so the catalog is small and survives Host restarts.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Empty catalog body. */
function emptyCatalog() {
  return { version: 1, sessions: {} }
}

/** Whether a value is a plain object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The catalog file and its in-memory mirror. */
export class Catalog {
  /**
   * @param file - absolute path of the JSON file.
   * @param limits - how many turns one Session keeps.
   */
  constructor(file, limits) {
    this.file = file
    this.limits = limits
    this.data = undefined
    this.loading = undefined
    this.writing = Promise.resolve()
  }

  /** Read the file once, tolerating a missing or damaged catalog. */
  async load() {
    if (this.data !== undefined) return this.data
    if (this.loading === undefined) {
      this.loading = (async () => {
        try {
          const parsed = JSON.parse(await readFile(this.file, 'utf8'))
          const data = isRecord(parsed) && isRecord(parsed.sessions) ? parsed : emptyCatalog()
          data.version = 1
          this.data = data
        } catch {
          this.data = emptyCatalog()
        }
        return this.data
      })()
    }
    return this.loading
  }

  /**
   * One turn's record.
   * @param sessionId - owning Session.
   * @param turn - the turn number.
   * @returns the record, or undefined when this Host never recorded it.
   */
  async turn(sessionId, turn) {
    const data = await this.load()
    const session = data.sessions[sessionId]
    if (session === undefined || !isRecord(session.turns)) return undefined
    return session.turns[String(turn)]
  }

  /**
   * Every recorded turn of one Session, oldest first.
   * @param sessionId - owning Session.
   * @returns the records.
   */
  async turns(sessionId) {
    const data = await this.load()
    const session = data.sessions[sessionId]
    if (session === undefined || !isRecord(session.turns)) return []
    return Object.values(session.turns).sort((left, right) => left.turn - right.turn)
  }

  /**
   * Insert or replace one turn record and persist the catalog.
   * @param sessionId - owning Session.
   * @param record - the record to store; `turn` identifies it.
   * @returns after the catalog is on disk.
   */
  async put(sessionId, record) {
    const data = await this.load()
    const session = data.sessions[sessionId] ?? { turns: {} }
    const turns = isRecord(session.turns) ? session.turns : {}
    turns[String(record.turn)] = record
    const numbers = Object.keys(turns).map(Number).sort((left, right) => left - right)
    while (numbers.length > this.limits.maxTurnsPerSession) {
      const dropped = numbers.shift()
      delete turns[String(dropped)]
    }
    data.sessions[sessionId] = { turns }
    await this.flush()
    return record
  }

  /** Serialise the current catalog to disk, atomically. */
  flush() {
    this.writing = this.writing.then(
      async () => {
        const data = this.data ?? emptyCatalog()
        await mkdir(dirname(this.file), { recursive: true })
        const temporary = `${this.file}.tmp`
        await writeFile(temporary, JSON.stringify(data, null, 2))
        await rename(temporary, this.file)
      },
      () => undefined,
    )
    return this.writing
  }
}
