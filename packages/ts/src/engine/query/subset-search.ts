import { ErrorCodes, NarsilError } from '../../errors'
import { MAX_RENUMBERED_SEARCH_ATTEMPTS } from '../../vector/constants'
import type { FilterSubset } from '../../vector/filter-ordinals'

export function filterSubsetsMatchNothing(subsets: readonly FilterSubset[]): boolean {
  for (const subset of subsets) {
    for (let wordIndex = 0; wordIndex < subset.bits.length; wordIndex++) {
      if (subset.bits[wordIndex] !== 0) return false
    }
  }
  return true
}

function filterSubsetsRenumbered(subsets: readonly FilterSubset[]): boolean {
  return subsets.some(subset => subset.owner.docStore.numberingGeneration() !== subset.numberingGeneration)
}

export async function searchCurrentSubsets<T>(
  fieldName: string,
  first: FilterSubset[],
  collectAgain: () => FilterSubset[],
  search: (subsets: readonly FilterSubset[]) => Promise<T>,
): Promise<T> {
  let subsets = first
  for (let attempt = 1; ; attempt++) {
    const answer = await search(subsets)
    if (!filterSubsetsRenumbered(subsets)) return answer
    if (attempt >= MAX_RENUMBERED_SEARCH_ATTEMPTS) {
      throw new NarsilError(
        ErrorCodes.WORKER_BUSY,
        `The index renumbered its documents during each of ${attempt} filtered searches of vector field "${fieldName}"`,
        { fieldName, attempts: attempt },
      )
    }
    subsets = collectAgain()
  }
}
