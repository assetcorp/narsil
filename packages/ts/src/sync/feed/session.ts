import { decode } from '../../serialization/msgpack'
import {
  type DeviceMessage,
  deviceMessageOf,
  MAX_DEVICE_MESSAGE_BYTES,
  positionList,
  positionsByPartition,
  type ResyncReason,
  SYNC_CLOSE_CREDENTIAL_EXPIRED,
  SYNC_CLOSE_POLICY,
  SYNC_CLOSE_RESYNC,
  SYNC_CLOSE_SERVER_ERROR,
  SYNC_CLOSE_TOO_LARGE,
} from '../protocol'
import { ENTRIES_MESSAGE_LIMIT_BYTES, FEED_HEAD_RETRY_MS, TIMER_DELAY_LIMIT_MS } from './constants'
import { encodeEntriesMessage, encodeServerMessage } from './encode'
import type { ByteBudget, Semaphore } from './limits'
import type { FeedSource, PartitionBounds } from './source'

export interface FeedSocket {
  send(bytes: Uint8Array): void
  bufferedAmount(): number
  close(code: number, reason: string): void
}

export interface FeedSessionDeps {
  source: FeedSource
  indexName: string
  socket: FeedSocket
  windowBytes: number
  expiresAt: number | null
  reads: Semaphore
  buffered: ByteBudget
  onClosed(session: FeedSession): void
  onError(error: unknown): void
}

interface Unacked {
  seqNo: number
  bytes: number
}

interface UnackedQueue {
  items: Unacked[]
  head: number
}

export class FeedSession {
  private state: 'awaiting' | 'subscribed' | 'closed' = 'awaiting'
  private epoch = ''
  private sent: number[] = []
  private heads: number[] = []
  private readonly unacked: UnackedQueue[] = []
  private unackedBytes = 0
  private charged = 0
  private pumping = false
  private pumpAgain = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private expiry: ReturnType<typeof setTimeout> | null = null
  private incoming: Promise<void> = Promise.resolve()
  private readonly stopBudgetWatch: () => void

  constructor(private readonly deps: FeedSessionDeps) {
    this.stopBudgetWatch = deps.buffered.onFreed(() => {
      if (this.state === 'subscribed' && this.charged === 0) this.advance()
    })
    this.armExpiry()
  }

  private armExpiry(): void {
    const { expiresAt } = this.deps
    if (expiresAt === null || this.state === 'closed') return
    const remaining = expiresAt - Date.now()
    if (remaining <= 0) {
      queueMicrotask(() => this.close(SYNC_CLOSE_CREDENTIAL_EXPIRED, 'credential expired'))
      return
    }
    this.expiry = setTimeout(
      () => {
        this.expiry = null
        this.armExpiry()
      },
      Math.min(remaining, TIMER_DELAY_LIMIT_MS),
    )
  }

  get indexName(): string {
    return this.deps.indexName
  }

  receive(bytes: Uint8Array, binary = true): void {
    if (this.state === 'closed') return
    if (!binary) {
      this.close(SYNC_CLOSE_POLICY, 'feed messages travel in binary frames')
      return
    }
    if (bytes.byteLength > MAX_DEVICE_MESSAGE_BYTES) {
      this.close(SYNC_CLOSE_TOO_LARGE, 'message too large')
      return
    }
    let message: DeviceMessage | null
    try {
      message = deviceMessageOf(decode(bytes))
    } catch {
      message = null
    }
    if (message === null) {
      this.close(SYNC_CLOSE_POLICY, 'invalid message')
      return
    }
    const received = message
    this.incoming = this.incoming.then(() => this.handle(received)).catch(error => this.fail(error))
  }

  advance(): void {
    if (this.state !== 'subscribed') return
    void this.pump()
  }

  sendSettings(): void {
    if (this.state !== 'subscribed') return
    const state = this.deps.source.indexState(this.deps.indexName)
    if (state === null) return
    this.send(encodeServerMessage({ type: 'settings', settings: state.settings }))
  }

  drained(): void {
    this.settleBuffered()
    this.advance()
  }

  resync(reason: ResyncReason): void {
    if (this.state === 'closed') return
    this.send(encodeServerMessage({ type: 'resync', reason }))
    this.close(SYNC_CLOSE_RESYNC, `resync ${reason}`)
  }

  close(code: number, reason: string): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.cleanUp()
    this.deps.socket.close(code, reason)
    this.deps.onClosed(this)
  }

  closedByPeer(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.cleanUp()
    this.deps.onClosed(this)
  }

  private cleanUp(): void {
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
    if (this.expiry !== null) clearTimeout(this.expiry)
    this.expiry = null
    this.stopBudgetWatch()
    this.deps.buffered.give(this.charged)
    this.charged = 0
  }

  private fail(error: unknown): void {
    this.deps.onError(error)
    this.close(SYNC_CLOSE_SERVER_ERROR, 'feed read failed')
  }

  private send(bytes: Uint8Array): void {
    if (this.state === 'closed') return
    this.deps.socket.send(bytes)
    this.settleBuffered()
  }

  private settleBuffered(): void {
    const now = this.state === 'closed' ? 0 : this.deps.socket.bufferedAmount()
    if (now < this.charged) this.deps.buffered.give(this.charged - now)
    this.charged = Math.min(this.charged, now)
  }

  private async handle(message: DeviceMessage): Promise<void> {
    if (this.state === 'closed') return
    if (message.type === 'subscribe') {
      if (this.state !== 'awaiting') return this.close(SYNC_CLOSE_POLICY, 'subscribe after the first message')
      return this.subscribe(message.epoch, message.positions)
    }
    if (this.state !== 'subscribed') return this.close(SYNC_CLOSE_POLICY, 'subscribe must come first')
    if (message.type === 'ack') return this.acknowledge(message.positions)
    this.answerCheckpoint(message.id).catch(error => this.fail(error))
  }

  private async currentBounds(): Promise<PartitionBounds[]> {
    const all: PartitionBounds[] = []
    for (let partitionId = 0; partitionId < this.sent.length; partitionId++) {
      all.push(await this.deps.source.bounds(this.deps.indexName, partitionId, 'current'))
    }
    return all
  }

  private async answerCheckpoint(id: number): Promise<void> {
    const covering = (await this.currentBounds()).map(bounds => bounds.highestSeqNo)
    while (this.state === 'subscribed') {
      const all = await this.currentBounds()
      let covered = true
      for (let partitionId = 0; partitionId < all.length; partitionId++) {
        covering[partitionId] = Math.min(covering[partitionId], all[partitionId].highestSeqNo)
        const reachable = Math.max(all[partitionId].head, this.sent[partitionId])
        if (reachable < covering[partitionId]) covered = false
      }
      if (covered) {
        const heads = all.map(bounds => bounds.head)
        this.send(encodeServerMessage({ type: 'checkpoint', id, heads: positionList(heads) }))
        this.advance()
        return
      }
      await new Promise(resolve => setTimeout(resolve, FEED_HEAD_RETRY_MS))
    }
  }

  private async subscribe(epoch: string, positions: readonly { partitionId: number; seqNo: number }[]) {
    const { source, indexName } = this.deps
    const state = source.indexState(indexName)
    if (state === null) return this.close(SYNC_CLOSE_RESYNC, 'sync is off')
    if (epoch !== state.epoch) return this.resync('epoch')
    const seqNos = positionsByPartition(positions, state.partitionCount)
    if (seqNos === null) return this.close(SYNC_CLOSE_POLICY, 'positions must name each partition once')
    const heads: number[] = []
    for (let partitionId = 0; partitionId < state.partitionCount; partitionId++) {
      const bounds = await this.deps.reads.run(() => source.bounds(indexName, partitionId, 'current'))
      if (seqNos[partitionId] < bounds.oldestSeqNo - 1) return this.resync('history')
      if (seqNos[partitionId] > bounds.highestSeqNo) return this.resync('ahead')
      heads.push(bounds.head)
    }
    const bytesBehind = await this.deps.reads.run(() => source.bytesBehind(indexName, seqNos))
    const snapshotBytes = await this.deps.reads.run(() => source.snapshotBytes(indexName))
    if (this.state === 'closed') return
    if (source.indexState(indexName)?.epoch !== epoch) return this.resync('epoch')
    this.epoch = epoch
    this.sent = seqNos
    this.heads = heads
    for (let i = 0; i < state.partitionCount; i++) this.unacked.push({ items: [], head: 0 })
    this.state = 'subscribed'
    this.send(
      encodeServerMessage({
        type: 'subscribed',
        epoch,
        partitionCount: state.partitionCount,
        heads: positionList(heads),
        bytesBehind,
        snapshotBytes,
        windowBytes: this.deps.windowBytes,
        settings: state.settings,
      }),
    )
    void this.pump()
  }

  private acknowledge(positions: readonly { partitionId: number; seqNo: number }[]): void {
    const seqNos = positionsByPartition(positions, this.sent.length)
    if (seqNos === null) {
      this.close(SYNC_CLOSE_POLICY, 'positions must name each partition once')
      return
    }
    for (let partitionId = 0; partitionId < seqNos.length; partitionId++) {
      if (seqNos[partitionId] > this.sent[partitionId]) {
        this.close(SYNC_CLOSE_POLICY, 'acknowledgement above a sent entry')
        return
      }
    }
    for (let partitionId = 0; partitionId < seqNos.length; partitionId++) {
      const queue = this.unacked[partitionId]
      while (queue.head < queue.items.length && queue.items[queue.head].seqNo <= seqNos[partitionId]) {
        this.unackedBytes -= queue.items[queue.head].bytes
        queue.head += 1
      }
      if (queue.head > 0 && queue.head * 2 >= queue.items.length) {
        queue.items = queue.items.slice(queue.head)
        queue.head = 0
      }
    }
    void this.pump()
  }

  private windowAllows(nextBytes: number): boolean {
    return this.unackedBytes === 0 || this.unackedBytes + nextBytes <= this.deps.windowBytes
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpAgain = false
        await this.refreshHeads()
        await this.sendBehind()
      } while (this.pumpAgain && this.state === 'subscribed')
      this.scheduleRetryWhileUndurable()
    } catch (error) {
      this.fail(error)
    } finally {
      this.pumping = false
    }
  }

  private async refreshHeads(): Promise<void> {
    const { source, indexName } = this.deps
    if (source.indexState(indexName)?.epoch !== this.epoch) return this.resync('epoch')
    for (let partitionId = 0; partitionId < this.heads.length; partitionId++) {
      this.heads[partitionId] = Math.max(this.heads[partitionId], (await source.bounds(indexName, partitionId)).head)
    }
  }

  private async sendBehind(): Promise<void> {
    const { source, indexName } = this.deps
    let progressed = true
    while (progressed && this.state === 'subscribed') {
      progressed = false
      for (let partitionId = 0; partitionId < this.heads.length; partitionId++) {
        if (this.state !== 'subscribed' || this.sent[partitionId] >= this.heads[partitionId]) continue
        if (!this.windowAllows(1) || this.charged > 0) return
        const room = this.unackedBytes === 0 ? this.deps.windowBytes : this.deps.windowBytes - this.unackedBytes
        const maxBytes = Math.max(1, Math.min(room, ENTRIES_MESSAGE_LIMIT_BYTES))
        const after = this.sent[partitionId]
        const read = await this.deps.reads.run(() =>
          source.read(indexName, partitionId, after, this.heads[partitionId], maxBytes),
        )
        if (this.state !== 'subscribed') return
        if (read.gone) return this.resync('history')
        const frames = read.frames.filter(frame => frame.seqNo > this.sent[partitionId])
        if (frames.length === 0) continue
        let bytes = 0
        for (const frame of frames) bytes += frame.payload.byteLength
        if (!this.windowAllows(bytes)) return
        const message = encodeEntriesMessage(
          partitionId,
          frames.map(frame => frame.payload),
        )
        if (!this.deps.buffered.take(message.byteLength)) return
        this.charged += message.byteLength
        const queue = this.unacked[partitionId].items
        for (const frame of frames) queue.push({ seqNo: frame.seqNo, bytes: frame.payload.byteLength })
        this.unackedBytes += bytes
        this.sent[partitionId] = frames[frames.length - 1].seqNo
        this.send(message)
        progressed = true
      }
    }
  }

  private scheduleRetryWhileUndurable(): void {
    if (this.state !== 'subscribed' || this.retry !== null) return
    const { source, indexName } = this.deps
    const waiting = this.heads.some((head, partitionId) => source.pendingBeyondHead(indexName, partitionId, head))
    if (!waiting) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.advance()
    }, FEED_HEAD_RETRY_MS)
  }
}
