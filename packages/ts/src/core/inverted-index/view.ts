import type { PostingListView } from '../../types/internal'
import type { LivePostings } from './postings'
import { TERM_ORDERED, TERM_POSITIONS } from './terms'

const NO_TOMBSTONES: PostingListView['deletedDocs'] = { size: 0, has: () => false }
const NO_DOCUMENT_IDS = new Uint32Array(0)
const NO_FREQUENCIES = new Uint16Array(0)
const DETACHED = -1

export class LivePostingView implements PostingListView {
  readonly docIdSet: { readonly size: number }
  private readonly retiredRows: PostingListView['deletedDocs']
  private ordinal: number
  private generation: number
  private syncedEpoch = -1
  private syncedStart = -1
  private syncedLength = 0
  private syncedRevision = -1
  private ids: Uint32Array = NO_DOCUMENT_IDS
  private frequencies: Uint16Array = NO_FREQUENCIES
  private fields: Uint16Array = NO_FREQUENCIES
  private materialized: Array<readonly number[]> | null = null

  constructor(
    private readonly store: LivePostings,
    private readonly token: string,
    ordinal: number,
    private readonly keepsPositions: boolean,
  ) {
    this.ordinal = ordinal
    this.generation = store.terms.generation
    const view = this
    this.docIdSet = {
      get size(): number {
        const live = view.sync()
        return live === DETACHED ? 0 : view.store.terms.docFrequency[live]
      },
    }
    this.retiredRows = {
      get size(): number {
        const live = view.sync()
        return live === DETACHED ? 0 : view.store.terms.deadDocuments[live]
      },
      has: (internalId: number): boolean => store.isRetired(internalId),
    }
  }

  get length(): number {
    this.sync()
    return this.syncedLength
  }

  get docIds(): Uint32Array {
    this.sync()
    return this.ids
  }

  get termFrequencies(): Uint16Array {
    this.sync()
    return this.frequencies
  }

  get fieldNameIndices(): Uint16Array {
    this.sync()
    return this.fields
  }

  get holdsPositions(): boolean {
    const live = this.sync()
    return live !== DETACHED && (this.store.terms.flags[live] & TERM_POSITIONS) !== 0
  }

  get positions(): ReadonlyArray<readonly number[]> | null {
    if (!this.holdsPositions) return null
    if (this.materialized !== null) return this.materialized
    const starts = this.store.pool.positionStarts
    const rows: Array<readonly number[]> = new Array(this.syncedLength)
    for (let row = 0; row < this.syncedLength; row++) {
      rows[row] = starts === null ? [] : this.store.positions.read(starts[this.syncedStart + row])
    }
    if (this.keepsPositions) this.materialized = rows
    return rows
  }

  positionCountAt(row: number): number {
    if (!this.holdsPositions) return 0
    const starts = this.store.pool.positionStarts
    return starts === null ? 0 : this.store.positions.countAt(starts[this.syncedStart + row])
  }

  copyPositionsAt(row: number, target: Uint32Array, offset: number): number {
    if (!this.holdsPositions) return 0
    const starts = this.store.pool.positionStarts
    return starts === null ? 0 : this.store.positions.copyInto(starts[this.syncedStart + row], target, offset)
  }

  get deletedDocs(): PostingListView['deletedDocs'] {
    const live = this.sync()
    if (live === DETACHED || this.store.terms.deadDocuments[live] === 0) return NO_TOMBSTONES
    return this.retiredRows
  }

  get totalTermFrequency(): number {
    const live = this.sync()
    return live === DETACHED ? 0 : this.store.terms.totalTermFrequency[live]
  }

  get structureRevision(): number {
    const live = this.sync()
    return live === DETACHED ? this.syncedRevision : this.store.terms.revision[live]
  }

  get ordered(): boolean {
    const live = this.sync()
    return live === DETACHED || (this.store.terms.flags[live] & TERM_ORDERED) !== 0
  }

  private sync(): number {
    const terms = this.store.terms
    if (this.generation !== terms.generation) {
      this.ordinal = terms.ids.get(this.token) ?? DETACHED
      this.generation = terms.generation
    }
    const ordinal = this.ordinal
    if (ordinal === DETACHED || !terms.isLive(ordinal)) {
      this.detach()
      return DETACHED
    }
    const pool = this.store.pool
    const start = terms.sliceStart[ordinal]
    const length = terms.lengths[ordinal]
    const revision = terms.revision[ordinal]
    if (
      pool.epoch !== this.syncedEpoch ||
      start !== this.syncedStart ||
      length !== this.syncedLength ||
      revision !== this.syncedRevision
    ) {
      this.ids = pool.docIds.subarray(start, start + length)
      this.frequencies = pool.frequencies.subarray(start, start + length)
      this.fields = pool.fieldIndices.subarray(start, start + length)
      this.materialized = null
      this.syncedEpoch = pool.epoch
      this.syncedStart = start
      this.syncedLength = length
      this.syncedRevision = revision
    }
    return ordinal
  }

  private detach(): void {
    if (this.syncedStart === DETACHED && this.syncedLength === 0) return
    this.ids = NO_DOCUMENT_IDS
    this.frequencies = NO_FREQUENCIES
    this.fields = NO_FREQUENCIES
    this.materialized = null
    this.syncedStart = DETACHED
    this.syncedLength = 0
    this.syncedEpoch = -1
  }
}
