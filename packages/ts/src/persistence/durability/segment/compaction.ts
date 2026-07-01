import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import type { SerializablePartition } from '../../../types/internal'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig } from '../../../types/schema'
import type { VectorIndex } from '../../../vector/vector-index'
import type { DurableDirectory } from '../durable-filesystem'
import { segmentKey } from './layout'
import type { SegmentRef } from './manifest'
import { mergeTimeOrderedSegments } from './merge'
import { persistSegmentFile, readSegmentContents, type SegmentContents } from './segment-file'

export interface CompactionInput {
  directory: DurableDirectory
  indexName: string
  partitionId: number
  config: IndexConfig
  language: LanguageModule
  segments: SegmentRef[]
  nextSegmentId: number
  compactionThreshold: number
}

export interface CompactionResult {
  segments: SegmentRef[]
  nextSegmentId: number
}

export async function compactPartitionSegments(input: CompactionInput): Promise<CompactionResult> {
  const { segments, compactionThreshold } = input
  if (segments.length <= compactionThreshold) {
    return { segments, nextSegmentId: input.nextSegmentId }
  }

  const windowLength = segments.length - compactionThreshold + 1
  const start = chooseCheapestWindow(segments, windowLength)
  const window = segments.slice(start, start + windowLength)

  const contents: SegmentContents[] = []
  for (const ref of window) {
    contents.push(await readSegmentContents(input.directory, ref.key))
  }

  const merged = mergeTimeOrderedSegments(contents, {
    indexName: input.indexName,
    partitionId: input.partitionId,
    totalPartitions: 1,
    language: input.language.name,
  })

  const liveDocIds = new Set(Object.keys(merged.documents))
  const retainedTombstones = collectRetainedTombstones(contents, liveDocIds)
  const payload = reserialize(input, merged)

  const id = input.nextSegmentId
  const key = segmentKey(input.indexName, input.partitionId, id)
  await persistSegmentFile(input.directory, key, payload, retainedTombstones)

  const mergedRef: SegmentRef = {
    id,
    key,
    docCount: liveDocIds.size,
    tombstoneCount: retainedTombstones.length,
  }

  const nextSegments = [...segments.slice(0, start), mergedRef, ...segments.slice(start + windowLength)]
  return { segments: nextSegments, nextSegmentId: id + 1 }
}

function chooseCheapestWindow(segments: SegmentRef[], windowLength: number): number {
  let prefix = 0
  for (let i = 0; i < windowLength; i += 1) {
    prefix += segments[i].docCount
  }
  let bestStart = 0
  let bestCost = prefix
  for (let start = 1; start + windowLength <= segments.length; start += 1) {
    prefix += segments[start + windowLength - 1].docCount - segments[start - 1].docCount
    if (prefix < bestCost) {
      bestCost = prefix
      bestStart = start
    }
  }
  return bestStart
}

function collectRetainedTombstones(contents: SegmentContents[], liveDocIds: Set<string>): string[] {
  const retained = new Set<string>()
  for (const segment of contents) {
    for (const docId of segment.tombstones) {
      if (!liveDocIds.has(docId)) {
        retained.add(docId)
      }
    }
  }
  return [...retained]
}

function reserialize(input: CompactionInput, merged: SerializablePartition): Uint8Array {
  const router = createPartitionRouter()
  const vectorSink = new Map<string, VectorIndex>()
  const manager = createPartitionManager(input.indexName, input.config, input.language, router, 1, vectorSink)
  manager.deserializePartition(0, merged)
  return manager.serializePartitionToBytes(0)
}
