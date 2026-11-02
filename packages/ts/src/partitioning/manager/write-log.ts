import type { FrozenSegment } from '../../core/partition/frozen'

export interface PartitionWriteLog {
  readonly partitionsReplaced: boolean
  readonly pendingDocuments: number
  takeWrittenDocIds(): Set<string>
  close(): void
}

export const REANALYSIS_WRITE_LOG = 0
export const CHECKPOINT_WRITE_LOG = 1

export interface WriteLogRecorder {
  open(owner: number): PartitionWriteLog
  documentWritten(docId: string): void
  segmentWritten(segment: FrozenSegment): void
  partitionsReplaced(): void
}

interface OpenLog {
  docIds: Set<string>
  replaced: boolean
}

export function createWriteLogRecorder(): WriteLogRecorder {
  const current: Array<OpenLog | null> = [null, null]

  return {
    open(owner: number): PartitionWriteLog {
      const log: OpenLog = { docIds: new Set(), replaced: false }
      current[owner] = log
      return {
        get partitionsReplaced() {
          return log.replaced
        },
        get pendingDocuments() {
          return log.docIds.size
        },
        takeWrittenDocIds(): Set<string> {
          const taken = log.docIds
          log.docIds = new Set()
          return taken
        },
        close(): void {
          if (current[owner] === log) current[owner] = null
        },
      }
    },

    documentWritten(docId: string): void {
      current[0]?.docIds.add(docId)
      current[1]?.docIds.add(docId)
    },

    segmentWritten(segment: FrozenSegment): void {
      for (const log of current) {
        if (log === null) continue
        for (const internalId of segment.docStore.allInternalIds()) {
          const docId = segment.docStore.getExternalId(internalId)
          if (docId !== undefined) log.docIds.add(docId)
        }
      }
    },

    partitionsReplaced(): void {
      for (const log of current) {
        if (log !== null) log.replaced = true
      }
    },
  }
}
