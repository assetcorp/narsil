import { randomUUID } from 'node:crypto'
import { NarsilError } from '../errors'
import { serializeNarsilError } from './errors'
import type { ImportResult, TaskListPage, TaskListQuery, TaskProgress, TaskRecord, TaskStore, TaskType } from './types'

const RUNNING_TTL_MS = 24 * 60 * 60 * 1000
const TERMINAL_TTL_MS = 60 * 60 * 1000
const PROGRESS_WRITE_INTERVAL_MS = 250
const DEFAULT_TASK_PAGE_SIZE = 20

/**
 * What a running task reports back while it works, and how it learns that a
 * cancel arrived.
 *
 * @public
 */
export interface TaskContext {
  /** Aborts once a cancel arrives, so long-running work can stop between units. */
  readonly signal: AbortSignal
  /**
   * Records how far the work has gone, which `GET /tasks/{id}` then reports.
   *
   * @param progress - The counters as they stand now.
   */
  reportProgress(progress: TaskProgress): void
  /**
   * Records what the work produced, which the finished task then carries.
   *
   * @param result - What the work produced.
   */
  reportResult(result: ImportResult): void
}

/**
 * The work one task runs.
 *
 * Resolving marks the task succeeded. Rejecting marks it failed, unless a
 * cancel had already arrived, which marks it cancelled instead. Work that
 * cannot stop early ignores the signal and still finishes.
 *
 * @public
 */
export type TaskOperation = (ctx: TaskContext) => Promise<void>

/** Why a cancel request did not put a task into cancelling. */
export type CancelOutcome = 'cancelling' | 'not-found' | 'already-finished' | 'owned-by-another-instance'

interface LiveTask {
  record: TaskRecord
  controller: AbortController
  writes: Promise<void>
  lastProgressWriteAt: number
  settled: boolean
}

function byNewestFirst(left: TaskRecord, right: TaskRecord): number {
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt
  return left.id.localeCompare(right.id)
}

function matchesQuery(record: TaskRecord, query: TaskListQuery): boolean {
  if (query.indexName !== undefined && record.indexName !== query.indexName) return false
  if (query.type !== undefined && query.type.length > 0 && !query.type.includes(record.type)) return false
  if (query.status !== undefined && query.status.length > 0 && !query.status.includes(record.status)) return false
  return true
}

/**
 * Drives long-running operations (import, optimizeVectors, rebalance, restore,
 * rebuildAnalysis) that acknowledge with a task record the client polls. A
 * pluggable {@link TaskStore} holds the status of every task; the default is
 * in-process and lost on restart, but a shared store lets any instance report a
 * task and lets status survive a restart. The work itself still runs in this
 * process against the in-memory engine, so a shared store gives cross-instance
 * visibility, not durable or distributed execution.
 */
export class TaskRegistry {
  private readonly live = new Map<string, LiveTask>()

  constructor(
    private readonly store: TaskStore,
    private readonly instanceId: string,
  ) {}

  /** Records a task as running and drives `op` to completion in the background.
   * Returns the record once it is persisted so the caller can respond 202. */
  async start(type: TaskType, indexName: string, op: TaskOperation, progress?: TaskProgress): Promise<TaskRecord> {
    const now = Date.now()
    const record: TaskRecord = {
      id: randomUUID(),
      type,
      indexName,
      owner: this.instanceId,
      status: 'running',
      createdAt: now,
      startedAt: now,
      ...(progress === undefined ? {} : { progress }),
    }
    const task: LiveTask = {
      record,
      controller: new AbortController(),
      writes: Promise.resolve(),
      lastProgressWriteAt: now,
      settled: false,
    }
    this.live.set(record.id, task)
    await this.enqueueWrite(task, record, RUNNING_TTL_MS)
    void this.drive(task, op)
    return record
  }

  get(id: string): Promise<TaskRecord | null> {
    return this.store.get(id)
  }

  /** Reads one page of task records, newest first, keeping only what the query
   * matches. Filtering happens here rather than in the store, so every custom
   * {@link TaskStore} works unchanged. */
  async list(query: TaskListQuery = {}): Promise<TaskListPage> {
    const from = Math.max(0, Math.trunc(query.from ?? 0))
    const limit = Math.max(1, Math.trunc(query.limit ?? DEFAULT_TASK_PAGE_SIZE))
    const matched = (await this.store.list()).filter(record => matchesQuery(record, query)).sort(byNewestFirst)
    const page = matched.slice(from, from + limit)
    const consumed = from + page.length
    return { tasks: page, total: matched.length, from, limit, next: consumed < matched.length ? consumed : null }
  }

  /** Asks a running task to stop. The work stops between units, so the task
   * reaches `cancelled` only once it actually stopped, and a request that
   * arrives too late leaves it `succeeded`. */
  async cancel(id: string): Promise<{ outcome: CancelOutcome; record: TaskRecord | null }> {
    const stored = await this.store.get(id)
    if (!stored) return { outcome: 'not-found', record: null }
    if (stored.status !== 'running' && stored.status !== 'queued') {
      return { outcome: 'already-finished', record: stored }
    }

    const task = this.live.get(id)
    if (!task) {
      const outcome = stored.owner === this.instanceId ? 'already-finished' : 'owned-by-another-instance'
      return { outcome, record: stored }
    }

    task.controller.abort(new Error('The task was cancelled'))
    const record: TaskRecord = { ...task.record, cancelRequestedAt: Date.now() }
    task.record = record
    await this.enqueueWrite(task, record, RUNNING_TTL_MS)
    return { outcome: 'cancelling', record }
  }

  /** Fails this instance's previously-running tasks after a restart. A task can
   * only be advanced by the process that owns it, so its own running tasks from
   * a prior life are dead and must not keep showing a stale running status. This
   * is effective only with a stable instanceId; with the default random id it
   * finds none of its own prior tasks, which is also correct for the in-memory
   * default (which starts empty). */
  async reconcile(): Promise<void> {
    let records: TaskRecord[]
    try {
      records = await this.store.list()
    } catch {
      return
    }
    for (const record of records) {
      if (record.owner !== this.instanceId) continue
      if (record.status !== 'running' && record.status !== 'queued') continue
      const failed: TaskRecord = {
        ...record,
        status: 'failed',
        completedAt: Date.now(),
        error: { code: 'TASK_INTERRUPTED', message: 'The server restarted while this task was running' },
      }
      try {
        await this.store.set(failed, TERMINAL_TTL_MS)
      } catch {
        // best effort; a store failure here must not block startup
      }
    }
  }

  private enqueueWrite(task: LiveTask, record: TaskRecord, ttlMs: number): Promise<void> {
    task.writes = task.writes.then(
      () => this.store.set(record, ttlMs),
      () => this.store.set(record, ttlMs),
    )
    return task.writes.catch(() => {})
  }

  private reportProgress(task: LiveTask, progress: TaskProgress): void {
    if (task.settled) return
    task.record = { ...task.record, progress }
    const now = Date.now()
    if (now - task.lastProgressWriteAt < PROGRESS_WRITE_INTERVAL_MS) return
    task.lastProgressWriteAt = now
    void this.enqueueWrite(task, task.record, RUNNING_TTL_MS)
  }

  private async drive(task: LiveTask, op: TaskOperation): Promise<void> {
    const context: TaskContext = {
      signal: task.controller.signal,
      reportProgress: progress => this.reportProgress(task, progress),
      reportResult: result => {
        task.record = { ...task.record, result }
      },
    }

    let settled: TaskRecord
    try {
      await op(context)
      settled = { ...task.record, status: 'succeeded' }
    } catch (err) {
      settled = task.controller.signal.aborted
        ? { ...task.record, status: 'cancelled' }
        : {
            ...task.record,
            status: 'failed',
            error:
              err instanceof NarsilError
                ? serializeNarsilError(err)
                : { code: 'INTERNAL_ERROR', message: 'The operation failed' },
          }
    }

    task.settled = true
    task.record = { ...settled, completedAt: Date.now() }
    await this.enqueueWrite(task, task.record, TERMINAL_TTL_MS)
    this.live.delete(task.record.id)
  }
}
