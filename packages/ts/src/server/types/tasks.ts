import type { ImportResult } from './requests'

/**
 * Which long-running operation a task record tracks.
 *
 * @public
 */
export type TaskType = 'optimizeVectors' | 'rebalance' | 'restore' | 'import' | 'rebuildAnalysis'

/**
 * Where a long-running operation stands.
 *
 * A task reaches `cancelled` only when the work itself stopped early, so a
 * cancel that arrives too late leaves the task `succeeded`.
 *
 * @public
 */
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

/**
 * How far a running import has gone, which is what a progress bar reads.
 *
 * The byte counts describe the request body, so they give an honest fraction
 * from the first batch onwards, while the document counts only cover what the
 * server has already handed to the engine. Task types other than `import`
 * report no progress.
 *
 * @public
 */
export interface TaskProgress {
  /** The server has indexed this many documents so far. */
  indexed: number
  /** The server has rejected this many documents so far. */
  failed: number
  /** The server has read this many bytes of the body so far. */
  bytesProcessed: number
  /** The body holds this many bytes in total. */
  bytesTotal: number
}

/**
 * One long-running operation, which the server answers with straight away and
 * you then poll.
 *
 * Every route that starts a task answers with this same record, and
 * `GET /tasks/{id}` returns it again as the work moves on.
 *
 * @public
 */
export interface TaskRecord {
  /** This identifies the task, and is what you poll by. */
  id: string
  /** This says which operation the task runs. */
  type: TaskType
  /** The operation runs against this index. */
  indexName: string
  /** This says where the operation stands. */
  status: TaskStatus
  /** Identifier of the server instance running this task; see ServerOptions.instanceId. */
  owner: string
  /** The server accepted the task at this many milliseconds since the epoch. */
  createdAt: number
  /** Work started at this many milliseconds since the epoch, and a queued task omits it. */
  startedAt?: number
  /** Work ended at this many milliseconds since the epoch, and a task omits it until it reaches a final status. */
  completedAt?: number
  /** A cancel arrived at this many milliseconds since the epoch, which is how a
   * task still running shows that it is stopping. */
  cancelRequestedAt?: number
  /** How far the work has gone, which an import reports and other task types omit. */
  progress?: TaskProgress
  /** What the work produced, which an import reports once it finishes. */
  result?: ImportResult
  /** This says why the task failed, and a failed task alone carries it. */
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

/**
 * Which task records `GET /tasks` returns, and where the page starts.
 *
 * Every filter is optional, and omitting all of them lists every record the
 * store still holds, newest first.
 *
 * @public
 */
export interface TaskListQuery {
  /** Keeps the tasks running against this index. */
  indexName?: string
  /** Keeps the tasks of these types. */
  type?: TaskType[]
  /** Keeps the tasks at these statuses. */
  status?: TaskStatus[]
  /** Skips this many records, and starts at the newest by default. */
  from?: number
  /** The page carries this many records, and 20 by default. */
  limit?: number
}

/**
 * One page of task records, ordered newest first.
 *
 * @public
 */
export interface TaskListPage {
  /** The records this page carries. */
  tasks: TaskRecord[]
  /** How many records the filters matched in total, across every page. */
  total: number
  /** This page skipped this many records. */
  from: number
  /** This page asked for this many records. */
  limit: number
  /** Pass this back as `from` for the next page, and it is null on the last page. */
  next: number | null
}

/**
 * Pluggable backing store for task records. Every method is async so any
 * backend works: an in-memory map, Redis, an HTTP key-value service, or a
 * database. `set` upserts by `record.id`; `get` returns null for an unknown id.
 * `ttlMs`, when honored by the backend, expires the record so terminal tasks do
 * not accumulate. The server never calls a method that mutates a record it did
 * not construct, so a backend may treat records as immutable snapshots.
 *
 * @public
 */
export interface TaskStore {
  /**
   * Stores a record, replacing whatever its id already held.
   *
   * @param record - The record to store.
   * @param ttlMs - Milliseconds after which the backend may drop it, which
   * keeps finished tasks from accumulating. Ignore it in a backend without
   * expiry.
   */
  set(record: TaskRecord, ttlMs?: number): Promise<void>
  /**
   * Reads one record back.
   *
   * @param id - The task to read.
   * @returns The record, or `null` when the store holds no such id.
   */
  get(id: string): Promise<TaskRecord | null>
  /**
   * Lists every record the store holds.
   *
   * @returns Each record the backend still has.
   */
  list(): Promise<TaskRecord[]>
  /**
   * Removes one record. An id the store never held is not an error.
   *
   * @param id - The task to remove.
   */
  delete(id: string): Promise<void>
  /** Releases whatever the backend holds open, such as a connection pool. */
  shutdown?(): Promise<void>
}
