import { readCommitMarker } from './commit-marker'
import type { DurableDirectory } from './durable-filesystem'
import type { PartitionCheckpoint } from './partition-checkpoint'

function walPrefix(indexName: string, partitionId: number): string {
  return `${indexName}/wal/${partitionId}/`
}

export async function truncateCoveredSegments(
  directory: DurableDirectory,
  indexName: string,
  checkpoint: PartitionCheckpoint[],
): Promise<void> {
  for (const { partitionId, lastSeqNo } of checkpoint) {
    const prefix = walPrefix(indexName, partitionId)
    const markerBytes = await directory.read(`${prefix}commit`)
    const marker = markerBytes === null ? null : readCommitMarker(markerBytes)
    if (marker === null) {
      continue
    }
    const activeSegmentSeqNo = marker.state.activeSegmentSeqNo

    const segments = await directory.list(prefix)
    const startSeqNos = segments
      .map(key => parseSegmentStartSeqNo(key, prefix))
      .filter((value): value is number => value !== null)
      .sort((a, b) => a - b)

    for (let i = 0; i < startSeqNos.length; i += 1) {
      const start = startSeqNos[i]
      if (start >= activeSegmentSeqNo) {
        break
      }
      const nextStart = startSeqNos[i + 1]
      const segmentCoversBeyondCheckpoint = nextStart === undefined || nextStart > lastSeqNo + 1
      if (segmentCoversBeyondCheckpoint) {
        break
      }
      await directory.remove(`${prefix}${formatSegmentStart(start)}`)
    }
  }
}

export async function reclaimWalBeyondCount(
  directory: DurableDirectory,
  indexName: string,
  partitionCount: number,
  partitions: Map<number, { walWriter: { close(): Promise<void> } }>,
  onCloseError: (error: Error) => void,
): Promise<void> {
  for (const [partitionId, partition] of [...partitions]) {
    if (partitionId < partitionCount) continue
    try {
      await partition.walWriter.close()
    } catch (err) {
      onCloseError(err instanceof Error ? err : new Error(String(err)))
    }
    partitions.delete(partitionId)
  }
  const walRoot = `${indexName}/wal/`
  for (const key of await directory.list(walRoot)) {
    const partitionId = walKeyPartitionId(key, walRoot)
    if (partitionId === null || partitionId < partitionCount) continue
    await directory.remove(key)
  }
}

function walKeyPartitionId(key: string, walRoot: string): number | null {
  const tail = key.slice(walRoot.length)
  const separator = tail.indexOf('/')
  if (separator <= 0) {
    return null
  }
  const segment = tail.slice(0, separator)
  if (!/^\d+$/.test(segment)) {
    return null
  }
  const value = Number.parseInt(segment, 10)
  return Number.isSafeInteger(value) ? value : null
}

function parseSegmentStartSeqNo(key: string, prefix: string): number | null {
  if (!key.startsWith(prefix)) {
    return null
  }
  const tail = key.slice(prefix.length)
  if (!/^\d{16}$/.test(tail)) {
    return null
  }
  const value = Number.parseInt(tail, 10)
  return Number.isSafeInteger(value) ? value : null
}

function formatSegmentStart(startSeqNo: number): string {
  return startSeqNo.toString().padStart(16, '0')
}
