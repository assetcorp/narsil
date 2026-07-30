import { ErrorCodes, NarsilError } from '../errors'
import type { AnyDocument } from '../types/schema'

export interface WAQEntry {
  sequenceNumber: number
  action: 'insert' | 'remove' | 'update'
  docId: string
  document?: AnyDocument
  indexName: string
}

export type BufferedDocState = 'present' | 'absent'

export interface WriteAheadQueue {
  push(entry: Omit<WAQEntry, 'sequenceNumber'>): number
  drain(): WAQEntry[]
  clear(): void
  bufferedDocState(docId: string): BufferedDocState | undefined
  readonly size: number
  readonly isFull: boolean
}

export function createWriteAheadQueue(maxSize = 10_000): WriteAheadQueue {
  const entries: WAQEntry[] = []
  const docStates = new Map<string, BufferedDocState>()
  let nextSequence = 1

  return {
    push(entry: Omit<WAQEntry, 'sequenceNumber'>): number {
      if (entries.length >= maxSize) {
        throw new NarsilError(
          ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
          `Write-ahead queue is full (${maxSize} entries). Retry after rebalancing completes.`,
          { maxSize, currentSize: entries.length },
        )
      }
      const seq = nextSequence++
      entries.push({ ...entry, sequenceNumber: seq })
      docStates.set(entry.docId, entry.action === 'remove' ? 'absent' : 'present')
      return seq
    },

    drain(): WAQEntry[] {
      const result = entries.splice(0)
      result.sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      return result
    },

    clear(): void {
      entries.length = 0
      docStates.clear()
    },

    bufferedDocState(docId: string): BufferedDocState | undefined {
      return docStates.get(docId)
    },

    get size() {
      return entries.length
    },

    get isFull() {
      return entries.length >= maxSize
    },
  }
}
