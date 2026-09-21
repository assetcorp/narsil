import { decode } from '@msgpack/msgpack'
import { buildSegmentPayload, type SegmentDocument } from '../../../core/partition/segment-builder'
import { restoreVectorFields } from '../../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { prepareDocumentVectors } from '../../../engine/vector-coordinator'
import { resolvePartitionInsertOptions } from '../../../partitioning/insert-options'
import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { decodeMapWithoutFields } from '../../../serialization/msgpack-without-fields'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig } from '../../../types/schema'

export interface BuildSegmentInput {
  indexName: string
  config: IndexConfig
  language: LanguageModule
  vectorFieldPaths: Set<string>
  entries: AsyncIterable<ReplicationLogEntry>
}

export interface BuiltSegment {
  payload: Uint8Array
  tombstones: string[]
  docCount: number
}

function everyVectorFieldIsTopLevel(vectorFieldPaths: ReadonlySet<string>): boolean {
  for (const fieldPath of vectorFieldPaths) {
    if (fieldPath.includes('.')) return false
  }
  return vectorFieldPaths.size > 0
}

function documentWithoutVectors(
  encoded: Uint8Array,
  vectorFieldPaths: Set<string>,
  leavesVectorsUndecoded: boolean,
): Record<string, unknown> {
  const skipped = leavesVectorsUndecoded ? decodeMapWithoutFields(encoded, vectorFieldPaths) : null
  if (skipped !== null) return skipped
  const document = decode(encoded) as Record<string, unknown>
  restoreVectorFields(document, vectorFieldPaths)
  return prepareDocumentVectors(document, vectorFieldPaths).partitionDoc
}

export async function buildSegmentFromEntries(input: BuildSegmentInput): Promise<BuiltSegment | null> {
  const leavesVectorsUndecoded = everyVectorFieldIsTopLevel(input.vectorFieldPaths)
  const live = new Map<string, Record<string, unknown>>()
  const deleted = new Set<string>()

  for await (const entry of input.entries) {
    if (entry.operation === 'DELETE') {
      deleted.add(entry.documentId)
      live.delete(entry.documentId)
      continue
    }
    if (entry.document === null) continue
    live.delete(entry.documentId)
    live.set(entry.documentId, documentWithoutVectors(entry.document, input.vectorFieldPaths, leavesVectorsUndecoded))
  }

  const tombstones: string[] = []
  for (const docId of deleted) {
    if (!live.has(docId)) tombstones.push(docId)
  }
  if (live.size === 0 && tombstones.length === 0) {
    return null
  }

  const documents: SegmentDocument[] = []
  for (const [docId, document] of live) documents.push({ docId, document })

  const manager = createPartitionManager(input.indexName, input.config, input.language, createPartitionRouter(), 1)
  const payload = buildSegmentPayload(
    documents,
    input.config.schema,
    input.language,
    resolvePartitionInsertOptions(input.config, manager.analysis),
    input.config.trackPositions ?? true,
  )
  manager.mergeSegment(
    0,
    payload,
    documents.map(entry => entry.document),
  )

  return {
    payload: manager.serializePartitionToBytes(0),
    tombstones,
    docCount: live.size,
  }
}
