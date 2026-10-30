import { decode } from '@msgpack/msgpack'
import { createFrozenSegment, type FrozenSegment } from '../../../core/partition/frozen'
import type { SegmentSelection } from '../../../core/partition/frozen/merge'
import { buildSegmentPayload, type SegmentDocument } from '../../../core/partition/segment-builder'
import { restoreVectorFields } from '../../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { prepareDocumentVectors } from '../../../engine/vector-coordinator'
import { resolvePartitionInsertOptions } from '../../../partitioning/insert-options'
import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import type { SegmentWriteRecords } from '../../../serialization/keyword-segment/types'
import { decodeMapWithoutFields } from '../../../serialization/msgpack-without-fields'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig } from '../../../types/schema'

export interface BuildSegmentInput {
  indexName: string
  config: IndexConfig
  language: LanguageModule
  vectorFieldPaths: Set<string>
  entries: AsyncIterable<ReplicationLogEntry>
  keepsWriteRecords: boolean
}

export interface BuiltSegment {
  selections: SegmentSelection[]
  tombstones: string[]
  docCount: number
  writeRecords?: Map<FrozenSegment, SegmentWriteRecords>
}

function writeRecordsOf(
  documents: readonly SegmentDocument[],
  written: Map<string, ReplicationLogEntry>,
): SegmentWriteRecords {
  const seqNos = new Float64Array(documents.length)
  const primaryTerms = new Float64Array(documents.length)
  for (let at = 0; at < documents.length; at++) {
    const entry = written.get(documents[at].docId)
    if (entry === undefined) continue
    seqNos[at] = entry.seqNo
    primaryTerms[at] = entry.primaryTerm
  }
  return { seqNos, primaryTerms }
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
  const written = new Map<string, ReplicationLogEntry>()

  for await (const entry of input.entries) {
    if (entry.operation === 'DELETE') {
      deleted.add(entry.documentId)
      live.delete(entry.documentId)
      written.delete(entry.documentId)
      continue
    }
    if (entry.document === null) continue
    live.delete(entry.documentId)
    live.set(entry.documentId, documentWithoutVectors(entry.document, input.vectorFieldPaths, leavesVectorsUndecoded))
    if (input.keepsWriteRecords) written.set(entry.documentId, entry)
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
  const segment = createFrozenSegment(
    payload,
    documents.map(entry => entry.document),
  )
  const built: BuiltSegment = { selections: [{ segment }], tombstones, docCount: live.size }
  if (input.keepsWriteRecords) built.writeRecords = new Map([[segment, writeRecordsOf(documents, written)]])
  return built
}
