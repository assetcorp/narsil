import { MAX_QUEUED_DELIVERIES } from '../webhooks/constants'
import type { EventQueue } from './publish'

export class DeferredEventQueue implements EventQueue {
  private readonly pending = new Map<number, { type: string; body: string }>()
  private queue: EventQueue | null = null
  private sequence = 0
  private dropped = 0

  constructor(private readonly reportDrop: (count: number) => void) {}

  enqueue(type: string, body: string): void {
    if (this.queue !== null) {
      this.queue.enqueue(type, body)
      return
    }
    if (this.pending.size >= MAX_QUEUED_DELIVERIES) {
      const first = this.pending.keys().next()
      if (!first.done) this.pending.delete(first.value)
      this.reportDrop(++this.dropped)
    }
    this.pending.set(this.sequence++, { type, body })
  }

  connect(queue: EventQueue): void {
    this.queue = queue
    for (const event of this.pending.values()) queue.enqueue(event.type, event.body)
    this.pending.clear()
  }
}
