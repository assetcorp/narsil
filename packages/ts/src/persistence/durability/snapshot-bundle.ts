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
  version: 1
  schema: Record<string, string>
  language: string
  analysisRevision?: string
  tokenizer?: string
  stopWords?: string
  stopWordList?: string[]
  partitions: Uint8Array[]
  vectorIndexes: Record<string, VectorIndexPayload>
  checkpoint: PartitionCheckpoint[]
}

interface RawSnapshotBundle {
  version?: number
  schema?: Record<string, string>
  language?: string
  analysis_revision?: unknown
  tokenizer?: unknown
  stop_words?: unknown
  stop_word_list?: unknown
  partitions?: Uint8Array[]
  vectorIndexes?: Record<string, VectorIndexPayload>
  checkpoint?: Array<{ partitionId?: number; lastSeqNo?: number; primaryTerm?: number }>
}

export async function encodeSnapshotBundle(bundle: SnapshotBundle): Promise<EnvelopeParts> {
  const payload = encode({
    version: 1,
    schema: bundle.schema,
    language: bundle.language,
    ...(bundle.analysisRevision !== undefined ? { analysis_revision: bundle.analysisRevision } : {}),
    ...(bundle.tokenizer !== undefined ? { tokenizer: bundle.tokenizer } : {}),
    ...(bundle.stopWords !== undefined ? { stop_words: bundle.stopWords } : {}),
    ...(bundle.stopWordList !== undefined ? { stop_word_list: bundle.stopWordList } : {}),
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

  if (raw.version !== 1) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Unsupported snapshot bundle version ${raw.version}; expected 1`,
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
  if (raw.analysis_revision !== undefined && typeof raw.analysis_revision !== 'string') {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Snapshot bundle analysis_revision must be a revision')
  }
  if (raw.tokenizer !== undefined && typeof raw.tokenizer !== 'string') {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Snapshot bundle tokenizer must be a name')
  }
  if (raw.stop_words !== undefined && typeof raw.stop_words !== 'string') {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Snapshot bundle stop_words must be a name')
  }
  const stopWordList = normalizeStopWordList(raw.stop_word_list)

  return {
    version: 1,
    schema: raw.schema,
    language: raw.language,
    ...(typeof raw.analysis_revision === 'string' ? { analysisRevision: raw.analysis_revision } : {}),
    ...(typeof raw.tokenizer === 'string' ? { tokenizer: raw.tokenizer } : {}),
    ...(typeof raw.stop_words === 'string' ? { stopWords: raw.stop_words } : {}),
    ...(stopWordList !== undefined ? { stopWordList } : {}),
    partitions: raw.partitions,
    vectorIndexes: raw.vectorIndexes ?? {},
    checkpoint: normalizeCheckpoint(raw.checkpoint),
  }
}

function normalizeStopWordList(raw: unknown): string[] | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!Array.isArray(raw) || !raw.every(word => typeof word === 'string')) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Snapshot bundle stop_word_list must be a list of words')
  }
  return raw
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
