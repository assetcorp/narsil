import type { LivePostings } from '#platform/live-postings'
import { beginBatch, endBatch, indexTerms, removeDocument } from '#platform/segment-writes'
import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeFieldTokens, NativeGrowingSegment } from '../../vector/native/types/segments'
import {
  POOL_VACUUM_FREE_FRACTION,
  POOL_VACUUM_MIN_FREE_ENTRIES,
  POSITION_VACUUM_MIN_FREE_VALUES,
  TERM_VACUUM_MIN_DEAD_TERMS,
} from '../inverted-index/constants'
import { SLICE_CAPACITIES } from '../inverted-index/pools'
import { documentCapacity, reservePostings, reserveStrings } from './capacity'
import { FieldLengths } from './field-lengths'
import { sparseStrings } from './maintenance'
import type { SpellingTable } from './spelling-table'
import { SurfaceTable } from './surface-table'
import { trimSegment } from './trim'

const NEEDS_ROOM = 3
const SEGMENT_FULL = 8

export class GrowingSegment {
  readonly fields = new FieldLengths()
  surfaces: SurfaceTable | null = null
  spellings: SpellingTable | null = null

  constructor(
    readonly postings: LivePostings,
    readonly tracksPositions: boolean,
  ) {}

  reserveFields(ordinals: number, fields: number): void {
    this.fields.reserve(ordinals, fields)
    const words = Math.max(1, Math.ceil(this.fields.ordinalCapacity / 32))
    if (words > this.postings.retired.length) {
      const retired = new Uint32Array(words)
      retired.set(this.postings.retired)
      this.postings.retired = retired
    }
  }

  insert(ordinal: number, fields: readonly NativeFieldTokens[], tokens: ReadonlySet<string>): boolean {
    this.preparePublication()
    const terms = this.postings.terms
    const added = terms.liveCount === terms.nonemptyCount ? undefined : this.termsAtFrequency(tokens, 0)
    let status = indexTerms(this.regions(), ordinal, fields)
    if (status === NEEDS_ROOM) {
      const capacity = documentCapacity(fields, this.fields.partial)
      reservePostings(this.postings, capacity, this.tracksPositions)
      if (capacity.surfaces.size > 0) {
        this.surfaces ??= new SurfaceTable()
        reserveStrings(this.surfaces, capacity.surfaces)
      }
      this.spellings?.reserveWords(capacity.spellings)
      status = indexTerms(this.regions(), ordinal, fields)
    }
    if (status === SEGMENT_FULL) return false
    this.accept(status, added)
    return true
  }

  remove(ordinal: number, fields: readonly NativeFieldTokens[], tokens: ReadonlySet<string>): void {
    this.preparePublication()
    const terms = this.postings.terms
    const change =
      terms.liveCount === terms.nonemptyCount
        ? undefined
        : this.postings.isRetired(ordinal)
          ? 0
          : -this.termsAtFrequency(tokens, 1)
    this.accept(removeDocument(this.regions(), ordinal, fields), change)
  }

  regions(): NativeGrowingSegment {
    const { pool, positions, terms, retired } = this.postings
    const fields = this.fields
    return {
      terms: terms.ids,
      columns: terms,
      postings: {
        docIds: pool.docIds,
        frequencies: pool.frequencies,
        fieldIndices: pool.fieldIndices,
        positionStarts: pool.positionStarts,
        allocation: pool.allocation,
        freeHeads: pool.freeHeads,
        sliceCapacities: SLICE_CAPACITIES,
      },
      positions: this.tracksPositions ? { values: positions.values, allocation: positions.allocation } : null,
      surfaces: this.surfaces,
      spellings: this.spellings,
      retired: retired.subarray(0, Math.max(1, Math.ceil(fields.ordinalCapacity / 32))),
      fieldLengths: fields.values,
      totalDocuments: fields.documents,
      totalFieldLengths: fields.totals,
      partialFields: fields.partial,
      ordinalCapacity: fields.ordinalCapacity,
    }
  }

  byteLength(): number {
    return this.fields.byteLength() + (this.surfaces?.byteLength() ?? 0) + (this.spellings?.byteLength() ?? 0)
  }

  batch(ending: boolean): void {
    this.finishCopies()
    this.accept((ending ? endBatch : beginBatch)(this.regions()), 0)
  }

  private finishCopies(): void {
    const { pool, positions } = this.postings
    pool.prepareWrite(pool.end)
    if (this.tracksPositions) {
      positions.prepareWrite(positions.end)
      pool.trackPositions()
    }
  }

  private preparePublication(): void {
    this.finishCopies()
    const { terms, pool, positions } = this.postings
    const dead = terms.ids.header[0] - terms.ids.header[1]
    const termVacuum = dead >= TERM_VACUUM_MIN_DEAD_TERMS && dead > terms.ids.header[1]
    const postingVacuum =
      pool.freeEntries >= POOL_VACUUM_MIN_FREE_ENTRIES && pool.freeEntries > pool.end * POOL_VACUUM_FREE_FRACTION
    const positionVacuum =
      positions.freeValues >= POSITION_VACUUM_MIN_FREE_VALUES &&
      positions.freeValues > positions.end * POOL_VACUUM_FREE_FRACTION
    if (termVacuum || postingVacuum || positionVacuum || sparseStrings(this.surfaces) || sparseStrings(this.spellings))
      this.accept(endBatch(this.regions()), 0)
  }

  private termsAtFrequency(tokens: ReadonlySet<string>, frequency: number): number {
    const terms = this.postings.terms
    let count = 0
    for (const token of tokens) {
      const ordinal = terms.ids.get(token)
      const found = ordinal === undefined ? 0 : terms.frequencyAt(ordinal)
      if (found === frequency) count++
    }
    return count
  }

  private accept(status: number, nonemptyChange: number | undefined): void {
    if (status !== 0)
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The keyword segment refused a document publication', {
        status,
      })
    const generation = this.postings.terms.generation
    const terms = this.postings.terms
    terms.acceptPublication(nonemptyChange ?? terms.ids.header[1] - terms.liveCount)
    if (this.postings.terms.generation !== generation) {
      this.postings.acceptCompaction()
      trimSegment(this)
    }
  }
}
