import {
  decode,
  ErrorCodes,
  encode,
  NarsilError,
  openChecksummedEnvelope,
  packChecksummedEnvelope,
} from '#platform/storage-host'
import type { PartitionCheckpoint } from '../partition-checkpoint'
import { isRecord, isSequenceNumber, isUint32 } from '../segment/manifest-fields'
import type { CheckpointStore } from '../segment/store'

const LAYOUT_TRANSITION_VERSION = 1
const LAYOUT_TRANSITION_ENVELOPE_VERSION = 1

export interface LayoutTransition {
  version: typeof LAYOUT_TRANSITION_VERSION
  oldPartitionCount: number
  newPartitionCount: number
  oldHeads: PartitionCheckpoint[]
}

export function transitionKey(indexName: string): string {
  return `${indexName}/layout-transition`
}

export function invalidTransition(reason: string): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Partition layout transition ${reason}`)
}

function readPayload(raw: unknown): LayoutTransition {
  if (!isRecord(raw) || raw.version !== LAYOUT_TRANSITION_VERSION) invalidTransition('has an invalid version')
  const { oldPartitionCount, newPartitionCount, oldHeads } = raw
  if (
    !isUint32(oldPartitionCount) ||
    oldPartitionCount === 0 ||
    !isUint32(newPartitionCount) ||
    newPartitionCount === 0 ||
    newPartitionCount === oldPartitionCount
  )
    invalidTransition('has invalid partition counts')
  if (!Array.isArray(oldHeads) || oldHeads.length !== oldPartitionCount)
    invalidTransition('has an incomplete old head list')
  const heads = oldHeads.map((head: unknown, partitionId): PartitionCheckpoint => {
    if (
      !isRecord(head) ||
      head.partitionId !== partitionId ||
      !isSequenceNumber(head.lastSeqNo) ||
      !isSequenceNumber(head.primaryTerm)
    )
      invalidTransition('has an invalid old head')
    return { partitionId, lastSeqNo: head.lastSeqNo, primaryTerm: head.primaryTerm }
  })
  return { version: LAYOUT_TRANSITION_VERSION, oldPartitionCount, newPartitionCount, oldHeads: heads }
}

export async function readTransition(store: CheckpointStore, indexName: string): Promise<LayoutTransition | null> {
  const bytes = await store.read(transitionKey(indexName))
  if (bytes === null) return null
  const { payload } = await openChecksummedEnvelope(bytes, {
    envelopeFormatVersion: LAYOUT_TRANSITION_ENVELOPE_VERSION,
    what: 'partition layout transition',
    allowsCompression: false,
  })
  let raw: unknown
  try {
    raw = decode(payload)
  } catch {
    invalidTransition('has an invalid MessagePack payload')
  }
  return readPayload(raw)
}

export async function writeTransition(
  store: CheckpointStore,
  indexName: string,
  transition: LayoutTransition,
): Promise<void> {
  const packed = await packChecksummedEnvelope(
    [encode(transition)],
    LAYOUT_TRANSITION_ENVELOPE_VERSION,
    'partition layout transition',
  )
  try {
    await store.write(transitionKey(indexName), packed.chunks)
  } catch (error) {
    if (error instanceof NarsilError) throw error
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'Failed to persist the partition layout transition', {
      indexName,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}
