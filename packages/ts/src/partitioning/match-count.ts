import { type FulltextSearchOptions, fulltextMatches } from '../search/fulltext'
import type { LanguageModule } from '../types/language'
import type { SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'
import type { PartitionManager } from './manager'
import { partitionsIn } from './partition-selection'

/**
 * Reports whether a full-text query's match count is independent of its
 * scoring pass. A `minScore` floor prunes matches by score, and a `termMatch`
 * policy other than `any` prunes them by term coverage, which only the scoring
 * pass records, so a query carrying either one keeps the scored path.
 */
export function countsWithoutScores(params: QueryParams): boolean {
  return params.minScore === undefined && (params.termMatch === undefined || params.termMatch === 'any')
}

export interface MatchCountOptions {
  searchOptions?: FulltextSearchOptions
  partitionIds?: number[]
}

/**
 * Counts the documents a full-text query matches across partitions without
 * computing a single relevance score. Each partition walks its postings once
 * into a match bitset, and the counts sum, so the cost is the postings walk
 * alone.
 */
export function fanOutMatchCount(
  manager: PartitionManager,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options?: MatchCountOptions,
): number {
  let count = 0
  for (const partition of partitionsIn(manager, options?.partitionIds)) {
    const matches = fulltextMatches(partition, params, language, schema, options?.searchOptions)
    if (matches !== null) count += matches.count
  }
  return count
}
