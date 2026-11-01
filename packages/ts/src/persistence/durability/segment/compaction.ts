import { createSharedFrozenSegment, type FrozenSegment, shareSegmentArrays } from '../../../core/partition/frozen'
import type { TextAnalysis } from '../../../core/partition/frozen/surface-slot'
import type { PartialWordAnalysis } from '../../../core/partition/partial-words/spellings'
import { MAX_FILE_BYTES } from '../../../serialization/constants'
import type { KeywordSegmentContents, SegmentWriteRecords } from '../../../serialization/keyword-segment/types'
import { MERGED_SEGMENT_GROWTH_ALLOWANCE, MERGED_SEGMENT_TARGET_BYTES } from '../../paged/constants'
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
  partialWordAnalysis: PartialWordAnalysis | null
  textAnalysis: TextAnalysis | null
  segments: SegmentRef[]
  nextSegmentId: number
  compactionThreshold: number
  paged?: boolean
}

export interface CompactionResult {
  segments: SegmentRef[]
  nextSegmentId: number
}

interface MergeWindow {
  start: number
  windowLength: number
}

function windowFits(segments: readonly SegmentRef[], start: number, windowLength: number, paged: boolean): boolean {
  let documents = 0
  let bytes = SEGMENT_FILE_FRAMING_SLACK_BYTES
  for (let at = start; at < start + windowLength; at++) {
    documents += segments[at].docCount
    bytes += segments[at].bytes
  }
  if (paged) return bytes * MERGED_SEGMENT_GROWTH_ALLOWANCE <= MERGED_SEGMENT_TARGET_BYTES
  return documents <= COMPACTION_LARGEST_MERGED_DOCUMENT_COUNT && bytes <= MAX_FILE_BYTES
}

function smallestFittingWindow(
  segments: readonly SegmentRef[],
  windowLength: number,
  paged: boolean,
): MergeWindow | null {
  let best: MergeWindow | null = null
  let bestBytes = Number.POSITIVE_INFINITY
  for (let start = 0; start + windowLength <= segments.length; start++) {
    if (!windowFits(segments, start, windowLength, paged)) continue
    let bytes = 0
    for (let at = start; at < start + windowLength; at++) bytes += segments[at].bytes
    if (bytes < bestBytes) {
      bestBytes = bytes
      best = { start, windowLength }
    }
  }
  return best
}

function chooseWindow(segments: readonly SegmentRef[], wantedLength: number, paged: boolean): MergeWindow | null {
  for (let windowLength = Math.min(wantedLength, segments.length); windowLength >= 2; windowLength--) {
    const window = smallestFittingWindow(segments, windowLength, paged)
    if (window !== null) return window
  }
  return null
}

function frozenOf(contents: KeywordSegmentContents): FrozenSegment {
  return createSharedFrozenSegment(shareSegmentArrays(contents.arrays, null))
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

function writeRecordsOf(
  frozen: readonly FrozenSegment[],
  contents: readonly KeywordSegmentContents[],
): Map<FrozenSegment, SegmentWriteRecords> | undefined {
  if (contents.every(segment => segment.writeRecords === undefined)) return undefined
  const records = new Map<FrozenSegment, SegmentWriteRecords>()
  for (let at = 0; at < frozen.length; at++) {
    const held = contents[at].writeRecords
    if (held !== undefined) records.set(frozen[at], held)
  }
  return records
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
  const paged = input.paged === true
  const window = chooseWindow(segments, segments.length - compactionThreshold + 1, paged)
  if (window === null) {
    return { segments, nextSegmentId: input.nextSegmentId }
  }
  const windowRefs = segments.slice(window.start, window.start + window.windowLength)
  const replacing = (written: { segments: SegmentRef[]; nextSegmentId: number }): CompactionResult => ({
    segments: [
      ...segments.slice(0, window.start),
      ...written.segments,
      ...segments.slice(window.start + window.windowLength),
    ],
    nextSegmentId: written.nextSegmentId,
  })
  if (paged) {
    const { directory } = input.store
    if (directory === undefined) return { segments, nextSegmentId: input.nextSegmentId }
    const { mergePagedWindow } = await import('../../paged/module')
    return replacing(
      await mergePagedWindow({
        store: input.store,
        directory,
        indexName: input.indexName,
        partitionId: input.partitionId,
        schema: input.schema,
        partialWordAnalysis: input.partialWordAnalysis,
        textAnalysis: input.textAnalysis,
        nextSegmentId: input.nextSegmentId,
        refs: windowRefs,
        dropsEveryTombstone: window.start === 0,
      }),
    )
  }
  const contents: KeywordSegmentContents[] = []
  for (const ref of windowRefs) contents.push(await readSegmentFile(input.store, ref))
  const frozen = contents.map(frozenOf)
  applyTimeOrder(frozen, contents)
  const writeRecords = writeRecordsOf(frozen, contents)

  const written = await writeSegmentsOf({
    store: input.store,
    indexName: input.indexName,
    partitionId: input.partitionId,
    nextSegmentId: input.nextSegmentId,
    schema: input.schema,
    partialWordAnalysis: input.partialWordAnalysis,
    textAnalysis: input.textAnalysis,
    selections: frozen.map(segment => ({ segment })),
    tombstones: retainedTombstones(frozen, contents),
    mergesIntoOneFile: true,
    ...(writeRecords === undefined ? {} : { writeRecords }),
  })
  return replacing(written)
}
