import { generateId } from '../../../core/id-generator'
import { createSharedFrozenSegment, type FrozenSegment } from '../../../core/partition/frozen'
import { MAX_FILE_BYTES } from '../../../serialization/constants'
import type { KeywordSegmentContents } from '../../../serialization/keyword-segment/types'
import { COMPACTION_LARGEST_MERGED_DOCUMENT_COUNT, SEGMENT_FILE_FRAMING_SLACK_BYTES } from '../constants'
import type { SegmentRef } from './manifest'
import { readSegmentFile } from './segment-file'
import { writeSegmentsOf } from './segment-write'
import type { CheckpointStore } from './store'

export interface CompactionInput {
  store: CheckpointStore
  indexName: string
  partitionId: number
  schema: Record<string, string>
  segments: SegmentRef[]
  nextSegmentId: number
  compactionThreshold: number
}

export interface CompactionResult {
  segments: SegmentRef[]
  nextSegmentId: number
}

interface MergeWindow {
  start: number
  windowLength: number
}

function windowFits(segments: readonly SegmentRef[], start: number, windowLength: number): boolean {
  let documents = 0
  let bytes = SEGMENT_FILE_FRAMING_SLACK_BYTES
  for (let at = start; at < start + windowLength; at++) {
    documents += segments[at].docCount
    bytes += segments[at].bytes
  }
  return documents <= COMPACTION_LARGEST_MERGED_DOCUMENT_COUNT && bytes <= MAX_FILE_BYTES
}

function smallestFittingWindow(segments: readonly SegmentRef[], windowLength: number): MergeWindow | null {
  let best: MergeWindow | null = null
  let bestBytes = Number.POSITIVE_INFINITY
  for (let start = 0; start + windowLength <= segments.length; start++) {
    if (!windowFits(segments, start, windowLength)) continue
    let bytes = 0
    for (let at = start; at < start + windowLength; at++) bytes += segments[at].bytes
    if (bytes < bestBytes) {
      bestBytes = bytes
      best = { start, windowLength }
    }
  }
  return best
}

function chooseWindow(segments: readonly SegmentRef[], wantedLength: number): MergeWindow | null {
  for (let windowLength = Math.min(wantedLength, segments.length); windowLength >= 2; windowLength--) {
    const window = smallestFittingWindow(segments, windowLength)
    if (window !== null) return window
  }
  return null
}

function frozenOf(contents: KeywordSegmentContents): FrozenSegment {
  return createSharedFrozenSegment({ ...contents.arrays, segmentId: generateId() })
}

function applyTimeOrder(frozen: readonly FrozenSegment[], contents: readonly KeywordSegmentContents[]): void {
  for (let newer = 1; newer < frozen.length; newer++) {
    const replaced = new Set(contents[newer].tombstones)
    const ids = frozen[newer].arrays.idTable
    for (let ordinal = 0; ordinal < ids.count; ordinal++) replaced.add(ids.idAt(ordinal))
    for (let older = 0; older < newer; older++) {
      for (const docId of replaced) frozen[older].tombstoneDocument(docId)
    }
  }
}

function retainedTombstones(frozen: readonly FrozenSegment[], contents: readonly KeywordSegmentContents[]): string[] {
  const retained = new Set<string>()
  for (const segment of contents) {
    for (const docId of segment.tombstones) {
      if (!frozen.some(candidate => candidate.hasDocument(docId))) retained.add(docId)
    }
  }
  return [...retained]
}

export async function compactPartitionSegments(input: CompactionInput): Promise<CompactionResult> {
  const { segments, compactionThreshold } = input
  if (segments.length <= compactionThreshold) {
    return { segments, nextSegmentId: input.nextSegmentId }
  }
  const window = chooseWindow(segments, segments.length - compactionThreshold + 1)
  if (window === null) {
    return { segments, nextSegmentId: input.nextSegmentId }
  }
  const windowRefs = segments.slice(window.start, window.start + window.windowLength)
  const contents: KeywordSegmentContents[] = []
  for (const ref of windowRefs) contents.push(await readSegmentFile(input.store, ref))
  const frozen = contents.map(frozenOf)
  applyTimeOrder(frozen, contents)

  const written = await writeSegmentsOf({
    store: input.store,
    indexName: input.indexName,
    partitionId: input.partitionId,
    nextSegmentId: input.nextSegmentId,
    schema: input.schema,
    selections: frozen.map(segment => ({ segment })),
    tombstones: retainedTombstones(frozen, contents),
    mergesIntoOneFile: true,
  })
  return {
    segments: [
      ...segments.slice(0, window.start),
      ...written.segments,
      ...segments.slice(window.start + window.windowLength),
    ],
    nextSegmentId: written.nextSegmentId,
  }
}
