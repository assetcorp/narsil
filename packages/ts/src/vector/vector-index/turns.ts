import { backgroundTurnIsSpent, yieldBackgroundTurn } from '#platform/shared-turns'
import { shuffleStep } from '../hnsw/insertion-order'
import { BUILD_STEPS_BETWEEN_CLOCK_CHECKS } from './constants'
import { allLiveDocIds, type VectorIndexState } from './shared'

function turnDue(steps: number): boolean {
  return steps % BUILD_STEPS_BETWEEN_CLOCK_CHECKS === 0 && backgroundTurnIsSpent()
}

export async function forEachInTurns<T>(
  items: Iterable<T>,
  visit: (item: T) => void,
  stillWanted: () => boolean,
): Promise<boolean> {
  let steps = 0
  for (const item of items) {
    steps += 1
    if (turnDue(steps)) {
      await yieldBackgroundTurn()
      if (!stillWanted()) return false
    }
    visit(item)
  }
  return true
}

export async function copyInTurns<T>(items: Iterable<T>, stillWanted: () => boolean): Promise<T[] | null> {
  const copied: T[] = []
  const finished = await forEachInTurns(items, item => copied.push(item), stillWanted)
  return finished ? copied : null
}

export async function shuffledLiveDocIdsInTurns(state: VectorIndexState): Promise<string[] | null> {
  const stillWanted = (): boolean => !state.disposed
  const docIds = await copyInTurns(allLiveDocIds(state), stillWanted)
  if (docIds === null) return null
  let stream = docIds.length
  for (let i = docIds.length - 1; i > 0; i--) {
    stream = shuffleStep(docIds, i, stream)
    if (turnDue(i)) {
      await yieldBackgroundTurn()
      if (!stillWanted()) return null
    }
  }
  return docIds
}

export async function liveOrdinalsInTurns(state: VectorIndexState): Promise<Int32Array | null> {
  const ordinals: number[] = []
  for (let ordinal = 0; ordinal < state.store.slots; ordinal++) {
    if (turnDue(ordinal + 1)) {
      await yieldBackgroundTurn()
      if (state.disposed) return null
    }
    const docId = state.store.docIdForOrdinal(ordinal)
    if (docId !== undefined && !state.tombstones.has(docId)) ordinals.push(ordinal)
  }
  return Int32Array.from(ordinals)
}
