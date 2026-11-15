import type { PersistenceAdapter } from '../types/adapters'
import { DEFAULT_MAX_RETAINED_TASKS, TASK_RECORD_LOAD_CONCURRENCY } from './constants'
import { isTaskStatus, isTaskType, isTerminalTaskStatus } from './task-status'
import type { TaskRecord, TaskStore } from './types'

const RECORD_KEY_SUFFIX = '.json'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function keyOf(id: string): string {
  return `${encodeURIComponent(id)}${RECORD_KEY_SUFFIX}`
}

function idOfKey(key: string): string | null {
  if (!key.endsWith(RECORD_KEY_SUFFIX)) return null
  try {
    return decodeURIComponent(key.slice(0, -RECORD_KEY_SUFFIX.length))
  } catch {
    return null
  }
}

function isStoredRecord(value: unknown, id: string): value is TaskRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record.id === id &&
    isTaskType(record.type) &&
    isTaskStatus(record.status) &&
    typeof record.indexName === 'string' &&
    typeof record.owner === 'string' &&
    typeof record.createdAt === 'number' &&
    Number.isFinite(record.createdAt)
  )
}

function byOldestFirst(left: TaskRecord, right: TaskRecord): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

type LoadedKey = { kind: 'record'; record: TaskRecord } | { kind: 'unreadable' } | { kind: 'malformed' }

/**
 * A {@link TaskStore} that writes every task record through a
 * {@link PersistenceAdapter}, so that a restarted server still reports the
 * tasks that it accepted before the restart.
 *
 * The store writes each record as one JSON file under its id, through the
 * adapter's `save`, so a filesystem adapter replaces each file atomically. It
 * reads every record once, on the first call, and answers every later read
 * from memory, so one server must own the adapter's keys. Writes to one record
 * reach the adapter in the order of the calls. A key that holds no readable
 * record is deleted on that first read, and a key that the adapter fails to
 * load is skipped. The store caps how many records it keeps and drops the
 * oldest finished records first, deleting their keys, which bounds both the
 * memory and the storage that task records take. `ttlMs` is ignored, because
 * the cap plays that role.
 *
 * @public
 */
export class PersistenceTaskStore implements TaskStore {
  private readonly records = new Map<string, TaskRecord>()
  private readonly pendingWrites = new Map<string, Promise<void>>()
  private loading: Promise<void> | null = null

  /**
   * Builds a store over an adapter that it owns alone.
   *
   * @param adapter - The adapter that holds the records, such as one from
   * `createFilesystemPersistence` scoped to a folder that holds nothing else.
   * The store deletes every key of the adapter that holds no task record.
   * @param maxRetained - Records to keep before the oldest finished ones are
   * dropped. Defaults to 1000.
   */
  constructor(
    private readonly adapter: PersistenceAdapter,
    private readonly maxRetained = DEFAULT_MAX_RETAINED_TASKS,
  ) {}

  /**
   * Stores a record and writes it through the adapter, replacing whatever its
   * id already held.
   *
   * @param record - The record to store. A copy is kept, so changing the
   * object afterwards leaves the store untouched.
   * @throws The adapter's error where the write fails. The store still
   * answers reads with the new record, and the next write of that id tries
   * again.
   */
  async set(record: TaskRecord): Promise<void> {
    await this.ensureLoaded()
    const json = JSON.stringify(record)
    this.records.set(record.id, JSON.parse(json) as TaskRecord)
    const written = this.persist(record.id, json)
    this.prune()
    await written
  }

  /**
   * Reads one record back.
   *
   * @param id - The task to read.
   * @returns A copy of the record, or `null` when the store holds no such id.
   */
  async get(id: string): Promise<TaskRecord | null> {
    await this.ensureLoaded()
    const record = this.records.get(id)
    return record ? { ...record } : null
  }

  /**
   * Lists every record the store holds.
   *
   * @returns A copy of each record, oldest first.
   */
  async list(): Promise<TaskRecord[]> {
    await this.ensureLoaded()
    return [...this.records.values()].map(record => ({ ...record }))
  }

  /**
   * Removes one record and deletes its key. An id the store never held is not
   * an error.
   *
   * @param id - The task to remove.
   */
  async delete(id: string): Promise<void> {
    await this.ensureLoaded()
    this.records.delete(id)
    await this.persist(id, null)
  }

  /** Resolves once every write that the store has started reaches the adapter, failed or not. */
  async shutdown(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.allSettled([...this.pendingWrites.values()])
    }
  }

  private ensureLoaded(): Promise<void> {
    if (this.loading === null) {
      this.loading = this.load().catch((err: unknown) => {
        this.loading = null
        throw err
      })
    }
    return this.loading
  }

  private async load(): Promise<void> {
    const keys = await this.adapter.list('')
    const loaded: TaskRecord[] = []
    const malformed: string[] = []
    let next = 0
    const readNext = async (): Promise<void> => {
      while (next < keys.length) {
        const key = keys[next]
        next += 1
        const outcome = await this.loadKey(key)
        if (outcome.kind === 'record') loaded.push(outcome.record)
        else if (outcome.kind === 'malformed') malformed.push(key)
      }
    }
    await Promise.all(Array.from({ length: Math.min(TASK_RECORD_LOAD_CONCURRENCY, keys.length) }, readNext))
    loaded.sort(byOldestFirst)
    for (const record of loaded) this.records.set(record.id, record)
    await Promise.allSettled(malformed.map(key => this.adapter.delete(key)))
    this.prune()
  }

  private async loadKey(key: string): Promise<LoadedKey> {
    const id = idOfKey(key)
    if (id === null) return { kind: 'malformed' }
    let bytes: Uint8Array | null
    try {
      bytes = await this.adapter.load(key)
    } catch {
      return { kind: 'unreadable' }
    }
    if (bytes === null) return { kind: 'unreadable' }
    try {
      const parsed: unknown = JSON.parse(decoder.decode(bytes))
      return isStoredRecord(parsed, id) ? { kind: 'record', record: parsed } : { kind: 'malformed' }
    } catch {
      return { kind: 'malformed' }
    }
  }

  private persist(id: string, json: string | null): Promise<void> {
    const key = keyOf(id)
    const previous = this.pendingWrites.get(id) ?? Promise.resolve()
    const write = previous
      .catch(() => undefined)
      .then(() => (json === null ? this.adapter.delete(key) : this.adapter.save(key, encoder.encode(json))))
    this.pendingWrites.set(id, write)
    write
      .finally(() => {
        if (this.pendingWrites.get(id) === write) this.pendingWrites.delete(id)
      })
      .catch(() => undefined)
    return write
  }

  private prune(): void {
    if (this.records.size <= this.maxRetained) return
    for (const [id, record] of this.records) {
      if (this.records.size <= this.maxRetained) break
      if (!isTerminalTaskStatus(record.status)) continue
      this.records.delete(id)
      this.persist(id, null).catch(() => undefined)
    }
  }
}
