import { UNPLACED_FLAG_CHUNK_ORDINALS } from '../constants'
import type { GrowableBuffer } from '../shared-buffers/growable'
import type { VectorStore } from '../vector-store'
import { type SharedVectorStoreHandles, STORE_REMOVED_COUNT, STORE_UNPLACED_COUNT } from '../vector-store/handles'

interface FlagLayout {
  flagsOf(handles: SharedVectorStoreHandles): GrowableBuffer
  chunksOf: ((handles: SharedVectorStoreHandles) => GrowableBuffer) | null
  countWord: number
}

class FlaggedDocuments extends Set<string> {
  private readonly ordinals = new Map<string, number>()
  private handles: SharedVectorStoreHandles | null = null
  private flags: Uint8Array = new Uint8Array(0)
  private chunks: Int32Array | null = null

  constructor(
    private readonly store: VectorStore,
    private readonly layout: FlagLayout,
  ) {
    super()
  }

  override add(docId: string): this {
    super.add(docId)
    const handles = this.openHandles()
    if (handles === null) return this
    this.flagCurrentOrdinal(docId)
    Atomics.store(handles.header, this.layout.countWord, this.size)
    return this
  }

  override delete(docId: string): boolean {
    const held = super.delete(docId)
    const handles = this.openHandles()
    if (handles === null) return held
    const ordinal = this.ordinals.get(docId)
    if (ordinal !== undefined) {
      this.ordinals.delete(docId)
      this.unflag(ordinal)
    }
    Atomics.store(handles.header, this.layout.countWord, this.size)
    return held
  }

  override clear(): void {
    super.clear()
    const handles = this.openHandles()
    if (handles !== null) {
      for (const ordinal of this.ordinals.values()) this.unflag(ordinal)
      Atomics.store(handles.header, this.layout.countWord, 0)
    }
    this.ordinals.clear()
  }

  private flagCurrentOrdinal(docId: string): void {
    const ordinal = this.store.getOrdinal(docId)
    const previous = this.ordinals.get(docId)
    if (ordinal === undefined || ordinal === previous) return
    if (this.chunks !== null) Atomics.add(this.chunks, Math.floor(ordinal / UNPLACED_FLAG_CHUNK_ORDINALS), 1)
    Atomics.store(this.flags, ordinal, 1)
    this.ordinals.set(docId, ordinal)
    if (previous !== undefined) this.unflag(previous)
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
    for (const docId of this) this.flagCurrentOrdinal(docId)
    return handles
  }
}

export function createUnplacedVectors(store: VectorStore): Set<string> {
  return new FlaggedDocuments(store, {
    flagsOf: handles => handles.unplaced,
    chunksOf: handles => handles.unplacedChunks,
    countWord: STORE_UNPLACED_COUNT,
  })
}

export function createRemovedDocuments(store: VectorStore): Set<string> {
  return new FlaggedDocuments(store, {
    flagsOf: handles => handles.removed,
    chunksOf: null,
    countWord: STORE_REMOVED_COUNT,
  })
}
