import type { VectorIndexState } from './shared'

export interface SearchWatch {
  readonly written: Set<string>
  readonly leftBuffer: Set<string>
}

export function noteSearchedDocWritten(state: VectorIndexState, docId: string): void {
  for (const watch of state.searchWatches) watch.written.add(docId)
}

export function moveOutOfBuffer(state: VectorIndexState, docId: string): void {
  if (!state.buffer.delete(docId)) return
  for (const watch of state.searchWatches) watch.leftBuffer.add(docId)
}

export function noteBeforeWrite(state: VectorIndexState, docId: string): void {
  for (const listener of state.writeListeners) listener(docId)
}

export function writeWatchesOf(state: VectorIndexState): {
  watchWrites(listener: (docId: string) => void): () => void
} {
  return {
    watchWrites(listener) {
      state.writeListeners.add(listener)
      return () => {
        state.writeListeners.delete(listener)
      }
    },
  }
}

export async function watchingSearch<T>(
  state: VectorIndexState,
  search: (watch: SearchWatch) => Promise<T>,
): Promise<T> {
  const watch: SearchWatch = { written: new Set(), leftBuffer: new Set() }
  state.searchWatches.add(watch)
  try {
    return await search(watch)
  } finally {
    state.searchWatches.delete(watch)
  }
}
