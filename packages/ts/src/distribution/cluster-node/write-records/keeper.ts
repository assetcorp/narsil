import type { FrozenSegment } from '../../../core/partition/frozen'
import type { PartitionCheckpoint } from '../../../persistence/durability/partition-checkpoint'
import type { TermStart, WriteRecordKeeper } from '../../../persistence/durability/types'
import type { KeywordSegmentContents, SegmentWriteRecords } from '../../../serialization/keyword-segment/types'
import type { ReplicationLogEntry } from '../../replication/types'
import { createWriteRecordTable, type WriteRecord, type WriteRecordTable } from './table'
import { createTermHistory, type TermHistory } from './term-history'

export interface PartitionWriteRecords {
  readonly table: WriteRecordTable
  readonly history: TermHistory
  pagedSegments: readonly FrozenSegment[]
}

export interface ClusterWriteRecords extends WriteRecordKeeper {
  readRetainedLogWith(oldestRetainedSeqNo: OldestRetainedSeqNo): void
  applied(entry: ReplicationLogEntry): void
  recordOf(indexName: string, partitionId: number, documentId: string): WriteRecord | null
  partition(indexName: string, partitionId: number): PartitionWriteRecords
  heldEntry(indexName: string, partitionId: number, seqNo: number, primaryTerm: number): HeldEntry
}

export type HeldEntry = 'held' | 'absent' | 'uncovered'

export type OldestRetainedSeqNo = (indexName: string, partitionId: number) => number | undefined

export function createClusterWriteRecords(): ClusterWriteRecords {
  const indexes = new Map<string, Map<number, PartitionWriteRecords>>()
  let oldestRetainedSeqNo: OldestRetainedSeqNo = () => undefined

  function partition(indexName: string, partitionId: number): PartitionWriteRecords {
    let partitions = indexes.get(indexName)
    if (partitions === undefined) {
      partitions = new Map()
      indexes.set(indexName, partitions)
    }
    let held = partitions.get(partitionId)
    if (held === undefined) {
      held = { table: createWriteRecordTable(), history: createTermHistory(), pagedSegments: [] }
      partitions.set(partitionId, held)
    }
    return held
  }

  function applied(entry: ReplicationLogEntry): void {
    const held = partition(entry.indexName, entry.partitionId)
    if (entry.operation === 'INDEX') held.table.set(entry.documentId, entry.seqNo, entry.primaryTerm)
    else held.table.remove(entry.documentId)
    held.history.noteEntry(entry.seqNo, entry.primaryTerm)
  }

  function recordOfDocument(indexName: string, partitionId: number, documentId: string): WriteRecord | null {
    const held = indexes.get(indexName)?.get(partitionId)
    if (held === undefined) return null
    const record = held.table.recordOf(documentId)
    if (record !== null) return record
    for (let at = held.pagedSegments.length - 1; at >= 0; at--) {
      const segment = held.pagedSegments[at]
      if (!segment.hasDocument(documentId) || segment.paged === null) continue
      const stored = segment.paged.writeRecordAt(segment.arrays.idTable.ordinalOf(documentId))
      return stored.seqNo === 0 ? null : stored
    }
    return null
  }

  function captureSegment(indexName: string, partitionId: number, segment: FrozenSegment): SegmentWriteRecords {
    const count = segment.arrays.documentCount
    const seqNos = new Float64Array(count)
    const primaryTerms = new Float64Array(count)
    for (let ordinal = 0; ordinal < count; ordinal++) {
      if (segment.isTombstoned(ordinal)) continue
      const record = recordOfDocument(indexName, partitionId, segment.arrays.idTable.idAt(ordinal))
      if (record === null) continue
      seqNos[ordinal] = record.seqNo
      primaryTerms[ordinal] = record.primaryTerm
    }
    return { seqNos, primaryTerms }
  }

  return {
    readRetainedLogWith(read) {
      oldestRetainedSeqNo = read
    },
    applied,
    replayed: applied,
    partition,

    recordOf: recordOfDocument,

    heldEntry(indexName, partitionId, seqNo, primaryTerm) {
      const history = indexes.get(indexName)?.get(partitionId)?.history
      if (history === undefined) return 'uncovered'
      if (seqNo > history.highestSeqNo) return 'absent'
      const term = history.termOf(seqNo)
      if (term === null) return 'uncovered'
      return term === primaryTerm ? 'held' : 'absent'
    },

    resetPartition(indexName, partitionId) {
      const held = indexes.get(indexName)?.get(partitionId)
      if (held === undefined) return
      held.table.clear()
      held.history.clear()
      held.pagedSegments = []
    },

    loadPagedSegment(indexName, partitionId, segment: FrozenSegment) {
      const held = partition(indexName, partitionId)
      for (const documentId of segment.paged?.snapshot.tombstones ?? []) held.table.remove(documentId)
      held.pagedSegments = [...held.pagedSegments, segment]
    },

    adoptPagedSegments(indexName, partitionId, segments, changed) {
      const held = partition(indexName, partitionId)
      const kept: Array<[string, WriteRecord]> = []
      for (const documentId of changed) {
        const record = held.table.recordOf(documentId)
        if (record !== null) kept.push([documentId, record])
      }
      held.table.clear()
      for (const [documentId, record] of kept) held.table.set(documentId, record.seqNo, record.primaryTerm)
      held.pagedSegments = segments
    },

    loadSegment(indexName, partitionId, segment: FrozenSegment, contents: KeywordSegmentContents) {
      const { table } = partition(indexName, partitionId)
      for (const documentId of contents.tombstones) table.remove(documentId)
      const records = contents.writeRecords
      for (let ordinal = 0; ordinal < segment.arrays.documentCount; ordinal++) {
        const documentId = segment.arrays.idTable.idAt(ordinal)
        const seqNo = records?.seqNos[ordinal] ?? 0
        if (seqNo === 0 || records === undefined) table.remove(documentId)
        else table.set(documentId, seqNo, records.primaryTerms[ordinal])
      }
    },

    captureSegments(indexName, partitionId, segments) {
      const captured = new Map<FrozenSegment, SegmentWriteRecords>()
      if (indexes.get(indexName)?.get(partitionId) === undefined) return captured
      for (const segment of segments) {
        if (segment.paged === null) captured.set(segment, captureSegment(indexName, partitionId, segment))
      }
      return captured
    },

    termHistoryOf(indexName, partitionId, lastSeqNo): TermStart[] {
      const history = indexes.get(indexName)?.get(partitionId)?.history
      if (history === undefined) return []
      const oldest = oldestRetainedSeqNo(indexName, partitionId)
      if (oldest !== undefined) history.prune(Math.min(oldest, lastSeqNo))
      return history.starts(lastSeqNo)
    },

    loadTermHistory(indexName, partitionId, checkpoint: PartitionCheckpoint | undefined) {
      partition(indexName, partitionId).history.replace(checkpoint?.termHistory ?? [], checkpoint?.lastSeqNo ?? 0)
    },

    dropIndex(indexName) {
      indexes.delete(indexName)
    },
  }
}
