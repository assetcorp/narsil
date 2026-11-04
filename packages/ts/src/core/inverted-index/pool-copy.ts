import type { PositionPool, PostingPool } from './growing-pools'

abstract class ScheduledCopy {
  copiedUpTo = 0
  private stopped = false

  constructor(
    private readonly startedAt: number,
    private readonly fullAt: number,
  ) {}

  protected abstract usedEntries(): number
  protected abstract entryBytes(): number
  protected abstract copyRange(from: number, to: number): void
  protected abstract adopt(): void

  keepPace(): void {
    const end = this.usedEntries()
    const startedAt = this.startedAt
    const fullAt = this.fullAt
    const due =
      end >= fullAt || fullAt <= startedAt
        ? end
        : Math.min(end, Math.ceil(fullAt * ((end - startedAt) / (fullAt - startedAt))))
    if (due > this.copiedUpTo) this.copyUpTo(due)
  }

  finish(): void {
    this.copyUpTo(this.usedEntries())
  }

  stop(): void {
    this.stopped = true
  }

  copyNextChunk(chunkBytes: number): boolean {
    if (this.stopped) return false
    const chunkEntries = Math.max(1, Math.floor(chunkBytes / this.entryBytes()))
    this.copyUpTo(Math.min(this.usedEntries(), this.copiedUpTo + chunkEntries))
    return !this.stopped
  }

  private copyUpTo(to: number): void {
    this.copyRange(this.copiedUpTo, to)
    this.copiedUpTo = to
    if (to < this.usedEntries()) return
    this.stopped = true
    this.adopt()
  }
}

export class PostingCopy extends ScheduledCopy {
  readonly docIds: Uint32Array
  readonly frequencies: Uint16Array
  readonly fieldIndices: Uint16Array
  positionStarts: Uint32Array | null

  constructor(
    private readonly pool: PostingPool,
    capacity: number,
  ) {
    super(pool.end, pool.docIds.length)
    this.docIds = new Uint32Array(capacity)
    this.frequencies = new Uint16Array(capacity)
    this.fieldIndices = new Uint16Array(capacity)
    this.positionStarts = pool.positionStarts === null ? null : new Uint32Array(capacity)
  }

  trackPositions(): void {
    if (this.positionStarts === null) this.positionStarts = new Uint32Array(this.docIds.length)
  }

  mirrorRange(from: number, to: number): void {
    const until = Math.min(to, this.copiedUpTo)
    if (until - from === 1) this.mirrorEntry(from)
    else if (until > from) this.copyRange(from, until)
  }

  private mirrorEntry(at: number): void {
    const pool = this.pool
    this.docIds[at] = pool.docIds[at]
    this.frequencies[at] = pool.frequencies[at]
    this.fieldIndices[at] = pool.fieldIndices[at]
    if (pool.positionStarts !== null && this.positionStarts !== null) this.positionStarts[at] = pool.positionStarts[at]
  }

  byteLength(): number {
    const positionBytes = this.positionStarts === null ? 0 : this.positionStarts.byteLength
    return this.docIds.byteLength + this.frequencies.byteLength + this.fieldIndices.byteLength + positionBytes
  }

  protected usedEntries(): number {
    return this.pool.end
  }

  protected entryBytes(): number {
    const positionBytes = this.positionStarts === null ? 0 : Uint32Array.BYTES_PER_ELEMENT
    return Uint32Array.BYTES_PER_ELEMENT + Uint16Array.BYTES_PER_ELEMENT * 2 + positionBytes
  }

  protected copyRange(from: number, to: number): void {
    const pool = this.pool
    this.docIds.set(pool.docIds.subarray(from, to), from)
    this.frequencies.set(pool.frequencies.subarray(from, to), from)
    this.fieldIndices.set(pool.fieldIndices.subarray(from, to), from)
    if (pool.positionStarts !== null && this.positionStarts !== null) {
      this.positionStarts.set(pool.positionStarts.subarray(from, to), from)
    }
  }

  protected adopt(): void {
    this.pool.adoptGrownColumns(this)
  }
}

export class PositionCopy extends ScheduledCopy {
  readonly values: Uint32Array

  constructor(
    private readonly pool: PositionPool,
    capacity: number,
  ) {
    super(pool.end, pool.values.length)
    this.values = new Uint32Array(capacity)
  }

  byteLength(): number {
    return this.values.byteLength
  }

  protected usedEntries(): number {
    return this.pool.end
  }

  protected entryBytes(): number {
    return Uint32Array.BYTES_PER_ELEMENT
  }

  protected copyRange(from: number, to: number): void {
    this.values.set(this.pool.values.subarray(from, to), from)
  }

  protected adopt(): void {
    this.pool.adoptGrownValues(this.values)
  }
}
