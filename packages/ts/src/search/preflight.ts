import type { PartitionIndex } from '../core/partition'
import type { LanguageModule } from '../types/language'
import type { PreflightResult } from '../types/results'
import type { SchemaDefinition } from '../types/schema'
import type { QueryParams } from '../types/search'
import type { FulltextSearchOptions } from './fulltext'
import { fulltextSearch } from './fulltext'

function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export function preflightSearch(
  partition: PartitionIndex,
  params: QueryParams,
  language: LanguageModule,
  schema: SchemaDefinition,
  options?: FulltextSearchOptions,
): PreflightResult {
  const startTime = now()
  const result = fulltextSearch(partition, params, language, schema, options)
  const elapsed = now() - startTime

  return { count: result.totalMatched, elapsed }
}
