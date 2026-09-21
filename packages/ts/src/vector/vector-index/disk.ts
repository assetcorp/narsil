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

async function shareFilesWithEveryThread(
  state: VectorIndexState,
  paths: Iterable<string>,
): Promise<Map<string, number>> {
  const fileIndexes = new Map<string, number>()
  for (const path of paths) fileIndexes.set(path, state.store.addVectorFile(path))
  await resendSharedHandles(state)
  return fileIndexes
}

async function releaseLocations(
  state: VectorIndexState,
  paths: Iterable<string>,
  locations: Iterable<[string, PendingVectorLocation]>,
): Promise<void> {
  const fileIndexes = await shareFilesWithEveryThread(state, paths)
  if (state.disposed) return
  let count = 0
  for (const [docId, location] of locations) {
    if (count > 0 && count % DISK_ADOPTION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
      if (state.disposed) return
    }
    count += 1
    const ordinal = state.store.getOrdinal(docId)
    const fileIndex = fileIndexes.get(location.path)
    if (ordinal === undefined || fileIndex === undefined) continue
    state.store.releaseToFile(ordinal, { fileIndex, offset: location.offset })
  }
  state.store.releaseColdBlocks()
  await resendSharedHandles(state)
}

function releaseInTurn(state: VectorIndexState, release: () => Promise<void>): Promise<void> {
  const run = state.releaseToFilesInFlight.then(release)
  state.releaseToFilesInFlight = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function adoptDiskLayout(state: VectorIndexState, layout: VectorFileLayout): Promise<void> {
  if (!readsFromDisk(state) || state.disposed || layout.docIds.length === 0) return
  if (!holdsVectorsOnDisk(state)) {
    for (const [docId, location] of locationsOf(state, layout)) {
      if (state.store.has(docId)) state.pendingLocations.set(docId, location)
    }
    return
  }
  await releaseInTurn(state, () => releaseLocations(state, [layout.path], locationsOf(state, layout)))
}

export async function releasePendingLocations(state: VectorIndexState): Promise<void> {
  if (state.pendingLocations.size === 0 || !holdsVectorsOnDisk(state) || state.disposed) return
  const pending = [...state.pendingLocations]
  state.pendingLocations.clear()
  const paths = new Set(pending.map(([, location]) => location.path))
  await releaseInTurn(state, () => releaseLocations(state, paths, pending))
}
