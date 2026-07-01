import { ErrorCodes, NarsilError } from '../../errors'
import { computeEntryChecksum } from './entry-checksum'
import {
  DEFAULT_LOG_RETENTION_BYTES,
  type ReplicationConfig,
  type ReplicationLog,
  type ReplicationLogEntry,
} from './types'

const ENTRY_FIXED_OVERHEAD_BYTES = 40

function estimateEntrySize(entry: ReplicationLogEntry): number {
  return (
    ENTRY_FIXED_OVERHEAD_BYTES + entry.indexName.length + entry.documentId.length + (entry.document?.byteLength ?? 0)
  )
}

const computeChecksum = computeEntryChecksum

export function createReplicationLog(
  partitionId: number,
  config?: Partial<ReplicationConfig & { startSeqNo: number; lastPrimaryTerm: number }>,
): ReplicationLog {
  const retentionBytes = config?.logRetentionBytes ?? DEFAULT_LOG_RETENTION_BYTES
  let nextSeqNo = config?.startSeqNo ?? 1
  let committedSeqNo = nextSeqNo - 1
  let committedPrimaryTerm = config?.lastPrimaryTerm ?? 0
  let entries: ReplicationLogEntry[] = []
  let headIndex = 0
  let totalSizeBytes = 0

  function liveCount(): number {
    return entries.length - headIndex
  }

  function compact(): void {
    if (headIndex > 0) {
      entries = entries.slice(headIndex)
      headIndex = 0
    }
  }

  function findIndexBySeqNo(seqNo: number): number {
    let low = headIndex
    let high = entries.length - 1
    while (low <= high) {
      const mid = (low + high) >>> 1
      const midSeqNo = entries[mid].seqNo
      if (midSeqNo < seqNo) {
        low = mid + 1
      } else if (midSeqNo > seqNo) {
        high = mid - 1
      } else {
        return mid
      }
    }
    return low
  }

  function evictOldEntries(): void {
    while (liveCount() > 0 && totalSizeBytes > retentionBytes) {
      totalSizeBytes -= estimateEntrySize(entries[headIndex])
      entries[headIndex] = null as unknown as ReplicationLogEntry
      headIndex += 1
    }
    if (totalSizeBytes < 0) {
      totalSizeBytes = 0
    }
    if (headIndex >= 256 || headIndex > liveCount()) {
      compact()
    }
  }

  function storeEntry(entry: ReplicationLogEntry): ReplicationLogEntry {
    entries.push(entry)
    if (entry.seqNo >= committedSeqNo) {
      committedSeqNo = entry.seqNo
      committedPrimaryTerm = entry.primaryTerm
    }
    totalSizeBytes += estimateEntrySize(entry)
    evictOldEntries()
    return { ...entry }
  }

  function readEntry(seqNo: number): ReplicationLogEntry | undefined {
    if (liveCount() === 0) return undefined
    const idx = findIndexBySeqNo(seqNo)
    if (idx < entries.length && entries[idx].seqNo === seqNo) {
      return { ...entries[idx] }
    }
    return undefined
  }

  function verifyEntryChecksum(entry: ReplicationLogEntry): boolean {
    const expected = computeChecksum({
      seqNo: entry.seqNo,
      primaryTerm: entry.primaryTerm,
      operation: entry.operation,
      partitionId: entry.partitionId,
      indexName: entry.indexName,
      documentId: entry.documentId,
      document: entry.document,
    })
    return expected === entry.checksum
  }

  return {
    append(partial) {
      const seqNo = nextSeqNo
      nextSeqNo += 1

      const entryWithoutChecksum = {
        seqNo,
        primaryTerm: partial.primaryTerm,
        operation: partial.operation,
        partitionId,
        indexName: partial.indexName,
        documentId: partial.documentId,
        document: partial.document,
      }

      const checksum = computeChecksum(entryWithoutChecksum)
      const entry: ReplicationLogEntry = { ...entryWithoutChecksum, checksum }

      return storeEntry(entry)
    },

    appendCommitted(entry: ReplicationLogEntry): ReplicationLogEntry {
      if (!Number.isSafeInteger(entry.seqNo) || entry.seqNo < 1) {
        throw new NarsilError(
          ErrorCodes.REPLICATION_ENTRY_INVALID,
          `Invalid replication sequence number ${entry.seqNo}`,
          {
            seqNo: entry.seqNo,
            partitionId,
          },
        )
      }

      if (entry.partitionId !== partitionId) {
        throw new NarsilError(
          ErrorCodes.REPLICATION_ENTRY_INVALID,
          `Replication entry partition ${entry.partitionId} does not match log partition ${partitionId}`,
          { entryPartitionId: entry.partitionId, logPartitionId: partitionId },
        )
      }

      const existing = readEntry(entry.seqNo)
      if (existing !== undefined) {
        if (existing.checksum !== entry.checksum) {
          throw new NarsilError(
            ErrorCodes.REPLICATION_ENTRY_INVALID,
            `Conflicting replication entry at sequence number ${entry.seqNo}`,
            { seqNo: entry.seqNo, partitionId },
          )
        }
        return existing
      }

      if (entry.seqNo !== nextSeqNo) {
        throw new NarsilError(
          ErrorCodes.REPLICATION_ENTRY_INVALID,
          `Out-of-order replication entry ${entry.seqNo}; expected ${nextSeqNo}`,
          { seqNo: entry.seqNo, expectedSeqNo: nextSeqNo, partitionId },
        )
      }

      if (!verifyEntryChecksum(entry)) {
        throw new NarsilError(
          ErrorCodes.REPLICATION_ENTRY_INVALID,
          `Invalid checksum for replication entry ${entry.seqNo}`,
          { seqNo: entry.seqNo, partitionId },
        )
      }

      nextSeqNo = entry.seqNo + 1
      return storeEntry({ ...entry })
    },

    getEntriesFrom(fromSeqNo: number): ReplicationLogEntry[] {
      if (liveCount() === 0) return []
      const idx = findIndexBySeqNo(fromSeqNo)
      if (idx >= entries.length) return []
      return entries.slice(idx).map(e => ({ ...e }))
    },

    getEntry(seqNo: number): ReplicationLogEntry | undefined {
      return readEntry(seqNo)
    },

    verifyChecksum(entry: ReplicationLogEntry): boolean {
      return verifyEntryChecksum(entry)
    },

    get committedSeqNo(): number {
      return committedSeqNo
    },

    get committedPrimaryTerm(): number {
      return committedPrimaryTerm
    },

    get oldestSeqNo(): number | undefined {
      if (liveCount() === 0) return undefined
      return entries[headIndex].seqNo
    },

    get newestSeqNo(): number | undefined {
      if (liveCount() === 0) return undefined
      return entries[entries.length - 1].seqNo
    },

    get entryCount(): number {
      return liveCount()
    },

    get sizeBytes(): number {
      return totalSizeBytes
    },

    clear(): void {
      entries = []
      headIndex = 0
      totalSizeBytes = 0
      committedSeqNo = nextSeqNo - 1
    },
  }
}
