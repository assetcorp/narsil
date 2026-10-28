import { applyPartitionFiltersBitset } from '../../core/partition/filters'
import type { PatternWorkMeter } from '../../core/pattern-index/types'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import type { FilterExpression } from '../../types/filters'
import type { IndexConfig } from '../../types/schema'
import { MAX_RENUMBERED_SEARCH_ATTEMPTS } from '../../vector/constants'
import type { FilterSubset } from '../../vector/filter-ordinals'
import { partitionsFor } from './shared'

export function collectFilterSubsets(
  manager: PartitionManager,
  filters: FilterExpression,
  schema: IndexConfig['schema'],
  partitionIds: number[] | undefined,
  patternWork: PatternWorkMeter,
): FilterSubset[] {
  const subsets: FilterSubset[] = []
  for (const partition of partitionsFor(manager, partitionIds)) {
    for (const state of partition.readStates()) {
      subsets.push({
        owner: state,
        bits: applyPartitionFiltersBitset(state, filters, schema, patternWork),
        numberingGeneration: state.docStore.numberingGeneration(),
      })
    }
  }
  return subsets
}

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
