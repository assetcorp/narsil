import { ErrorCodes, NarsilError } from '#platform/storage-host'
import type { Semaphore } from '../sync/feed/limits'
import type { ChangePosition } from '../types/changes'
import { changeOfEntry, type DerivedChange, type DocumentTest, filteredChangeOfEntry, loggedEntryOf } from './derive'
import { seqNosByPartition } from './protocol'
import type { ChangeSource, ChangesIndexState } from './source'

export type ResyncReason = 'epoch' | 'history' | 'ahead'

export interface SubscriptionRequest {
  epoch?: string
  positions?: readonly ChangePosition[]
  filter?: unknown
}

export interface CursorBatch {
  partitionId: number
  changes: DerivedChange[]
  scannedSeqNo: number
  scannedBytes: number
}

export interface CursorDeps {
  source: ChangeSource
  indexName: string
  reads: Semaphore
}

export function changesNotEnabled(indexName: string): NarsilError {
  return new NarsilError(ErrorCodes.CHANGES_NOT_ENABLED, `Index "${indexName}" has change capture off`, { indexName })
}

export function previousDocumentRequired(indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.CHANGES_PREVIOUS_DOCUMENT_REQUIRED,
    `Index "${indexName}" has previousDocument off, so a subscription can hold no filter`,
    { indexName },
  )
}

export function invalidPositions(indexName: string, message: string): NarsilError {
  return new NarsilError(ErrorCodes.CHANGES_INVALID_POSITIONS, message, { indexName })
}

export class ChangeCursor {
  readonly subscribedSeqNos: readonly number[]
  readonly heads: number[]
  readonly scanned: number[]
  readonly bytesBehind: number

  private constructor(
    private readonly deps: CursorDeps,
    readonly state: ChangesIndexState,
    private readonly test: DocumentTest | null,
    seqNos: number[],
    heads: number[],
    bytesBehind: number,
  ) {
    this.subscribedSeqNos = [...seqNos]
    this.scanned = seqNos
    this.heads = heads
    this.bytesBehind = bytesBehind
  }

  static async open(deps: CursorDeps, request: SubscriptionRequest): Promise<ChangeCursor | ResyncReason> {
    const { source, indexName, reads } = deps
    const state = source.changesState(indexName)
    if (state === null) throw changesNotEnabled(indexName)
    const test = request.filter === undefined ? null : await source.documentTest(indexName, request.filter)
    if (test !== null && !state.previousDocument) throw previousDocumentRequired(indexName)
    let given: number[] | null = null
    if (request.epoch !== undefined || request.positions !== undefined) {
      if (request.epoch !== state.epoch) return 'epoch'
      given = seqNosByPartition(request.positions ?? [], state.partitionCount)
      if (given === null) {
        throw invalidPositions(indexName, 'The positions must hold each partition of the index once')
      }
    }
    const heads: number[] = []
    for (let partitionId = 0; partitionId < state.partitionCount; partitionId++) {
      const bounds = await reads.run(() => source.bounds(indexName, partitionId, 'current'))
      if (given !== null && given[partitionId] < bounds.oldestSeqNo - 1) return 'history'
      if (given !== null && given[partitionId] > bounds.highestSeqNo) return 'ahead'
      heads.push(bounds.head)
    }
    const seqNos = given ?? [...heads]
    const bytesBehind = await reads.run(() => source.bytesBehind(indexName, seqNos))
    if (source.changesState(indexName)?.epoch !== state.epoch) return 'epoch'
    return new ChangeCursor(deps, state, test, seqNos, heads, bytesBehind)
  }

  get filtered(): boolean {
    return this.test !== null
  }

  behind(partitionId: number): boolean {
    return this.scanned[partitionId] < this.heads[partitionId]
  }

  async refreshHeads(): Promise<void> {
    const { source, indexName } = this.deps
    for (let partitionId = 0; partitionId < this.heads.length; partitionId++) {
      const bounds = await source.bounds(indexName, partitionId)
      this.heads[partitionId] = Math.max(this.heads[partitionId], bounds.head)
    }
  }

  awaitsDurability(): boolean {
    const { source, indexName } = this.deps
    return this.heads.some((head, partitionId) => source.pendingBeyondHead(indexName, partitionId, head))
  }

  async readBatch(partitionId: number, maxBytes: number): Promise<CursorBatch | 'history' | null> {
    const { source, indexName, reads } = this.deps
    const after = this.scanned[partitionId]
    const upTo = this.heads[partitionId]
    if (after >= upTo) return null
    const read = await reads.run(() => source.read(indexName, partitionId, after, upTo, maxBytes))
    if (read.gone) return 'history'
    const changes: DerivedChange[] = []
    let scannedSeqNo = after
    let scannedBytes = 0
    for (const frame of read.frames) {
      if (frame.seqNo <= scannedSeqNo || frame.seqNo > upTo) continue
      const entry = loggedEntryOf(frame.payload, frame.seqNo)
      const change = this.test === null ? changeOfEntry(entry) : filteredChangeOfEntry(entry, this.test)
      if (change !== null) changes.push(change)
      scannedSeqNo = frame.seqNo
      scannedBytes += frame.payload.byteLength
    }
    if (scannedSeqNo === after) return null
    return { partitionId, changes, scannedSeqNo, scannedBytes }
  }

  commit(batch: CursorBatch): void {
    this.scanned[batch.partitionId] = Math.max(this.scanned[batch.partitionId], batch.scannedSeqNo)
  }
}
