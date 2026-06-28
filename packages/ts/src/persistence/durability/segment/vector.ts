import { decode, encode } from '@msgpack/msgpack'
import { applyDeleteEntry, applyIndexEntry } from '../../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { packSnapshotEnvelopeParts, unpackEnvelopeBytes } from '../../../serialization/envelope'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig } from '../../../types/schema'
import { createVectorIndex, type VectorIndex, type VectorIndexPayload } from '../../../vector/vector-index'
import type { DurableDirectory } from '../durable-filesystem'
import { vectorSegmentKey } from './layout'
import type { VectorSegmentRef } from './manifest'

export interface VectorWriteInput {
  directory: DurableDirectory
  indexName: string
  partitionId: number
  config: IndexConfig
  language: LanguageModule
  vectorFields: Map<string, number>
  vectorFieldPaths: Set<string>
  entries: ReplicationLogEntry[]
  priorVectors: VectorSegmentRef[]
}

export async function writePartitionVectors(input: VectorWriteInput): Promise<VectorSegmentRef[]> {
  if (input.vectorFields.size === 0) {
    return []
  }
  if (input.entries.length === 0) {
    return input.priorVectors
  }

  const priorByField = new Map<string, VectorSegmentRef>()
  for (const ref of input.priorVectors) {
    priorByField.set(ref.fieldPath, ref)
  }

  const vectorIndexes = new Map<string, VectorIndex>()
  for (const [fieldPath, dimension] of input.vectorFields) {
    vectorIndexes.set(fieldPath, createVectorIndex(fieldPath, dimension, input.config.vectorPromotion))
  }

  const router = createPartitionRouter()
  const manager = createPartitionManager(input.indexName, input.config, input.language, router, 1, vectorIndexes)

  for (const ref of input.priorVectors) {
    const vecIndex = vectorIndexes.get(ref.fieldPath)
    if (vecIndex === undefined) {
      continue
    }
    const bytes = await input.directory.read(ref.key)
    if (bytes !== null) {
      const { payloadBytes } = await unpackEnvelopeBytes(bytes)
      vecIndex.deserialize(decode(payloadBytes) as VectorIndexPayload)
    }
  }

  for (const entry of input.entries) {
    if (entry.operation === 'DELETE') {
      applyDeleteEntry(entry, manager, vectorIndexes)
    } else {
      applyIndexEntry(entry, manager, input.vectorFieldPaths, vectorIndexes)
    }
  }

  const result: VectorSegmentRef[] = []
  for (const [fieldPath, vecIndex] of vectorIndexes) {
    const generation = (priorByField.get(fieldPath)?.generation ?? 0) + 1
    const key = vectorSegmentKey(input.indexName, input.partitionId, fieldPath, generation)
    const parts = await packSnapshotEnvelopeParts(encode(vecIndex.serialize()))
    await input.directory.atomicWrite(key, [parts.header, parts.payload])
    result.push({ fieldPath, generation, key })
  }
  return result
}
