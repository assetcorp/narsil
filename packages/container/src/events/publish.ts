import type { NarsilEventHandlers } from '@delali/narsil'
import type { TaskRecord, TaskStore } from '@delali/narsil/server'
import { ENGINE_EVENT_NAMES, ENGINE_TYPE_PREFIX, TASK_FINISHED_TYPE } from './types'

export interface EventQueue {
  enqueue(type: string, body: string): void
}

export interface EventSink {
  publish(type: string, data: unknown): void
}

const FINISHED_STATUSES: ReadonlySet<TaskRecord['status']> = new Set(['succeeded', 'failed', 'cancelled'])

function errorFields(error: Error): Record<string, unknown> {
  const fields: Record<string, unknown> = { name: error.name, message: error.message }
  const code: unknown = Reflect.get(error, 'code')
  if (typeof code === 'string') fields.code = code
  return fields
}

function replaceValue(_key: string, value: unknown): unknown {
  if (value instanceof Error) return errorFields(value)
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Set) return [...value]
  if (value instanceof Map) return Object.fromEntries(value)
  return value
}

export function deliveryBody(type: string, data: unknown, nowMs: number): string {
  const timestamp = new Date(nowMs).toISOString()
  try {
    return JSON.stringify({ type, timestamp, data }, replaceValue)
  } catch {
    return JSON.stringify({ type, timestamp, data: null })
  }
}

export function createEventSink(
  writeLine: (line: string) => void,
  queue: EventQueue | null,
  deliveredTypes: ReadonlySet<string> | null,
  now: () => number = Date.now,
): EventSink {
  return {
    publish(type, data) {
      const body = deliveryBody(type, data, now())
      try {
        writeLine(body)
      } catch {}
      if (queue !== null && (deliveredTypes === null || deliveredTypes.has(type))) queue.enqueue(type, body)
    },
  }
}

export function engineEventHandlers(sink: EventSink): NarsilEventHandlers {
  const handlers: Record<string, (payload: unknown) => void> = {}
  for (const name of ENGINE_EVENT_NAMES) {
    handlers[name] = payload => sink.publish(`${ENGINE_TYPE_PREFIX}${name}`, payload)
  }
  return handlers as NarsilEventHandlers
}

export class TaskEventStore implements TaskStore {
  constructor(
    private readonly inner: TaskStore,
    private readonly sink: EventSink,
  ) {}

  async set(record: TaskRecord, ttlMs?: number): Promise<void> {
    try {
      await this.inner.set(record, ttlMs)
    } finally {
      if (FINISHED_STATUSES.has(record.status)) this.sink.publish(TASK_FINISHED_TYPE, record)
    }
  }

  get(id: string): Promise<TaskRecord | null> {
    return this.inner.get(id)
  }

  list(): Promise<TaskRecord[]> {
    return this.inner.list()
  }

  delete(id: string): Promise<void> {
    return this.inner.delete(id)
  }

  async shutdown(): Promise<void> {
    await this.inner.shutdown?.()
  }
}
