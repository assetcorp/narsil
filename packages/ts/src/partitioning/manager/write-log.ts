import type { FrozenSegment } from '../../core/partition/frozen'

export interface PartitionWriteLog {
  readonly partitionsReplaced: boolean
  readonly pendingDocuments: number
  takeWrittenDocIds(): Set<string>
  close(): void
}

export interface WriteLogRecorder {
  open(): PartitionWriteLog
  documentWritten(docId: string): void
  segmentWritten(segment: FrozenSegment): void
  partitionsReplaced(): void
}

interface OpenLog {
  docIds: Set<string>
  replaced: boolean
}

export function createWriteLogRecorder(): WriteLogRecorder {
  let current: OpenLog | null = null

  return {
    open(): PartitionWriteLog {
      const log: OpenLog = { docIds: new Set(), replaced: false }
      current = log
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
          if (current === log) current = null
        },
      }
    },

    documentWritten(docId: string): void {
      if (current !== null) current.docIds.add(docId)
    },

    segmentWritten(segment: FrozenSegment): void {
      if (current === null) return
      for (const internalId of segment.docStore.allInternalIds()) {
        const docId = segment.docStore.getExternalId(internalId)
        if (docId !== undefined) current.docIds.add(docId)
      }
    },

    partitionsReplaced(): void {
      if (current !== null) current.replaced = true
    },
  }
}
