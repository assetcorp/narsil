import { applyDeleteEntry, applyIndexEntry, applyIndexedDocument } from '../../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { createPartitionManager, type PartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { decodeMapWithoutFields } from '../../../serialization/msgpack-without-fields'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig } from '../../../types/schema'
import type { VectorIndex } from '../../../vector/vector-index'

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

export async function buildSegmentFromEntries(input: BuildSegmentInput): Promise<BuiltSegment | null> {
  const router = createPartitionRouter()
  const vectorSink = new Map<string, VectorIndex>()
  const manager = createPartitionManager(input.indexName, input.config, input.language, router, 1, vectorSink)
  const leavesVectorsUndecoded = everyVectorFieldIsTopLevel(input.vectorFieldPaths)

  const deleted = new Set<string>()
  for await (const entry of input.entries) {
    if (entry.operation === 'DELETE') {
      deleted.add(entry.documentId)
      applyDeleteEntry(entry, manager, vectorSink)
      continue
    }
    const document =
      leavesVectorsUndecoded && entry.document !== null
        ? decodeMapWithoutFields(entry.document, input.vectorFieldPaths)
        : null
    if (document === null) {
      applyIndexEntry(entry, manager, input.vectorFieldPaths, vectorSink)
    } else {
      applyIndexedDocument(entry.documentId, document, manager, input.vectorFieldPaths, vectorSink)
    }
  }

  const liveDocIds = collectLiveDocIds(manager)
  const tombstones: string[] = []
  for (const docId of deleted) {
    if (!liveDocIds.has(docId)) {
      tombstones.push(docId)
    }
  }

  if (liveDocIds.size === 0 && tombstones.length === 0) {
    return null
  }

  return {
    payload: manager.serializePartitionToBytes(0),
    tombstones,
    docCount: liveDocIds.size,
  }
}

function collectLiveDocIds(manager: PartitionManager): Set<string> {
  return new Set<string>(manager.getPartition(0).docIds())
}
