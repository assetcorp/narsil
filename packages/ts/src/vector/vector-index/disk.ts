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
 * Reports whether the field reads its vectors from checkpoint files, which
 * a field kept on disk does from the first checkpoint that writes them.
 *
 * @param state The index to ask about.
 *
 * @internal
 */
export function readsFromDisk(state: VectorIndexState): boolean {
  return state.storage === 'disk'
}

/**
 * Points every ordinal whose document the layout names at its place in the
 * file and drops each block those ordinals emptied. It yields to the event
 * loop between runs of ordinals, because pointing a hot ordinal at the file
 * reads the file once to verify it. It sends the new layout to every thread
 * holding the field before it returns, so a caller may delete the files the
 * field read before only after this settles.
 *
 * @internal
 */
export async function adoptDiskLayout(state: VectorIndexState, layout: VectorFileLayout): Promise<void> {
  if (!readsFromDisk(state) || state.disposed || layout.docIds.length === 0) return
  const fileIndex = state.store.addVectorFile(layout.path)
  const stride = state.dimension * 4
  for (let i = 0; i < layout.docIds.length; i++) {
    if (i > 0 && i % DISK_ADOPTION_YIELD_INTERVAL === 0) {
      await yieldToEventLoop()
      if (state.disposed) return
    }
    const ordinal = state.store.getOrdinal(layout.docIds[i])
    if (ordinal === undefined) continue
    state.store.releaseToFile(ordinal, { fileIndex, offset: layout.vectorsOffset + i * stride })
  }
  state.store.releaseColdBlocks()
  await resendSharedHandles(state)
}
