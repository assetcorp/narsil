import type { DurableDirectory } from '../durable-filesystem'
import { listHistorySegments } from './history'
import { type HistorySegment, parseWalSegmentStart, walSegmentPrefix } from './layout'

export interface HistoryLimits {
  maxAgeMs: number
  maxBytes: number
}

export interface HistoryRetention {
  directory: DurableDirectory
  indexName: string
  limits: HistoryLimits
  nowMs: number
  publishedLastSeqNo(partitionId: number): number | null
  publish: (() => Promise<void>) | null
}

interface SizedSegment extends HistorySegment {
  bytes: number
  lastSeqNo: number
}

async function firstLogStart(directory: DurableDirectory, indexName: string, partitionId: number): Promise<number> {
  let first = Number.POSITIVE_INFINITY
  for (const key of await directory.list(walSegmentPrefix(indexName, partitionId))) {
    const start = parseWalSegmentStart(indexName, partitionId, key)
    if (start !== null && start < first) first = start
  }
  return first
}

async function sizedQueues(retention: HistoryRetention): Promise<Map<number, SizedSegment[]>> {
  const { directory, indexName } = retention
  const queues = new Map<number, SizedSegment[]>()
  for (const segment of await listHistorySegments(directory, indexName)) {
    const bytes = (await directory.byteLength?.(segment.key)) ?? (await directory.read(segment.key))?.byteLength
    if (bytes === undefined || bytes === null) continue
    const queue = queues.get(segment.partitionId) ?? []
    queue.push({ ...segment, bytes, lastSeqNo: Number.POSITIVE_INFINITY })
    queues.set(segment.partitionId, queue)
  }
  for (const [partitionId, queue] of queues) {
    const logStart = await firstLogStart(directory, indexName, partitionId)
    for (let i = 0; i < queue.length; i++) {
      const nextStart = i + 1 < queue.length ? queue[i + 1].startSeqNo : logStart
      queue[i].lastSeqNo = nextStart - 1
    }
  }
  return queues
}

function nextToDelete(
  queues: Map<number, SizedSegment[]>,
  totalBytes: number,
  retention: HistoryRetention,
): SizedSegment | null {
  const oldestKept = retention.nowMs - retention.limits.maxAgeMs
  let oldest: SizedSegment | null = null
  for (const queue of queues.values()) {
    const head = queue[0]
    if (head === undefined) continue
    if (oldest === null || head.movedAtMs < oldest.movedAtMs) oldest = head
  }
  if (oldest === null) return null
  if (oldest.movedAtMs < oldestKept || totalBytes > retention.limits.maxBytes) return oldest
  return null
}

export async function enforceHistoryLimits(retention: HistoryRetention): Promise<number> {
  const queues = await sizedQueues(retention)
  let totalBytes = 0
  for (const queue of queues.values()) for (const segment of queue) totalBytes += segment.bytes
  let published = false
  let deleted = 0
  let segment = nextToDelete(queues, totalBytes, retention)
  while (segment !== null) {
    const publishedLast = retention.publishedLastSeqNo(segment.partitionId)
    if (!published && retention.publish !== null && (publishedLast === null || segment.lastSeqNo > publishedLast)) {
      published = true
      await retention.publish()
    }
    await retention.directory.remove(segment.key)
    queues.get(segment.partitionId)?.shift()
    totalBytes -= segment.bytes
    deleted += 1
    segment = nextToDelete(queues, totalBytes, retention)
  }
  return deleted
}
