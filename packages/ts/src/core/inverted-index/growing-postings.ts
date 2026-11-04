import { PositionPool, PostingPool } from './growing-pools'
import { LivePostings as PlainLivePostings } from './postings'
import { TERM_POSITIONS } from './terms'

export class LivePostings extends PlainLivePostings {
  override reserve(token: string, entries: number): void {
    super.reserve(token, entries)
    this.growPoolsAheadOfNeed()
  }

  override insert(
    token: string,
    internalId: number,
    termFrequency: number,
    fieldIndex: number,
    positions: readonly number[] | null,
  ): void {
    const terms = this.terms
    const pool = this.pool
    const copyingBefore = pool instanceof PostingPool && pool.copying
    const ordinalBefore = copyingBefore ? terms.ids.get(token) : undefined
    const positionsBefore = ordinalBefore !== undefined && (terms.flags[ordinalBefore] & TERM_POSITIONS) !== 0
    super.insert(token, internalId, termFrequency, fieldIndex, positions)
    if (pool === this.pool && pool instanceof PostingPool && pool.copying) {
      const ordinal = terms.ids.get(token)
      if (ordinal !== undefined) {
        const start = terms.sliceStart[ordinal]
        const at = start + terms.lengths[ordinal] - 1
        const firstWritten = positions !== null && !positionsBefore ? start : at
        pool.mirrorIntoGrowingCopy(firstWritten, at + 1)
      }
    }
    this.growPoolsAheadOfNeed()
  }

  override clear(): void {
    this.stopGrowingReplacedPools(this.pool, this.positions)
    super.clear()
  }

  override byteLength(): number {
    const positions = this.positions
    return super.byteLength() + (positions instanceof PositionPool ? positions.copyByteLength() : 0)
  }

  protected override filterEntries(ordinal: number, drop: (internalId: number) => boolean): void {
    super.filterEntries(ordinal, drop)
    const pool = this.pool
    if (!(pool instanceof PostingPool) || !pool.copying) return
    const start = this.terms.sliceStart[ordinal]
    pool.mirrorIntoGrowingCopy(start, start + this.terms.lengths[ordinal])
  }

  protected override repack(rebuildPositions: boolean): void {
    const pool = this.pool
    const positions = this.positions
    super.repack(rebuildPositions)
    this.stopGrowingReplacedPools(pool === this.pool ? null : pool, positions === this.positions ? null : positions)
  }

  private stopGrowingReplacedPools(pool: object | null, positions: object | null): void {
    if (pool instanceof PostingPool) pool.stopGrowing()
    if (positions instanceof PositionPool) positions.stopGrowing()
  }

  private growPoolsAheadOfNeed(): void {
    const pool = this.pool
    const positions = this.positions
    if (pool instanceof PostingPool) pool.growAheadOfNeed()
    if (positions instanceof PositionPool) positions.growAheadOfNeed()
  }
}
