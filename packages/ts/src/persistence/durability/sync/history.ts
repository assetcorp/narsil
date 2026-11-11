import type { DurableDirectory } from '../durable-filesystem'
import { type HistorySegment, historyKey, historyPrefix, historyRoot, parseHistoryKey, walSegmentKey } from './layout'

export function compareHistorySegments(a: HistorySegment, b: HistorySegment): number {
  return a.partitionId - b.partitionId || a.startSeqNo - b.startSeqNo
}

export async function listHistorySegments(
  directory: DurableDirectory,
  indexName: string,
  partitionId?: number,
): Promise<HistorySegment[]> {
  const prefix = partitionId === undefined ? historyRoot(indexName) : historyPrefix(indexName, partitionId)
  const segments: HistorySegment[] = []
  for (const key of await directory.list(prefix)) {
    const segment = parseHistoryKey(indexName, key)
    if (segment !== null) segments.push(segment)
  }
  return segments.sort(compareHistorySegments)
}

export async function moveSegmentIntoHistory(
  directory: DurableDirectory,
  indexName: string,
  partitionId: number,
  startSeqNo: number,
  movedAtMs: number,
): Promise<void> {
  await directory.move(
    walSegmentKey(indexName, partitionId, startSeqNo),
    historyKey(indexName, partitionId, startSeqNo, movedAtMs),
  )
}

export async function removeHistory(
  directory: DurableDirectory,
  indexName: string,
  partitionId?: number,
): Promise<void> {
  for (const segment of await listHistorySegments(directory, indexName, partitionId)) {
    await directory.remove(segment.key)
  }
}
