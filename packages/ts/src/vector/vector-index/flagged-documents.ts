import {
  createDocIdMap,
  STORE_REMOVED_COUNT,
  STORE_UNPLACED_COUNT,
  UNPLACED_FLAG_CHUNK_ORDINALS,
} from '#platform/vector-host'
import type { DocIdSet } from '../../core/doc-id-tables/types'
import type { GrowableBuffer } from '../shared-buffers/growable'
import type { VectorStore } from '../vector-store'
import type { SharedVectorStoreHandles } from '../vector-store/handles'

interface FlagLayout {
  flagsOf(handles: SharedVectorStoreHandles): GrowableBuffer
  chunksOf: ((handles: SharedVectorStoreHandles) => GrowableBuffer) | null
  countWord: number
  keepsRetiredFlags: boolean
}

export interface UnplacedVectors extends DocIdSet {
  retire(docId: string): boolean
  readonly retiredCount: number
  forgetRetired(mayForget: (ordinal: number) => boolean): void
}

class FlaggedDocuments implements UnplacedVectors {
  private readonly members = createDocIdMap<true>()
  private readonly ordinals = createDocIdMap<number>()
  private readonly retired = new Set<number>()
  private handles: SharedVectorStoreHandles | null = null
  private flags: Uint8Array = new Uint8Array(0)
  private chunks: Int32Array | null = null

  constructor(
    private readonly store: VectorStore,
    private readonly layout: FlagLayout,
  ) {}

  get size(): number {
    return this.members.size
  }

  get retiredCount(): number {
    return this.retired.size
  }

  has(docId: string): boolean {
    return this.members.has(docId)
  }

  [Symbol.iterator](): Iterator<string> {
    return this.members.keys()[Symbol.iterator]()
  }

  add(docId: string): this {
    this.members.set(docId, true)
    const handles = this.openHandles()
    if (handles === null) return this
    this.flagCurrentOrdinal(docId)
    this.publishCount(handles)
    return this
  }

  delete(docId: string): boolean {
    return this.leave(docId, false)
  }

  retire(docId: string): boolean {
    return this.leave(docId, this.layout.keepsRetiredFlags)
  }

  forgetRetired(mayForget: (ordinal: number) => boolean): void {
    if (this.retired.size === 0) return
    const handles = this.openHandles()
    if (handles === null) return
    for (const ordinal of this.retired) {
      if (!mayForget(ordinal)) continue
      this.retired.delete(ordinal)
      this.unflag(ordinal)
    }
    this.publishCount(handles)
  }

  clear(): void {
    this.members.clear()
    const handles = this.openHandles()
    if (handles !== null) {
      for (const ordinal of this.ordinals.values()) this.unflag(ordinal)
      for (const ordinal of this.retired) this.unflag(ordinal)
      Atomics.store(handles.header, this.layout.countWord, 0)
    }
    this.ordinals.clear()
    this.retired.clear()
  }

  private leave(docId: string, keepsFlag: boolean): boolean {
    const held = this.members.delete(docId)
    const store = this.store
    if (!held && this.handles !== null && store.dimension !== 0 && store.handles === this.handles) {
      if (!this.ordinals.has(docId)) return false
    }
    const handles = this.openHandles()
    if (handles === null) return held
    const ordinal = this.ordinals.get(docId)
    if (ordinal !== undefined) {
      this.ordinals.delete(docId)
      if (keepsFlag) this.retired.add(ordinal)
      else this.unflag(ordinal)
    }
    Atomics.store(handles.header, this.layout.countWord, this.members.size + this.retired.size)
    return held
  }

  private publishCount(handles: SharedVectorStoreHandles): void {
    Atomics.store(handles.header, this.layout.countWord, this.members.size + this.retired.size)
  }

  private flagCurrentOrdinal(docId: string): void {
    const ordinal = this.store.getOrdinal(docId)
    const previous = this.ordinals.get(docId)
    if (ordinal === undefined || ordinal === previous) return
    if (this.chunks !== null) Atomics.add(this.chunks, Math.floor(ordinal / UNPLACED_FLAG_CHUNK_ORDINALS), 1)
    Atomics.store(this.flags, ordinal, 1)
    this.ordinals.set(docId, ordinal)
    if (previous === undefined) return
    if (this.layout.keepsRetiredFlags) this.retired.add(previous)
    else this.unflag(previous)
  }

  private unflag(ordinal: number): void {
    Atomics.store(this.flags, ordinal, 0)
    if (this.chunks !== null) Atomics.sub(this.chunks, Math.floor(ordinal / UNPLACED_FLAG_CHUNK_ORDINALS), 1)
  }

  private openHandles(): SharedVectorStoreHandles | null {
    if (this.store.dimension === 0) return null
    const handles = this.store.handles
    if (handles === this.handles) return handles
    this.handles = handles
    this.flags = new Uint8Array(this.layout.flagsOf(handles))
    const chunksOf = this.layout.chunksOf
    this.chunks = chunksOf === null ? null : new Int32Array(chunksOf(handles))
    this.ordinals.clear()
    this.retired.clear()
    for (const docId of this.members.keys()) this.flagCurrentOrdinal(docId)
    return handles
  }
}

export function createUnplacedVectors(store: VectorStore): UnplacedVectors {
  return new FlaggedDocuments(store, {
    flagsOf: handles => handles.unplaced,
    chunksOf: handles => handles.unplacedChunks,
    countWord: STORE_UNPLACED_COUNT,
    keepsRetiredFlags: true,
  })
}

export function createRemovedDocuments(store: VectorStore): DocIdSet {
  return new FlaggedDocuments(store, {
    flagsOf: handles => handles.removed,
    chunksOf: null,
    countWord: STORE_REMOVED_COUNT,
    keepsRetiredFlags: false,
  })
}
