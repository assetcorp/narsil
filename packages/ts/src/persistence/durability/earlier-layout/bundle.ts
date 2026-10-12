import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { requireValidFieldTypes } from '../../../schema/validator/schema'
import { unpackEnvelopeBytes } from '../../../serialization/envelope'
import { deserializePayloadV2 } from '../../../serialization/payload-v2'
import { MIN_M } from '../../../vector/hnsw/constants'
import type { VectorIndexPayload } from '../../../vector/vector-index'
import { decodeVectorIndexParts } from '../../../vector/vector-index/payload'
import type { PartitionCheckpoint } from '../partition-checkpoint'
import type { EarlierLoadDeps } from './load'

const SNAPSHOT_BUNDLE_VERSION = 2

export interface SnapshotBundle {
  schema: Record<string, string>
  language: string
  partitions: Uint8Array[]
  vectorIndexes: Record<string, VectorIndexPayload[]>
  checkpoint: PartitionCheckpoint[]
}

interface RawSnapshotBundle {
  version?: unknown
  schema?: unknown
  language?: unknown
  partitions?: unknown
  vectorIndexes?: unknown
  checkpoint?: unknown
}

function invalid(message: string): never {
  throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Snapshot bundle ${message}`)
}

function vectorIndexesOf(raw: unknown): Record<string, VectorIndexPayload[]> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) invalid('vectorIndexes must be a map')
  const result: Record<string, VectorIndexPayload[]> = {}
  for (const [fieldPath, parts] of Object.entries(raw as Record<string, unknown>)) {
    result[fieldPath] = decodeVectorIndexParts(parts)
  }
  return result
}

function checkpointOf(raw: unknown): PartitionCheckpoint[] {
  if (!Array.isArray(raw)) return []
  const result: PartitionCheckpoint[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const { partitionId, lastSeqNo, primaryTerm } = entry as Record<string, unknown>
    if (typeof partitionId !== 'number' || typeof lastSeqNo !== 'number' || typeof primaryTerm !== 'number') continue
    result.push({ partitionId, lastSeqNo, primaryTerm })
  }
  return result
}

export async function decodeSnapshotBundle(data: Uint8Array): Promise<SnapshotBundle> {
  const { payloadBytes } = await unpackEnvelopeBytes(data)
  const raw = decode(payloadBytes) as RawSnapshotBundle
  if (raw.version !== SNAPSHOT_BUNDLE_VERSION) {
    throw new NarsilError(
      ErrorCodes.ENVELOPE_VERSION_MISMATCH,
      `The snapshot bundle holds layout ${String(raw.version)}, which this release cannot open. Export the index with the release that wrote it and import the export`,
      { version: raw.version },
    )
  }
  if (raw.schema === null || typeof raw.schema !== 'object' || Array.isArray(raw.schema)) invalid('missing schema')
  requireValidFieldTypes(raw.schema as Record<string, unknown>)
  if (typeof raw.language !== 'string') invalid('missing language')
  if (!Array.isArray(raw.partitions) || !raw.partitions.every(part => part instanceof Uint8Array)) {
    invalid('missing partitions')
  }
  return {
    schema: raw.schema as Record<string, string>,
    language: raw.language,
    partitions: raw.partitions,
    vectorIndexes: vectorIndexesOf(raw.vectorIndexes),
    checkpoint: checkpointOf(raw.checkpoint),
  }
}

export function countSnapshotBundleDocuments(bundle: SnapshotBundle): number {
  let total = 0
  for (const partitionBytes of bundle.partitions)
    total += Object.keys(deserializePayloadV2(partitionBytes).documents).length
  return total
}

export async function loadSnapshotBundle(bytes: Uint8Array, deps: EarlierLoadDeps): Promise<PartitionCheckpoint[]> {
  const bundle = await decodeSnapshotBundle(bytes)
  while (deps.manager.partitionCount < bundle.partitions.length) deps.manager.addPartition()
  if (bundle.partitions.length > 0) deps.manager.trimPartitions(bundle.partitions.length)
  for (let i = 0; i < bundle.partitions.length; i += 1) {
    deps.manager.deserializePartition(i, deserializePayloadV2(bundle.partitions[i]))
  }
  for (const [fieldPath, parts] of Object.entries(bundle.vectorIndexes)) {
    const rebuildsGraph = parts.some(part => part.graphs.some(graph => graph.m < MIN_M))
    deps.vectorIndexes.get(fieldPath)?.deserialize(rebuildsGraph ? parts.map(part => ({ ...part, graphs: [] })) : parts)
  }
  return bundle.checkpoint
}
