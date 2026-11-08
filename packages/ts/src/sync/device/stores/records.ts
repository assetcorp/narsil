import { encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { decode } from '../../../serialization/msgpack'
import type { AnyDocument } from '../../../types/schema'
import { isSyncEpoch } from '../../epoch'
import type { DevicePosition, KeptEntry, QueuedWrite } from '../types'

export type QueueRecord =
  | { type: 'write'; write: QueuedWrite }
  | { type: 'removed'; sequences: number[] }
  | { type: 'next'; sequence: number }

function damaged(detail: string): NarsilError {
  return new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The device sync store is damaged: ${detail}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function encodeQueueRecord(record: QueueRecord): Uint8Array {
  return encode(record, { ignoreUndefined: true })
}

export function decodeQueueRecord(bytes: Uint8Array): QueueRecord {
  const raw = decode(bytes)
  if (!isRecord(raw)) throw damaged('a queue record is not a map')
  if (raw.type === 'next' && isCount(raw.sequence)) return { type: 'next', sequence: raw.sequence }
  if (raw.type === 'removed' && Array.isArray(raw.sequences) && raw.sequences.every(isCount)) {
    return { type: 'removed', sequences: raw.sequences as number[] }
  }
  if (raw.type === 'write' && isRecord(raw.write)) {
    const write = raw.write
    if (isCount(write.sequence) && typeof write.documentId === 'string') {
      if (write.document === null || write.document === undefined) {
        return { type: 'write', write: { sequence: write.sequence, documentId: write.documentId, document: null } }
      }
      if (isRecord(write.document)) {
        const document = write.document as AnyDocument
        return { type: 'write', write: { sequence: write.sequence, documentId: write.documentId, document } }
      }
    }
  }
  throw damaged('a queue record is invalid')
}

export function encodeKeptEntries(entries: readonly KeptEntry[]): Uint8Array {
  return encode(entries.map(entry => [entry.partitionId, entry.seqNo, entry.documentId, entry.document]))
}

export function decodeKeptEntries(bytes: Uint8Array): KeptEntry[] {
  const raw = decode(bytes)
  if (!Array.isArray(raw)) throw damaged('a kept entry batch is not a list')
  return (raw as unknown[]).map(item => {
    if (!Array.isArray(item) || item.length !== 4) throw damaged('a kept entry is invalid')
    const [partitionId, seqNo, documentId, document] = item as unknown[]
    if (!isCount(partitionId) || !isCount(seqNo) || typeof documentId !== 'string') {
      throw damaged('a kept entry is invalid')
    }
    if (document !== null && !(document instanceof Uint8Array)) throw damaged('a kept entry is invalid')
    return { partitionId, seqNo, documentId, document }
  })
}

export function encodePosition(position: DevicePosition): Uint8Array {
  return encode({ epoch: position.epoch, seqNos: position.seqNos })
}

export function decodePosition(bytes: Uint8Array): DevicePosition {
  const raw = decode(bytes)
  if (!isRecord(raw) || !isSyncEpoch(raw.epoch) || !Array.isArray(raw.seqNos) || !raw.seqNos.every(isCount)) {
    throw damaged('the saved position is invalid')
  }
  return { epoch: raw.epoch, seqNos: raw.seqNos as number[] }
}

export function encodeDownloadTag(entityTag: string): Uint8Array {
  return encode({ entityTag })
}

export function decodeDownloadTag(bytes: Uint8Array): string {
  const raw = decode(bytes)
  if (!isRecord(raw) || typeof raw.entityTag !== 'string') throw damaged('the saved download is invalid')
  return raw.entityTag
}

export function downloadOutOfOrder(entityTag: string, offset: number, saved: number): NarsilError {
  return new NarsilError(
    ErrorCodes.PERSISTENCE_SAVE_FAILED,
    `The device sync store holds ${saved} bytes of the download, so the next bytes must start at ${saved} or at 0`,
    { entityTag, offset, saved },
  )
}

export interface LiveQueue {
  writes: Map<number, QueuedWrite>
  recordBytes: Map<number, number>
  nextSequence: number
}

export function replayQueue(payloads: readonly Uint8Array[]): LiveQueue {
  const writes = new Map<number, QueuedWrite>()
  const recordBytes = new Map<number, number>()
  let nextSequence = 1
  for (const payload of payloads) {
    const record = decodeQueueRecord(payload)
    if (record.type === 'next') {
      nextSequence = Math.max(nextSequence, record.sequence)
    } else if (record.type === 'removed') {
      for (const sequence of record.sequences) {
        writes.delete(sequence)
        recordBytes.delete(sequence)
      }
    } else {
      writes.set(record.write.sequence, record.write)
      recordBytes.set(record.write.sequence, payload.byteLength)
      nextSequence = Math.max(nextSequence, record.write.sequence + 1)
    }
  }
  return { writes, recordBytes, nextSequence }
}
