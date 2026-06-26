import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import { type EnvelopeParts, packSnapshotEnvelopeParts, unpackEnvelopeBytes } from '../../serialization/envelope'
import type { VectorIndexPayload } from '../../vector/vector-index'

export interface PartitionCheckpoint {
  partitionId: number
  lastSeqNo: number
  primaryTerm: number
}

export interface SnapshotBundle {
  version: 2
  schema: Record<string, string>
  language: string
  partitions: Uint8Array[]
  vectorIndexes: Record<string, VectorIndexPayload>
  checkpoint: PartitionCheckpoint[]
}

interface RawSnapshotBundle {
  version?: number
  schema?: Record<string, string>
  language?: string
  partitions?: Uint8Array[]
  vectorIndexes?: Record<string, VectorIndexPayload>
  checkpoint?: Array<{ partitionId?: number; lastSeqNo?: number; primaryTerm?: number }>
}

export async function encodeSnapshotBundle(bundle: SnapshotBundle): Promise<EnvelopeParts> {
  const payload = encode({
    version: 2,
    schema: bundle.schema,
    language: bundle.language,
    partitions: bundle.partitions,
    vectorIndexes: bundle.vectorIndexes,
    checkpoint: bundle.checkpoint.map(c => ({
      partitionId: c.partitionId,
      lastSeqNo: c.lastSeqNo,
      primaryTerm: c.primaryTerm,
    })),
  })
  return packSnapshotEnvelopeParts(payload)
}

export async function decodeSnapshotBundle(data: Uint8Array): Promise<SnapshotBundle> {
  const { payloadBytes } = await unpackEnvelopeBytes(data)
  const raw = decode(payloadBytes) as RawSnapshotBundle

  if (raw.version !== 2) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Unsupported snapshot bundle version ${raw.version}; expected 2`,
      { version: raw.version },
    )
  }
  if (!raw.schema || typeof raw.schema !== 'object') {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Snapshot bundle missing schema')
  }
  if (typeof raw.language !== 'string') {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Snapshot bundle missing language')
  }
  if (!Array.isArray(raw.partitions)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Snapshot bundle missing partitions')
  }

  return {
    version: 2,
    schema: raw.schema,
    language: raw.language,
    partitions: raw.partitions,
    vectorIndexes: raw.vectorIndexes ?? {},
    checkpoint: normalizeCheckpoint(raw.checkpoint),
  }
}

function normalizeCheckpoint(raw: RawSnapshotBundle['checkpoint']): PartitionCheckpoint[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const result: PartitionCheckpoint[] = []
  for (const entry of raw) {
    if (
      typeof entry?.partitionId !== 'number' ||
      typeof entry.lastSeqNo !== 'number' ||
      typeof entry.primaryTerm !== 'number'
    ) {
      continue
    }
    result.push({ partitionId: entry.partitionId, lastSeqNo: entry.lastSeqNo, primaryTerm: entry.primaryTerm })
  }
  return result
}

export function checkpointLastSeqNo(checkpoint: PartitionCheckpoint[], partitionId: number): number {
  for (const c of checkpoint) {
    if (c.partitionId === partitionId) {
      return c.lastSeqNo
    }
  }
  return 0
}

export function checkpointPrimaryTerm(checkpoint: PartitionCheckpoint[], partitionId: number): number {
  for (const c of checkpoint) {
    if (c.partitionId === partitionId) {
      return c.primaryTerm
    }
  }
  return 0
}
