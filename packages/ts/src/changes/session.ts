import { decode, ErrorCodes, NarsilError } from '#platform/storage-host'
import { ENTRIES_MESSAGE_LIMIT_BYTES, FEED_HEAD_RETRY_MS, TIMER_DELAY_LIMIT_MS } from '../sync/feed/constants'
import type { ByteBudget, Semaphore } from '../sync/feed/limits'
import type { FeedSocket } from '../sync/feed/session'
import type { ChangePosition } from '../types/changes'
import { ChangeCursor, type ResyncReason } from './cursor'
import { encodeChangesMessage, encodeFeedMessage } from './encode'
import { changePositionList, type SubscriberMessage, seqNosByPartition, subscriberMessageOf } from './protocol'
import type { ChangeSource } from './source'
import {
  CHANGES_CLOSE_CREDENTIAL_EXPIRED,
  CHANGES_CLOSE_POLICY,
  CHANGES_CLOSE_RESYNC,
  CHANGES_CLOSE_SERVER_ERROR,
  CHANGES_CLOSE_SETTING,
  CHANGES_CLOSE_TOO_LARGE,
  closeReasonOf,
  MAX_SUBSCRIBER_MESSAGE_BYTES,
} from './wire'

export interface ChangesSessionDeps {
  source: ChangeSource
  indexName: string
  socket: FeedSocket
  windowBytes: number
  expiresAt: number | null
  reads: Semaphore
  buffered: ByteBudget
  refuseFilter(filter: unknown): Error | null
  onClosed(session: ChangesSession): void
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

const POLICY_CODES: ReadonlySet<string> = new Set([
  ErrorCodes.CHANGES_INVALID_POSITIONS,
  ErrorCodes.SEARCH_INVALID_FILTER,
  ErrorCodes.SEARCH_INVALID_FIELD,
])

export class ChangesSession {
  private state: 'awaiting' | 'subscribed' | 'closed' = 'awaiting'
  private cursor: ChangeCursor | null = null
  private sentSeqNos: number[] = []
  private silentBytes: number[] = []
  private readonly unacked: UnackedQueue[] = []
  private unackedBytes = 0
  private charged = 0
  private pumping = false
  private pumpAgain = false
  private retry: ReturnType<typeof setTimeout> | null = null
  private expiry: ReturnType<typeof setTimeout> | null = null
  private incoming: Promise<void> = Promise.resolve()
  private readonly stopBudgetWatch: () => void

  constructor(private readonly deps: ChangesSessionDeps) {
    this.stopBudgetWatch = deps.buffered.onFreed(() => {
      if (this.state === 'subscribed' && this.charged === 0) this.advance()
    })
    this.armExpiry()
  }

  get indexName(): string {
    return this.deps.indexName
  }

  receive(bytes: Uint8Array, binary = true): void {
    if (this.state === 'closed') return
    if (!binary) {
      this.close(CHANGES_CLOSE_POLICY, 'feed messages travel in binary frames')
      return
    }
    if (bytes.byteLength > MAX_SUBSCRIBER_MESSAGE_BYTES) {
      this.close(CHANGES_CLOSE_TOO_LARGE, 'message too large')
      return
    }
    let message: SubscriberMessage | null
    try {
      message = subscriberMessageOf(decode(bytes))
    } catch {
      message = null
    }
    if (message === null) {
      this.close(CHANGES_CLOSE_POLICY, 'invalid message')
      return
    }
    const received = message
    this.incoming = this.incoming.then(() => this.handle(received)).catch(error => this.fail(error))
  }

  advance(): void {
    if (this.state !== 'subscribed') return
    void this.pump()
  }

  drained(): void {
    this.settleBuffered()
    this.advance()
  }

  resync(reason: ResyncReason): void {
    if (this.state === 'closed') return
    this.send(encodeFeedMessage({ type: 'resync', reason }))
    this.close(CHANGES_CLOSE_RESYNC, `resync ${reason}`)
  }

  previousDocumentOff(): void {
    if (this.cursor?.filtered === true) this.refuseFilterSetting()
  }

  close(code: number, reason: string): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.cleanUp()
    this.deps.socket.close(code, closeReasonOf(reason))
    this.deps.onClosed(this)
  }

  closedByPeer(): void {
    if (this.state === 'closed') return
    this.state = 'closed'
    this.cleanUp()
    this.deps.onClosed(this)
  }

  private armExpiry(): void {
    const { expiresAt } = this.deps
    if (expiresAt === null || this.state === 'closed') return
    const remaining = expiresAt - Date.now()
    if (remaining <= 0) {
      queueMicrotask(() => this.close(CHANGES_CLOSE_CREDENTIAL_EXPIRED, 'credential expired'))
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

  private refuseFilterSetting(): void {
    this.close(CHANGES_CLOSE_SETTING, ErrorCodes.CHANGES_PREVIOUS_DOCUMENT_REQUIRED)
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
    this.close(CHANGES_CLOSE_SERVER_ERROR, 'feed read failed')
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

  private async handle(message: SubscriberMessage): Promise<void> {
    if (this.state === 'closed') return
    if (message.type === 'subscribe') {
      if (this.state !== 'awaiting' || this.cursor !== null) {
        return this.close(CHANGES_CLOSE_POLICY, 'subscribe after the first message')
      }
      return this.subscribe(message)
    }
    if (this.state !== 'subscribed') return this.close(CHANGES_CLOSE_POLICY, 'subscribe must come first')
    this.acknowledge(message.positions)
  }

  private closeOver(error: unknown): void {
    if (!(error instanceof NarsilError)) this.fail(error)
    else if (error.code === ErrorCodes.CHANGES_PREVIOUS_DOCUMENT_REQUIRED) this.refuseFilterSetting()
    else if (error.code === ErrorCodes.CHANGES_NOT_ENABLED) this.close(CHANGES_CLOSE_RESYNC, 'change capture is off')
    else if (POLICY_CODES.has(error.code)) this.close(CHANGES_CLOSE_POLICY, error.message)
    else this.fail(error)
  }

  private async subscribe(message: Extract<SubscriberMessage, { type: 'subscribe' }>): Promise<void> {
    const { source, indexName, reads } = this.deps
    if (message.filter !== undefined) {
      const refused = this.deps.refuseFilter(message.filter)
      if (refused !== null) return this.close(CHANGES_CLOSE_POLICY, refused.message)
    }
    let opened: ChangeCursor | ResyncReason
    let vectorFields: string[] = []
    try {
      opened = await ChangeCursor.open({ source, indexName, reads }, message)
      if (typeof opened !== 'string') vectorFields = [...(await source.vectorFieldPaths(indexName))].sort()
    } catch (error) {
      return this.closeOver(error)
    }
    if (this.state === 'closed') return
    if (typeof opened === 'string') return this.resync(opened)
    const cursor = opened
    this.cursor = cursor
    this.sentSeqNos = [...cursor.subscribedSeqNos]
    this.silentBytes = new Array<number>(cursor.state.partitionCount).fill(0)
    for (let i = 0; i < cursor.state.partitionCount; i++) this.unacked.push({ items: [], head: 0 })
    this.state = 'subscribed'
    this.send(
      encodeFeedMessage({
        type: 'subscribed',
        epoch: cursor.state.epoch,
        partitionCount: cursor.state.partitionCount,
        positions: changePositionList(cursor.subscribedSeqNos),
        heads: changePositionList(cursor.heads),
        bytesBehind: cursor.bytesBehind,
        windowBytes: this.deps.windowBytes,
        previousDocument: cursor.state.previousDocument,
        vectorFields,
      }),
    )
    void this.pump()
  }

  private acknowledge(positions: readonly ChangePosition[]): void {
    const seqNos = seqNosByPartition(positions, this.sentSeqNos.length)
    if (seqNos === null) {
      this.close(CHANGES_CLOSE_POLICY, 'positions must name each partition once')
      return
    }
    for (let partitionId = 0; partitionId < seqNos.length; partitionId++) {
      if (seqNos[partitionId] > this.sentSeqNos[partitionId]) {
        this.close(CHANGES_CLOSE_POLICY, 'acknowledgement above a sent position')
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

  private settingAllows(cursor: ChangeCursor): boolean {
    const current = this.deps.source.changesState(this.deps.indexName)
    if (current === null) {
      this.close(CHANGES_CLOSE_RESYNC, 'change capture is off')
      return false
    }
    if (current.epoch !== cursor.state.epoch) {
      this.resync('epoch')
      return false
    }
    if (cursor.filtered && !current.previousDocument) {
      this.refuseFilterSetting()
      return false
    }
    return true
  }

  private async pump(): Promise<void> {
    const { cursor } = this
    if (cursor === null) return
    if (this.pumping) {
      this.pumpAgain = true
      return
    }
    this.pumping = true
    try {
      do {
        this.pumpAgain = false
        if (!this.settingAllows(cursor)) return
        await cursor.refreshHeads()
        await this.sendBehind(cursor)
      } while (this.pumpAgain && this.state === 'subscribed')
      this.scheduleRetryWhileUndurable(cursor)
    } catch (error) {
      this.fail(error)
    } finally {
      this.pumping = false
    }
  }

  private async sendBehind(cursor: ChangeCursor): Promise<void> {
    const { windowBytes } = this.deps
    let progressed = true
    while (progressed && this.state === 'subscribed') {
      progressed = false
      for (let partitionId = 0; partitionId < this.sentSeqNos.length; partitionId++) {
        if (this.state !== 'subscribed' || !cursor.behind(partitionId)) continue
        if (!this.windowAllows(1) || this.charged > 0) return
        const room = this.unackedBytes === 0 ? windowBytes : windowBytes - this.unackedBytes
        const batch = await cursor.readBatch(partitionId, Math.max(1, Math.min(room, ENTRIES_MESSAGE_LIMIT_BYTES)))
        if (this.state !== 'subscribed') return
        if (batch === 'history') return this.resync('history')
        if (batch === null) continue
        if (!this.settingAllows(cursor)) return
        progressed = true
        if (batch.changes.length === 0 && this.silentBytes[partitionId] + batch.scannedBytes < windowBytes) {
          this.silentBytes[partitionId] += batch.scannedBytes
          cursor.commit(batch)
          continue
        }
        const message = encodeChangesMessage(partitionId, batch.changes, batch.scannedSeqNo)
        if (!this.windowAllows(message.byteLength)) return
        if (!this.deps.buffered.take(message.byteLength)) return
        this.charged += message.byteLength
        this.unacked[partitionId].items.push({ seqNo: batch.scannedSeqNo, bytes: message.byteLength })
        this.unackedBytes += message.byteLength
        this.silentBytes[partitionId] = 0
        this.sentSeqNos[partitionId] = batch.scannedSeqNo
        cursor.commit(batch)
        this.send(message)
      }
    }
  }

  private scheduleRetryWhileUndurable(cursor: ChangeCursor): void {
    if (this.state !== 'subscribed' || this.retry !== null || !cursor.awaitsDurability()) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.advance()
    }, FEED_HEAD_RETRY_MS)
  }
}
