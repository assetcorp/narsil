import { backgroundTurnIsSpent, yieldBackgroundTurn } from '#platform/shared-turns'
import { POOL_GROWTH_COPY_CHUNK_BYTES, POOL_GROWTH_START_FRACTION } from './constants'
import { PositionCopy, PostingCopy } from './pool-copy'
import { grownCapacity, NO_SLICE, PositionPool as PlainPositionPool, PostingPool as PlainPostingPool } from './pools'

export { EMPTY_POSITIONS, NO_SLICE, sliceCapacity, sliceClassFor } from './pools'

async function copyBetweenTurns(copy: PostingCopy | PositionCopy): Promise<void> {
  let copying = true
  while (copying) {
    await yieldBackgroundTurn()
    do copying = copy.copyNextChunk(POOL_GROWTH_COPY_CHUNK_BYTES)
    while (copying && !backgroundTurnIsSpent())
  }
}

export class PostingPool extends PlainPostingPool {
  private copy: PostingCopy | null = null
  private replaced = false

  get copying(): boolean {
    return this.copy !== null
  }

  override prepareWrite(needed: number): void {
    this.copy?.finish()
    super.prepareWrite(needed)
  }

  override allocate(sliceClass: number): number {
    const start = super.allocate(sliceClass)
    this.copy?.keepPace()
    return start
  }

  override trackPositions(): Uint32Array {
    const alreadyTracked = this.positionStarts !== null
    const starts = super.trackPositions()
    if (!alreadyTracked) this.copy?.trackPositions()
    return starts
  }

  override move(from: number, to: number, count: number): void {
    super.move(from, to, count)
    this.copy?.mirrorRange(to, to + count)
  }

  override release(start: number, sliceClass: number): void {
    super.release(start, sliceClass)
    if (sliceClass !== NO_SLICE) this.copy?.mirrorRange(start, start + 1)
  }

  mirrorIntoGrowingCopy(from: number, to: number): void {
    this.copy?.mirrorRange(from, to)
  }

  growAheadOfNeed(): void {
    if (this.copy !== null || this.replaced) return
    const capacity = this.docIds.length
    if (this.end < capacity * POOL_GROWTH_START_FRACTION) return
    const grown = grownCapacity(capacity, this.end + 1)
    if (grown <= capacity) return
    const copy = new PostingCopy(this, grown)
    this.copy = copy
    void copyBetweenTurns(copy)
  }

  adoptGrownColumns(copy: PostingCopy): void {
    this.docIds = copy.docIds
    this.frequencies = copy.frequencies
    this.fieldIndices = copy.fieldIndices
    this.positionStarts = copy.positionStarts
    this.copy = null
    this.epoch++
  }

  stopGrowing(): void {
    this.replaced = true
    this.copy?.stop()
    this.copy = null
  }

  override byteLength(): number {
    return super.byteLength() + (this.copy === null ? 0 : this.copy.byteLength())
  }

  protected override reserve(needed: number): void {
    if (needed > this.docIds.length) this.copy?.finish()
    super.reserve(needed)
  }
}

export class PositionPool extends PlainPositionPool {
  private copy: PositionCopy | null = null
  private replaced = false

  override prepareWrite(needed: number): void {
    this.copy?.finish()
    super.prepareWrite(needed)
  }

  override append(positions: readonly number[]): number {
    const start = super.append(positions)
    this.copy?.keepPace()
    return start
  }

  override appendFrom(source: PlainPositionPool, start: number): number {
    const target = super.appendFrom(source, start)
    this.copy?.keepPace()
    return target
  }

  growAheadOfNeed(): void {
    if (this.copy !== null || this.replaced) return
    const capacity = this.values.length
    if (this.end < capacity * POOL_GROWTH_START_FRACTION) return
    const grown = grownCapacity(capacity, this.end + 1)
    if (grown <= capacity) return
    const copy = new PositionCopy(this, grown)
    this.copy = copy
    void copyBetweenTurns(copy)
  }

  adoptGrownValues(values: Uint32Array): void {
    this.values = values
    this.copy = null
  }

  stopGrowing(): void {
    this.replaced = true
    this.copy?.stop()
    this.copy = null
  }

  copyByteLength(): number {
    return this.copy === null ? 0 : this.copy.byteLength()
  }

  protected override reserve(needed: number): void {
    if (needed > this.values.length) this.copy?.finish()
    super.reserve(needed)
  }
}
