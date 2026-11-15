import { createHmac, randomBytes } from 'node:crypto'
import { WEBHOOK_DROPPED_TYPE, WEBHOOK_STOPPED_TYPE } from '../events/types'
import {
  GONE_STATUS,
  MAX_QUEUED_DELIVERIES,
  MAX_RETRY_JITTER_FRACTION,
  MAX_SENDS_IN_FLIGHT,
  RETRY_DELAYS_MS,
  SEND_TIMEOUT_MS,
  WEBHOOK_USER_AGENT,
} from './constants'
import type { Delivery, DeliveryStore } from './delivery-store'

const MS_PER_SECOND = 1000
const DELIVERY_ID_BYTES = 16
const MAX_TIMER_WAIT_MS = 2_147_483_647

export interface WebhookQueueOptions {
  url: string
  secret: Uint8Array
  store: DeliveryStore
  report: (type: string, data: Record<string, unknown>) => void
  now?: () => number
  random?: () => number
}

interface QueuedDelivery {
  delivery: Delivery
  timer: NodeJS.Timeout | null
  sending: boolean
}

type SendOutcome = 'delivered' | 'gone' | 'failed' | 'abandoned'

export function signDelivery(secret: Uint8Array, id: string, timestampSeconds: number, body: string): string {
  const digest = createHmac('sha256', secret).update(`${id}.${timestampSeconds}.${body}`, 'utf8').digest('base64')
  return `v1,${digest}`
}

export class WebhookQueue {
  private readonly queued = new Map<string, QueuedDelivery>()
  private readonly ready = new Set<string>()
  private readonly closing = new AbortController()
  private readonly sends = new Set<Promise<void>>()
  private readonly now: () => number
  private readonly random: () => number
  private nextSequence = 0
  private inFlight = 0
  private dropped = 0
  private stopped = false
  private closed = false

  constructor(private readonly options: WebhookQueueOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  async start(): Promise<void> {
    const loaded = await this.options.store.load()
    loaded.sort((left, right) => left.sequence - right.sequence || left.enqueuedAt - right.enqueuedAt)
    for (const delivery of loaded) {
      this.nextSequence = Math.max(this.nextSequence, delivery.sequence + 1)
      this.admit(delivery, false)
    }
    this.pump()
  }

  enqueue(type: string, body: string): void {
    if (this.closed) return
    const now = this.now()
    const delivery: Delivery = {
      id: `msg_${randomBytes(DELIVERY_ID_BYTES).toString('hex')}`,
      type,
      body,
      enqueuedAt: now,
      sequence: this.nextSequence,
      failedTries: 0,
      dueAt: now,
    }
    this.nextSequence += 1
    this.admit(delivery, true)
    this.pump()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.closing.abort()
    for (const entry of this.queued.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer)
      entry.timer = null
    }
    await Promise.allSettled([...this.sends])
    await this.options.store.flush()
  }

  private admit(delivery: Delivery, persist: boolean): void {
    while (this.queued.size >= MAX_QUEUED_DELIVERIES) this.dropOldest()
    const entry: QueuedDelivery = { delivery, timer: null, sending: false }
    this.queued.set(delivery.id, entry)
    if (persist) this.save(delivery)
    this.schedule(entry)
  }

  private dropOldest(): void {
    const oldest = this.queued.keys().next()
    if (oldest.done === true) return
    const entry = this.queued.get(oldest.value)
    if (entry === undefined) return
    this.forget(entry)
    this.dropped += 1
    this.options.report(WEBHOOK_DROPPED_TYPE, {
      reason: 'queueFull',
      deliveryId: entry.delivery.id,
      eventType: entry.delivery.type,
      dropped: this.dropped,
    })
  }

  private forget(entry: QueuedDelivery): void {
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = null
    this.queued.delete(entry.delivery.id)
    this.options.store.remove(entry.delivery.id).catch(() => undefined)
  }

  private save(delivery: Delivery): void {
    this.options.store.save(delivery).catch(() => undefined)
  }

  private schedule(entry: QueuedDelivery): void {
    const wait = entry.delivery.dueAt - this.now()
    if (wait <= 0) {
      this.ready.add(entry.delivery.id)
      return
    }
    entry.timer = setTimeout(
      () => {
        entry.timer = null
        if (this.queued.get(entry.delivery.id) !== entry) return
        if (entry.delivery.dueAt > this.now()) {
          this.schedule(entry)
          return
        }
        this.ready.add(entry.delivery.id)
        this.pump()
      },
      Math.min(wait, MAX_TIMER_WAIT_MS),
    )
    entry.timer.unref()
  }

  private pump(): void {
    while (!this.stopped && !this.closed && this.inFlight < MAX_SENDS_IN_FLIGHT && this.ready.size > 0) {
      const next = this.ready.values().next()
      if (next.done === true) break
      const id = next.value
      this.ready.delete(id)
      const entry = this.queued.get(id)
      if (entry === undefined || entry.sending || entry.timer !== null) continue
      this.inFlight += 1
      entry.sending = true
      const send = this.send(entry.delivery).then(outcome => this.settle(entry, outcome))
      this.sends.add(send)
      void send.finally(() => {
        this.sends.delete(send)
        this.inFlight -= 1
        this.pump()
      })
    }
  }

  private async send(delivery: Delivery): Promise<SendOutcome> {
    const timestamp = Math.floor(this.now() / MS_PER_SECOND)
    const signal = AbortSignal.any([AbortSignal.timeout(SEND_TIMEOUT_MS), this.closing.signal])
    try {
      const response = await fetch(this.options.url, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: {
          'content-type': 'application/json',
          'user-agent': WEBHOOK_USER_AGENT,
          'webhook-id': delivery.id,
          'webhook-timestamp': String(timestamp),
          'webhook-signature': signDelivery(this.options.secret, delivery.id, timestamp, delivery.body),
        },
        body: delivery.body,
      })
      await response.body?.cancel().catch(() => undefined)
      if (response.status >= 200 && response.status < 300) return 'delivered'
      return response.status === GONE_STATUS ? 'gone' : 'failed'
    } catch {
      return this.closing.signal.aborted ? 'abandoned' : 'failed'
    }
  }

  private settle(entry: QueuedDelivery, outcome: SendOutcome): void {
    entry.sending = false
    if (this.queued.get(entry.delivery.id) !== entry || outcome === 'abandoned') return
    if (outcome === 'delivered') {
      this.forget(entry)
      return
    }
    if (outcome === 'gone') this.stop()
    this.retry(entry)
  }

  private stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.options.report(WEBHOOK_STOPPED_TYPE, {
      reason: 'gone',
      status: GONE_STATUS,
      queued: this.queued.size,
    })
  }

  private retry(entry: QueuedDelivery): void {
    const failedTries = entry.delivery.failedTries + 1
    const delay = RETRY_DELAYS_MS[failedTries - 1]
    if (delay === undefined) {
      this.forget(entry)
      this.options.report(WEBHOOK_DROPPED_TYPE, {
        reason: 'retriesExhausted',
        deliveryId: entry.delivery.id,
        eventType: entry.delivery.type,
        tries: failedTries,
      })
      return
    }
    const jittered = Math.round(delay * (1 + this.random() * MAX_RETRY_JITTER_FRACTION))
    entry.delivery = { ...entry.delivery, failedTries, dueAt: this.now() + jittered }
    this.save(entry.delivery)
    this.schedule(entry)
  }
}
