import type { PostingListView } from '../../../types/internal'
import type { SegmentPayload } from '../segment-payload'
import type { FrozenTombstones } from './tombstones'

type PostingArrays = Pick<
  SegmentPayload,
  'postingOffsets' | 'postingDocIds' | 'postingFrequencies' | 'postingFieldIndices'
>

function isOrdered(docIds: Uint32Array): boolean {
  for (let i = 1; i < docIds.length; i++) {
    if (docIds[i] < docIds[i - 1]) return false
  }
  return true
}

function sumFrequencies(frequencies: Uint16Array): number {
  let total = 0
  for (let i = 0; i < frequencies.length; i++) total += frequencies[i]
  return total
}

export interface FrozenPostingViews {
  viewAt(payloadSlot: number, documentFrequency: number): PostingListView
}

export function createFrozenPostingViews(payload: PostingArrays, tombstones: FrozenTombstones): FrozenPostingViews {
  const views = new Map<number, PostingListView>()

  function buildView(payloadSlot: number, documentFrequency: number): PostingListView {
    const start = payload.postingOffsets[payloadSlot]
    const end = payload.postingOffsets[payloadSlot + 1]
    const docIds = payload.postingDocIds.subarray(start, end)
    const termFrequencies = payload.postingFrequencies.subarray(start, end)
    const fieldNameIndices = payload.postingFieldIndices.subarray(start, end)
    const ordered = isOrdered(docIds)
    const totalTermFrequency = sumFrequencies(termFrequencies)

    return {
      length: end - start,
      docIds,
      termFrequencies,
      fieldNameIndices,
      docIdSet: { size: documentFrequency },
      deletedDocs: tombstones,
      totalTermFrequency,
      get structureRevision() {
        return tombstones.revision
      },
      ordered,
    }
  }

  return {
    viewAt(payloadSlot: number, documentFrequency: number): PostingListView {
      let view = views.get(payloadSlot)
      if (view === undefined) {
        view = buildView(payloadSlot, documentFrequency)
        views.set(payloadSlot, view)
      }
      return view
    },
  }
}
