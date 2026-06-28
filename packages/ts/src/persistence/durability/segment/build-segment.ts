import { applyDeleteEntry, applyIndexEntry } from '../../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { createPartitionManager, type PartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig } from '../../../types/schema'
import type { VectorIndex } from '../../../vector/vector-index'

export interface BuildSegmentInput {
  indexName: string
  config: IndexConfig
  language: LanguageModule
  vectorFieldPaths: Set<string>
  entries: ReplicationLogEntry[]
}

export interface BuiltSegment {
  payload: Uint8Array
  tombstones: string[]
  docCount: number
}

export function buildSegmentFromEntries(input: BuildSegmentInput): BuiltSegment | null {
  const router = createPartitionRouter()
  const vectorSink = new Map<string, VectorIndex>()
  const manager = createPartitionManager(input.indexName, input.config, input.language, router, 1, vectorSink)

  const deleted = new Set<string>()
  for (const entry of input.entries) {
    if (entry.operation === 'DELETE') {
      deleted.add(entry.documentId)
      applyDeleteEntry(entry, manager, vectorSink)
    } else {
      applyIndexEntry(entry, manager, input.vectorFieldPaths, vectorSink)
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
