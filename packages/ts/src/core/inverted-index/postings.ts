import { MAX_TERM_FREQUENCY, POSTING_LIST_COMPACTION_THRESHOLD } from '../constants'
import {
  CACHED_VIEW_MIN_ENTRIES,
  POOL_VACUUM_FREE_FRACTION,
  POOL_VACUUM_MIN_FREE_ENTRIES,
  POSITION_POOL_START_VALUES,
  POSITION_VACUUM_MIN_FREE_VALUES,
  POSTING_POOL_START_ENTRIES,
  RETIRED_DOCUMENTS_START_CAPACITY,
  TERM_TABLE_START_CAPACITY,
  TERM_VACUUM_MIN_DEAD_TERMS,
} from './constants'
import { EMPTY_POSITIONS, NO_SLICE, PositionPool, PostingPool, sliceCapacity, sliceClassFor } from './pools'
import { TERM_ORDERED, TERM_POSITIONS, TermColumns } from './terms'
import { LivePostingView } from './view'

function holdsDocument(
  docIds: Uint32Array,
  start: number,
  length: number,
  internalId: number,
  ordered: boolean,
): boolean {
  if (!ordered) {
    for (let i = start; i < start + length; i++) {
      if (docIds[i] === internalId) return true
    }
    return false
  }
  let low = start
  let high = start + length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (docIds[middle] < internalId) low = middle + 1
    else high = middle
  }
  return low < start + length && docIds[low] === internalId
}

export class LivePostings {
  terms = new TermColumns(TERM_TABLE_START_CAPACITY)
  pool = new PostingPool(POSTING_POOL_START_ENTRIES)
  positions = new PositionPool(POSITION_POOL_START_VALUES)
  retired = new Uint8Array(RETIRED_DOCUMENTS_START_CAPACITY)
  private batchMode = false
  private dirty = new Set<number>()
  private cachedViews = new Map<number, LivePostingView>()
  private compactedSlack = 0

  view(ordinal: number, cached: boolean): LivePostingView {
    if (!cached || this.terms.lengths[ordinal] < CACHED_VIEW_MIN_ENTRIES) {
      return new LivePostingView(this, this.terms.tokens[ordinal], ordinal, cached)
    }
    let view = this.cachedViews.get(ordinal)
    if (view === undefined) {
      view = new LivePostingView(this, this.terms.tokens[ordinal], ordinal, true)
      this.cachedViews.set(ordinal, view)
    }
    return view
  }

  reserve(token: string, entries: number): void {
    const terms = this.terms
    const ordinal = terms.ids.get(token) ?? terms.add(token)
    if (sliceCapacity(terms.sliceClass[ordinal]) < terms.lengths[ordinal] + entries) {
      this.relocate(ordinal, terms.lengths[ordinal] + entries)
    }
  }

  insert(
    token: string,
    internalId: number,
    termFrequency: number,
    fieldIndex: number,
    positions: readonly number[] | null,
  ): void {
    const terms = this.terms
    if (this.isRetired(internalId)) this.purgeRetired()
    const ordinal = terms.ids.get(token) ?? terms.add(token)

    const length = terms.lengths[ordinal]
    if (length >= sliceCapacity(terms.sliceClass[ordinal])) this.relocate(ordinal, length + 1)
    const pool = this.pool
    const start = terms.sliceStart[ordinal]
    const at = start + length
    const flags = terms.flags[ordinal]

    let newDocument = true
    if (length > 0) {
      const last = pool.docIds[at - 1]
      const ordered = (flags & TERM_ORDERED) !== 0
      if (internalId === last) {
        newDocument = false
      } else if (!ordered || internalId < last) {
        newDocument = !holdsDocument(pool.docIds, start, length, internalId, ordered)
        if (internalId < last) terms.flags[ordinal] = flags & ~TERM_ORDERED
      }
    }

    const stored = termFrequency > MAX_TERM_FREQUENCY ? MAX_TERM_FREQUENCY : termFrequency
    pool.docIds[at] = internalId
    pool.frequencies[at] = stored
    pool.fieldIndices[at] = fieldIndex
    terms.totalTermFrequency[ordinal] += stored

    if (positions !== null) {
      const starts = pool.trackPositions()
      if ((flags & TERM_POSITIONS) === 0) {
        terms.flags[ordinal] |= TERM_POSITIONS
        starts.fill(EMPTY_POSITIONS, start, at)
      }
      starts[at] = this.positions.append(positions)
    } else if ((flags & TERM_POSITIONS) !== 0) {
      pool.trackPositions()[at] = EMPTY_POSITIONS
    }

    if (newDocument) terms.docFrequency[ordinal]++
    terms.lengths[ordinal] = length + 1
    this.repackIfSparse()
  }

  remove(token: string, internalId: number, occurrences: number): void {
    const terms = this.terms
    const ordinal = terms.ids.get(token)
    if (ordinal === undefined) return
    const length = terms.lengths[ordinal]
    const ordered = (terms.flags[ordinal] & TERM_ORDERED) !== 0
    if (!holdsDocument(this.pool.docIds, terms.sliceStart[ordinal], length, internalId, ordered)) return

    terms.revision[ordinal]++
    terms.docFrequency[ordinal]--
    terms.deadDocuments[ordinal]++
    this.retire(internalId)
    terms.totalTermFrequency[ordinal] = Math.max(0, terms.totalTermFrequency[ordinal] - occurrences)

    if (terms.docFrequency[ordinal] === 0) {
      this.dropTerm(ordinal)
      return
    }
    if (this.batchMode) {
      this.dirty.add(ordinal)
      return
    }
    if (terms.deadDocuments[ordinal] / length > POSTING_LIST_COMPACTION_THRESHOLD) this.compact(ordinal)
    this.repackIfSparse()
  }

  isRetired(internalId: number): boolean {
    return internalId < this.retired.length && this.retired[internalId] === 1
  }

  beginBatch(): void {
    this.batchMode = true
    this.dirty.clear()
  }

  endBatch(): void {
    this.batchMode = false
    const terms = this.terms
    for (const ordinal of this.dirty) {
      if (!terms.isLive(ordinal)) continue
      if (terms.deadDocuments[ordinal] / terms.lengths[ordinal] > POSTING_LIST_COMPACTION_THRESHOLD) {
        this.compact(ordinal)
      }
    }
    this.dirty.clear()
    this.repackIfSparse()
  }

  clear(): void {
    const epoch = this.pool.epoch + 1
    this.terms.clear()
    this.pool = new PostingPool(POSTING_POOL_START_ENTRIES)
    this.pool.epoch = epoch
    this.positions = new PositionPool(POSITION_POOL_START_VALUES)
    this.retired = new Uint8Array(RETIRED_DOCUMENTS_START_CAPACITY)
    this.dirty.clear()
    this.cachedViews.clear()
    this.compactedSlack = 0
  }

  byteLength(): number {
    return this.terms.byteLength() + this.pool.byteLength() + this.positions.values.byteLength + this.retired.byteLength
  }

  private retire(internalId: number): void {
    if (internalId >= this.retired.length) {
      const grown = new Uint8Array(Math.max(internalId + 1, this.retired.length * 2))
      grown.set(this.retired)
      this.retired = grown
    }
    this.retired[internalId] = 1
  }

  private purgeRetired(): void {
    const terms = this.terms
    for (let ordinal = 0; ordinal < terms.count; ordinal++) {
      if (terms.isLive(ordinal) && terms.deadDocuments[ordinal] > 0) this.compact(ordinal)
    }
    this.retired.fill(0)
  }

  private compact(ordinal: number): void {
    if (this.terms.deadDocuments[ordinal] === 0) return
    const retired = this.retired
    this.filterEntries(ordinal, id => id < retired.length && retired[id] === 1)
    this.terms.deadDocuments[ordinal] = 0
  }

  private filterEntries(ordinal: number, drop: (internalId: number) => boolean): void {
    const terms = this.terms
    const pool = this.pool
    const start = terms.sliceStart[ordinal]
    const length = terms.lengths[ordinal]
    const starts = (terms.flags[ordinal] & TERM_POSITIONS) !== 0 ? pool.positionStarts : null
    const { docIds, frequencies, fieldIndices } = pool
    terms.revision[ordinal]++
    let kept = 0
    let ascending = true
    for (let i = start; i < start + length; i++) {
      const internalId = docIds[i]
      if (drop(internalId)) {
        if (starts !== null) this.positions.release(starts[i])
        continue
      }
      const target = start + kept
      if (kept > 0 && internalId < docIds[target - 1]) ascending = false
      if (target !== i) {
        docIds[target] = internalId
        frequencies[target] = frequencies[i]
        fieldIndices[target] = fieldIndices[i]
        if (starts !== null) starts[target] = starts[i]
      }
      kept++
    }
    terms.lengths[ordinal] = kept
    terms.flags[ordinal] = ascending ? terms.flags[ordinal] | TERM_ORDERED : terms.flags[ordinal] & ~TERM_ORDERED
    this.compactedSlack += length - kept
  }

  private relocate(ordinal: number, needed: number): void {
    const terms = this.terms
    const previousClass = terms.sliceClass[ordinal]
    const previousStart = terms.sliceStart[ordinal]
    const length = terms.lengths[ordinal]
    const grownClass = previousClass === NO_SLICE ? 0 : previousClass + 1
    const nextClass = Math.max(grownClass, sliceClassFor(needed))
    const nextStart = this.pool.allocate(nextClass)
    if (length > 0) this.pool.move(previousStart, nextStart, length)
    this.pool.release(previousStart, previousClass)
    terms.sliceStart[ordinal] = nextStart
    terms.sliceClass[ordinal] = nextClass
  }

  private dropTerm(ordinal: number): void {
    const terms = this.terms
    const pool = this.pool
    if ((terms.flags[ordinal] & TERM_POSITIONS) !== 0 && pool.positionStarts !== null) {
      const start = terms.sliceStart[ordinal]
      for (let i = start; i < start + terms.lengths[ordinal]; i++) this.positions.release(pool.positionStarts[i])
    }
    pool.release(terms.sliceStart[ordinal], terms.sliceClass[ordinal])
    this.dirty.delete(ordinal)
    this.cachedViews.delete(ordinal)
    terms.kill(ordinal)
    if (terms.deadCount >= TERM_VACUUM_MIN_DEAD_TERMS && terms.deadCount > terms.liveCount) this.renumberTerms()
  }

  private renumberTerms(): void {
    const remap = this.terms.renumber()
    const dirty = new Set<number>()
    for (const ordinal of this.dirty) {
      if (remap[ordinal] >= 0) dirty.add(remap[ordinal])
    }
    this.dirty = dirty
    this.cachedViews.clear()
  }

  private repackIfSparse(): void {
    const pool = this.pool
    const freeEntries = pool.freeEntries + this.compactedSlack
    const sparsePostings =
      freeEntries >= POOL_VACUUM_MIN_FREE_ENTRIES && freeEntries > pool.end * POOL_VACUUM_FREE_FRACTION
    const positions = this.positions
    const sparsePositions =
      positions.freeValues >= POSITION_VACUUM_MIN_FREE_VALUES &&
      positions.freeValues > positions.end * POOL_VACUUM_FREE_FRACTION
    if (sparsePostings || sparsePositions) this.repack(sparsePositions)
  }

  private repack(rebuildPositions: boolean): void {
    const terms = this.terms
    const pool = this.pool
    const positions = this.positions
    let capacity = 0
    for (let ordinal = 0; ordinal < terms.count; ordinal++) {
      if (terms.isLive(ordinal)) capacity += sliceCapacity(sliceClassFor(terms.lengths[ordinal]))
    }
    const nextPool = new PostingPool(Math.max(1, capacity))
    nextPool.epoch = pool.epoch + 1
    const sourceStarts = pool.positionStarts
    const targetStarts = sourceStarts === null ? null : nextPool.trackPositions()
    const nextPositions = rebuildPositions ? new PositionPool(positions.end - positions.freeValues) : positions
    for (let ordinal = 0; ordinal < terms.count; ordinal++) {
      if (!terms.isLive(ordinal)) continue
      const start = terms.sliceStart[ordinal]
      const length = terms.lengths[ordinal]
      const sliceClass = sliceClassFor(length)
      const target = nextPool.allocate(sliceClass)
      nextPool.docIds.set(pool.docIds.subarray(start, start + length), target)
      nextPool.frequencies.set(pool.frequencies.subarray(start, start + length), target)
      nextPool.fieldIndices.set(pool.fieldIndices.subarray(start, start + length), target)
      if ((terms.flags[ordinal] & TERM_POSITIONS) !== 0 && sourceStarts !== null && targetStarts !== null) {
        if (rebuildPositions) {
          for (let i = 0; i < length; i++)
            targetStarts[target + i] = nextPositions.appendFrom(positions, sourceStarts[start + i])
        } else {
          targetStarts.set(sourceStarts.subarray(start, start + length), target)
        }
      }
      terms.sliceStart[ordinal] = target
      terms.sliceClass[ordinal] = sliceClass
    }
    this.pool = nextPool
    this.positions = nextPositions
    this.compactedSlack = 0
  }
}
