import { bitsetSet } from '../../search/phrase-host-bindings'
import type { PostingListView } from '../../types/internal'
import type { NativePhrasePostings } from '../../vector/native/types/phrases'

interface CachedPostings {
  revision: number
  source: ArrayLike<number>
  regions: NativePhrasePostings
}

const cached = new WeakMap<PostingListView, CachedPostings>()

export const missingPostings: NativePhrasePostings = {
  documents: new Uint32Array(0),
  fields: new Uint16Array(0),
  positionStarts: new Uint32Array(0),
  positionCounts: new Uint32Array(0),
  positions: new Uint32Array(0),
  ordered: true,
}

export function phrasePostings(list: PostingListView | undefined): NativePhrasePostings {
  const positions = list?.positionStore
  if (list === undefined || positions === undefined || positions === null) return missingPostings
  const source = list.docIds
  const revision = list.structureRevision
  const held = cached.get(list)
  if (
    held !== undefined &&
    held.revision === revision &&
    held.source === source &&
    held.regions.positions === positions
  )
    return held.regions
  const documents = source instanceof Uint32Array ? source.subarray(0, list.length) : Uint32Array.from(source)
  const fieldIndices = list.fieldNameIndices
  const fields =
    fieldIndices instanceof Uint16Array ? fieldIndices.subarray(0, list.length) : Uint16Array.from(fieldIndices)
  const positionStarts = new Uint32Array(list.length)
  const positionCounts = new Uint32Array(list.length)
  for (let row = 0; row < list.length; row++) {
    positionStarts[row] = list.positionStartAt?.(row) ?? 0
    positionCounts[row] = list.positionCountAt?.(row) ?? 0
  }
  const regions = { documents, fields, positionStarts, positionCounts, positions, ordered: list.ordered }
  cached.set(list, { source, revision, regions })
  return regions
}

export function markRemoved(list: PostingListView, into: Uint32Array): void {
  const removed = list.deletedDocs
  if (removed.size === 0) return
  const documents = list.docIds
  for (let row = 0; row < list.length; row++) {
    const document = documents[row]
    if (removed.has(document)) bitsetSet(into, document)
  }
}
