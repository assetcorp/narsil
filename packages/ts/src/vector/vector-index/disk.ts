import { DISK_ADOPTION_YIELD_INTERVAL } from './constants'
import { type VectorIndexState, yieldToEventLoop } from './shared'
import { resendSharedHandles } from './worker-copies'

export interface VectorPartFile {
  path: string
  vectorsOffset: number
}

export interface VectorFileLayout extends VectorPartFile {
  docIds: string[]
}

export interface PendingVectorLocation {
  path: string
  offset: number
}

export function readsFromDisk(state: VectorIndexState): boolean {
  return state.storage === 'disk'
}

export function holdsVectorsOnDisk(state: VectorIndexState): boolean {
  return readsFromDisk(state) && state.hnsw !== null
}

function* locationsOf(
  state: VectorIndexState,
  layout: VectorFileLayout,
): IterableIterator<[string, PendingVectorLocation]> {
  const stride = state.dimension * 4
  for (let i = 0; i < layout.docIds.length; i++) {
    yield [layout.docIds[i], { path: layout.path, offset: layout.vectorsOffset + i * stride }]
  }
}

async function releaseLocations(
  state: VectorIndexState,
  locations: Iterable<[string, PendingVectorLocation]>,
): Promise<void> {
  const fileIndexes = new Map<string, number>()
  let count = 0
  for (const [docId, location] of locations) {
    if (count > 0 && count % DISK_ADOPTION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
      if (state.disposed) return
    }
    count += 1
    const ordinal = state.store.getOrdinal(docId)
    if (ordinal === undefined) continue
    let fileIndex = fileIndexes.get(location.path)
    if (fileIndex === undefined) {
      fileIndex = state.store.addVectorFile(location.path)
      fileIndexes.set(location.path, fileIndex)
    }
    state.store.releaseToFile(ordinal, { fileIndex, offset: location.offset })
  }
  state.store.releaseColdBlocks()
  await resendSharedHandles(state)
}

export async function adoptDiskLayout(state: VectorIndexState, layout: VectorFileLayout): Promise<void> {
  if (!readsFromDisk(state) || state.disposed || layout.docIds.length === 0) return
  if (!holdsVectorsOnDisk(state)) {
    for (const [docId, location] of locationsOf(state, layout)) {
      if (state.store.has(docId)) state.pendingLocations.set(docId, location)
    }
    return
  }
  await releaseLocations(state, locationsOf(state, layout))
}

export async function releasePendingLocations(state: VectorIndexState): Promise<void> {
  if (state.pendingLocations.size === 0 || !holdsVectorsOnDisk(state) || state.disposed) return
  const pending = [...state.pendingLocations]
  state.pendingLocations.clear()
  await releaseLocations(state, pending)
}
