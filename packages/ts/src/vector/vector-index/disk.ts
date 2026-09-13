import { DISK_ADOPTION_YIELD_INTERVAL } from './constants'
import { type VectorIndexState, yieldToEventLoop } from './shared'
import { resendSharedHandles } from './worker-copies'

/**
 * This names the file that holds one persisted part and the byte its first
 * vector starts at.
 *
 * @internal
 */
export interface VectorPartFile {
  path: string
  vectorsOffset: number
}

/**
 * This names the vectors a checkpoint wrote to one file, in the order the
 * file holds them, so that a field kept on disk can point its ordinals at
 * them.
 *
 * @internal
 */
export interface VectorFileLayout extends VectorPartFile {
  docIds: string[]
}

/**
 * This names where a checkpoint file holds one document's vector, which a
 * field keeps for each vector it still holds in memory while it holds no
 * graph.
 *
 * @internal
 */
export interface PendingVectorLocation {
  path: string
  offset: number
}

/**
 * Reports whether the field keeps its vectors on disk, which a field
 * configured for disk storage does.
 *
 * @param state The index to ask about.
 *
 * @internal
 */
export function readsFromDisk(state: VectorIndexState): boolean {
  return state.storage === 'disk'
}

/**
 * Reports whether the field keeps its checkpointed vectors on disk now, which
 * a field kept on disk does once it holds a graph. Until then it holds every
 * vector in memory, because a search below the promotion threshold scans
 * every vector.
 *
 * @param state The index to ask about.
 *
 * @internal
 */
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

/**
 * Points every ordinal whose document the layout names at its place in the
 * file and drops each block those ordinals emptied. It yields to the event
 * loop between runs of ordinals, because pointing a hot ordinal at the file
 * reads the file once to verify it. It sends the new layout to every thread
 * holding the field before it returns, so a caller may delete the files the
 * field read before only after this settles. A field holding no graph keeps
 * each vector's place instead and points the ordinals at the file once it
 * builds one.
 *
 * @internal
 */
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

/**
 * Points every ordinal whose place a checkpoint recorded while the field held
 * no graph at that place, which the field does once it holds one.
 *
 * @internal
 */
export async function releasePendingLocations(state: VectorIndexState): Promise<void> {
  if (state.pendingLocations.size === 0 || !holdsVectorsOnDisk(state) || state.disposed) return
  const pending = [...state.pendingLocations]
  state.pendingLocations.clear()
  await releaseLocations(state, pending)
}
