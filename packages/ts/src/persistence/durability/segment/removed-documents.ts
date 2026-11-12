import { openPagedSegmentScan } from '../../paged/segment-scan'
import { isPagedSegmentFile } from '../../paged/verify'
import { REWRITE_ABOVE_REMOVED_DOCUMENT_SHARE } from '../constants'
import { type CompactionResult, mergeSegmentWindow, type SegmentWindowWriter } from './compaction'
import type { SegmentRef } from './manifest'
import { readSegmentFile } from './segment-file'
import type { CheckpointStore } from './store'

export interface PartitionDocumentCount {
  partitionId: number
  documentCount: number
}

export interface RemovedDocumentRewriteBudget {
  spentBytes: number
  limitBytes: number
}

export interface RemovedDocumentRewrite extends SegmentWindowWriter {
  segments: SegmentRef[]
  liveDocumentCount: number | undefined
  budget: RemovedDocumentRewriteBudget
}

interface SegmentIds {
  ids: string[]
  tombstones: Iterable<string>
}

const decoder = new TextDecoder()

async function readSegmentIds(store: CheckpointStore, ref: SegmentRef): Promise<SegmentIds> {
  const { directory } = store
  if (directory !== undefined && (await isPagedSegmentFile(directory, ref.key))) {
    const scan = await openPagedSegmentScan(directory, ref)
    try {
      const ids: string[] = new Array(scan.count)
      for (let ordinal = 0; ordinal < scan.count; ordinal++) ids[ordinal] = scan.idAt(ordinal)
      return { ids, tombstones: [...scan.tombstones] }
    } finally {
      scan.close()
    }
  }
  const contents = await readSegmentFile(store, ref)
  const table = contents.arrays.idTable
  const ids: string[] = new Array(contents.arrays.documentCount)
  for (let ordinal = 0; ordinal < ids.length; ordinal++) {
    ids[ordinal] = decoder.decode(table.blob.subarray(table.offsets[ordinal], table.offsets[ordinal + 1]))
  }
  return { ids, tombstones: contents.tombstones }
}

async function documentsReplacedLater(store: CheckpointStore, segments: readonly SegmentRef[]): Promise<string[][]> {
  const later = new Set<string>()
  const replaced: string[][] = new Array(segments.length)
  for (let at = segments.length - 1; at >= 0; at--) {
    const { ids, tombstones } = await readSegmentIds(store, segments[at])
    const found: string[] = []
    for (const docId of ids) if (later.has(docId)) found.push(docId)
    replaced[at] = found
    if (at === 0) break
    for (const docId of ids) later.add(docId)
    for (const docId of tombstones) later.add(docId)
  }
  return replaced
}

function exceedsRemovedShare(removed: number, held: number): boolean {
  return held > 0 && removed > held * REWRITE_ABOVE_REMOVED_DOCUMENT_SHARE
}

function freedBytesOf(ref: SegmentRef, replacedCount: number): number {
  return ref.docCount === 0 ? 0 : (ref.bytes * replacedCount) / ref.docCount
}

function chooseRewrites(
  segments: readonly SegmentRef[],
  replaced: readonly string[][],
  budget: RemovedDocumentRewriteBudget,
): number[] {
  let held = 0
  let removed = 0
  for (let at = 0; at < segments.length; at++) {
    held += segments[at].docCount
    removed += replaced[at].length
  }
  const candidates: number[] = []
  for (let at = 0; at < segments.length; at++) if (replaced[at].length > 0) candidates.push(at)
  candidates.sort(
    (left, right) =>
      freedBytesOf(segments[right], replaced[right].length) - freedBytesOf(segments[left], replaced[left].length),
  )
  const chosen: number[] = []
  for (const at of candidates) {
    if (!exceedsRemovedShare(removed, held)) break
    const bytes = segments[at].bytes
    if (chosen.length > 0 && budget.spentBytes + bytes > budget.limitBytes) continue
    chosen.push(at)
    budget.spentBytes += bytes
    held -= replaced[at].length
    removed -= replaced[at].length
  }
  return chosen.sort((left, right) => left - right)
}

function holdsSomething(ref: SegmentRef): boolean {
  return ref.docCount > 0 || ref.tombstoneCount > 0
}

export async function rewriteRemovedDocuments(input: RemovedDocumentRewrite): Promise<CompactionResult> {
  const { segments, liveDocumentCount } = input
  const unchanged = { segments, nextSegmentId: input.nextSegmentId }
  if (liveDocumentCount === undefined) return unchanged
  let held = 0
  for (const ref of segments) held += ref.docCount
  if (!exceedsRemovedShare(held - liveDocumentCount, held)) return unchanged

  const replaced = await documentsReplacedLater(input.store, segments)
  const chosen = new Set(chooseRewrites(segments, replaced, input.budget))
  if (chosen.size === 0) return unchanged
  const rewritten: SegmentRef[] = []
  let nextSegmentId = input.nextSegmentId
  for (let at = 0; at < segments.length; at++) {
    if (!chosen.has(at)) {
      rewritten.push(segments[at])
      continue
    }
    const written = await mergeSegmentWindow(
      { ...input, nextSegmentId },
      { refs: [segments[at]], startsTheList: rewritten.length === 0, replacedAfterWindow: replaced[at] },
    )
    if (written === null) {
      rewritten.push(segments[at])
      continue
    }
    nextSegmentId = written.nextSegmentId
    rewritten.push(...written.segments.filter(holdsSomething))
  }
  return { segments: rewritten, nextSegmentId }
}
