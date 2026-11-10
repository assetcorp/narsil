import { applyPartitionFiltersBitset } from '../../core/partition/filters'
import type { PatternWorkMeter } from '../../core/pattern-index/types'
import type { PartitionManager } from '../../partitioning/manager'
import type { FilterExpression } from '../../types/filters'
import type { IndexConfig } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import type { FilterSubset } from '../../vector/ordinal-filter'
import { partitionsFor, type SearchContext } from './shared'

export interface FilteredSearch {
  readonly filters: FilterExpression
  readonly first: FilterSubset[]
  readonly collectAgain: () => FilterSubset[]
}

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

export function filteredSearchOf(params: QueryParams, context: SearchContext): FilteredSearch | undefined {
  const filters = params.filters
  if (!filters) return undefined
  const { manager, config, partitionIds, patternWork } = context
  const collectAgain = () => collectFilterSubsets(manager, filters, config.schema, partitionIds, patternWork)
  return { filters, first: collectAgain(), collectAgain }
}
