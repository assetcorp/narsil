import type { PersistenceAdapter } from '@delali/narsil'
import { EVENT_TYPES } from '../events/types'
import { DELIVERY_LOAD_CONCURRENCY, RETRY_DELAYS_MS } from './constants'

export interface Delivery {
  id: string
  type: string
  body: string
  enqueuedAt: number
  sequence: number
  failedTries: number
  dueAt: number
}

export interface DeliveryStore {
  load(): Promise<Delivery[]>
  save(delivery: Delivery): Promise<void>
  remove(id: string): Promise<void>
  flush(): Promise<void>
}

const KEY_SUFFIX = '.json'
const DELIVERY_ID = /^msg_[0-9a-f]{32}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function deliveryOf(key: string, bytes: Uint8Array): Delivery | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(decoder.decode(bytes))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const { id, type, body, enqueuedAt, sequence, failedTries, dueAt } = record
  if (typeof id !== 'string' || !DELIVERY_ID.test(id) || key !== `${id}${KEY_SUFFIX}`) return null
  if (typeof type !== 'string' || !EVENT_TYPES.has(type) || typeof body !== 'string') return null
  if (!isWholeNumber(enqueuedAt) || !isWholeNumber(sequence) || !isWholeNumber(failedTries) || !isWholeNumber(dueAt)) {
    return null
  }
  if (failedTries > RETRY_DELAYS_MS.length || !validBody(body, type)) return null
  return { id, type, body, enqueuedAt, sequence, failedTries, dueAt }
}

function validBody(body: string, type: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
    const record = parsed as Record<string, unknown>
    if (record.type !== type || typeof record.timestamp !== 'string' || !Object.hasOwn(record, 'data')) return false
    return new Date(record.timestamp).toISOString() === record.timestamp
  } catch {
    return false
  }
}

export class MemoryDeliveryStore implements DeliveryStore {
  async load(): Promise<Delivery[]> {
    return []
  }

  async save(): Promise<void> {}

  async remove(): Promise<void> {}

  async flush(): Promise<void> {}
}

export class PersistedDeliveryStore implements DeliveryStore {
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly adapter: PersistenceAdapter) {}

  async load(): Promise<Delivery[]> {
    const keys = await this.adapter.list('')
    const deliveries: Delivery[] = []
    const unreadable: string[] = []
    let next = 0
    const readNext = async (): Promise<void> => {
      while (next < keys.length) {
        const key = keys[next]
        next += 1
        let bytes: Uint8Array | null = null
        try {
          bytes = await this.adapter.load(key)
        } catch {
          continue
        }
        const delivery = bytes === null ? null : deliveryOf(key, bytes)
        if (delivery === null) unreadable.push(key)
        else deliveries.push(delivery)
      }
    }
    await Promise.all(Array.from({ length: Math.min(DELIVERY_LOAD_CONCURRENCY, keys.length) }, readNext))
    await Promise.allSettled(unreadable.map(key => this.adapter.delete(key)))
    return deliveries
  }

  save(delivery: Delivery): Promise<void> {
    const bytes = encoder.encode(JSON.stringify(delivery))
    return this.chain(delivery.id, () => this.adapter.save(`${delivery.id}${KEY_SUFFIX}`, bytes))
  }

  remove(id: string): Promise<void> {
    return this.chain(id, () => this.adapter.delete(`${id}${KEY_SUFFIX}`))
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending.values()])
  }

  private chain(id: string, write: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(write)
    this.pending.set(id, next)
    next
      .finally(() => {
        if (this.pending.get(id) === next) this.pending.delete(id)
      })
      .catch(() => undefined)
    return next
  }
}
