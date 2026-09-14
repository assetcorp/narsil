import { decode, encode } from '@msgpack/msgpack'
import { restoreVectorFields } from '../../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { extractVectorFromDoc, insertDocumentVectors, removeDocumentVectors } from '../../../engine/vector-coordinator'
import { ErrorCodes, NarsilError } from '../../../errors'
import { packSnapshotEnvelopePartsRetrying, unpackEnvelopeBytes } from '../../../serialization/envelope'
import { HEADER_SIZE } from '../../../serialization/header'
import type { IndexConfig } from '../../../types/schema'
import {
  createVectorIndex,
  type VectorIndex,
  type VectorIndexPayload,
  type VectorPartFile,
} from '../../../vector/vector-index'
import { decodeVectorIndexPart } from '../../../vector/vector-index/payload'
import type { DurableDirectory } from '../durable-filesystem'
import { vectorSegmentKey } from './layout'
import type { VectorSegmentRef } from './manifest'

export interface VectorWriteInput {
  directory: DurableDirectory
  indexName: string
  partitionId: number
  config: IndexConfig
  vectorFields: Map<string, number>
  vectorFieldPaths: Set<string>
  entries: ReplicationLogEntry[]
  priorVectors: VectorSegmentRef[]
}

export interface VectorCheckpointLayout {
  fieldPath: string
  key: string
  docIds: string[]
  vectorsOffset: number
}

export interface VectorWriteOutcome {
  refs: VectorSegmentRef[]
  layouts: VectorCheckpointLayout[]
}

export interface VectorPartsRead {
  parts: VectorIndexPayload[]
  files: VectorPartFile[]
}

function vectorsOffsetOf(payloadLength: number, part: VectorIndexPayload): number {
  return HEADER_SIZE + payloadLength - part.docIds.length * part.dimension * 4
}

export async function readVectorParts(directory: DurableDirectory, keys: readonly string[]): Promise<VectorPartsRead> {
  const parts: VectorIndexPayload[] = []
  const files: VectorPartFile[] = []
  for (const key of keys) {
    const bytes = await directory.read(key)
    if (bytes === null) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `The vector part "${key}" is missing`, { key })
    }
    const { header, payloadBytes } = await unpackEnvelopeBytes(bytes)
    const part = decodeVectorIndexPart(decode(payloadBytes))
    parts.push(part)
    files.push({ path: await directory.pathOf(key), vectorsOffset: vectorsOffsetOf(header.payloadLength, part) })
  }
  return { parts, files }
}

export async function writePartitionVectors(input: VectorWriteInput): Promise<VectorWriteOutcome> {
  if (input.vectorFields.size === 0) {
    return { refs: [], layouts: [] }
  }
  if (input.entries.length === 0) {
    return { refs: input.priorVectors, layouts: [] }
  }

  const priorByField = new Map<string, VectorSegmentRef>()
  for (const ref of input.priorVectors) {
    priorByField.set(ref.fieldPath, ref)
  }

  const vectorIndexes = new Map<string, VectorIndex>()
  for (const [fieldPath, dimension] of input.vectorFields) {
    vectorIndexes.set(
      fieldPath,
      createVectorIndex(
        fieldPath,
        dimension,
        input.config.vectorPromotion,
        { enabled: false },
        input.indexName,
        'disk',
      ),
    )
  }

  try {
    for (const ref of input.priorVectors) {
      const vecIndex = vectorIndexes.get(ref.fieldPath)
      if (vecIndex === undefined) {
        continue
      }
      const { parts, files } = await readVectorParts(input.directory, ref.keys)
      vecIndex.deserialize(parts, files)
    }

    for (const entry of input.entries) {
      applyEntryVectors(entry, input.vectorFieldPaths, vectorIndexes)
    }

    const refs: VectorSegmentRef[] = []
    const layouts: VectorCheckpointLayout[] = []
    for (const [fieldPath, vecIndex] of vectorIndexes) {
      await vecIndex.completeGraph()
      const generation = (priorByField.get(fieldPath)?.generation ?? 0) + 1
      const keys: string[] = []
      for (const part of vecIndex.serialize()) {
        const key = vectorSegmentKey(input.indexName, input.partitionId, fieldPath, generation, part.part)
        const envelope = await packSnapshotEnvelopePartsRetrying(() => encode(part))
        await input.directory.atomicWrite(key, [envelope.header, envelope.payload])
        keys.push(key)
        layouts.push({
          fieldPath,
          key,
          docIds: part.docIds,
          vectorsOffset: vectorsOffsetOf(envelope.payload.length, part),
        })
      }
      refs.push({ fieldPath, generation, keys })
    }
    return { refs, layouts }
  } finally {
    for (const vecIndex of vectorIndexes.values()) vecIndex.dispose()
  }
}

function applyEntryVectors(
  entry: ReplicationLogEntry,
  vectorFieldPaths: Set<string>,
  vectorIndexes: Map<string, VectorIndex>,
): void {
  if (entry.operation === 'DELETE') {
    removeDocumentVectors(entry.documentId, vectorIndexes)
    return
  }
  if (entry.document === null) {
    return
  }

  const document = decode(entry.document) as Record<string, unknown>
  restoreVectorFields(document, vectorFieldPaths)

  const vectors = new Map<string, Float32Array>()
  for (const fieldPath of vectorFieldPaths) {
    const vector = extractVectorFromDoc(document, fieldPath)
    if (vector !== null) {
      vectors.set(fieldPath, vector)
    }
  }

  removeDocumentVectors(entry.documentId, vectorIndexes)
  insertDocumentVectors(entry.documentId, vectors, vectorIndexes, entry.partitionId)
}
