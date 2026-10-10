import { platformPatternSearch } from '#platform/pattern-search'
import { ErrorCodes, NarsilError } from '../../errors'
import { schemaFieldsOf } from '../../schema/validator/schema'
import type { PatternSearch } from '../../types/pattern'
import type { SchemaDefinition } from '../../types/schema'
import type { PatternSearchModule } from './types'

let registered: PatternSearchModule | null = null

function isPatternSearchModule(value: PatternSearch): value is PatternSearchModule {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.name === 'pattern' &&
    'createIndex' in value &&
    typeof value.createIndex === 'function' &&
    'readArrays' in value &&
    typeof value.readArrays === 'function' &&
    'mergeArrays' in value &&
    typeof value.mergeArrays === 'function' &&
    'matchBitset' in value &&
    typeof value.matchBitset === 'function'
  )
}

/**
 * Makes pattern search available to every index that declares a pattern field.
 *
 * A Node process needs no call, because it loads the pattern search code by
 * itself. A browser app imports `patternSearch` from `@delali/narsil/pattern`
 * and registers it before it creates or loads an index whose schema holds a
 * `verbatim` field or a text field whose type includes `pattern`.
 *
 * @param module - The `patternSearch` object that `@delali/narsil/pattern`
 * exports.
 * @throws A `NarsilError` with `CONFIG_INVALID` for any other object.
 *
 * @public
 */
export function registerPatternSearch(module: PatternSearch): void {
  if (!isPatternSearchModule(module)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'registerPatternSearch takes the patternSearch object that "@delali/narsil/pattern" exports',
    )
  }
  registered = module
}

export function availablePatternSearch(): PatternSearchModule | null {
  return registered ?? platformPatternSearch()
}

export function requirePatternSearchFor(schema: SchemaDefinition): void {
  for (const { path, pattern } of schemaFieldsOf(schema)) {
    if (pattern) requirePatternSearch(path)
  }
}

export function requirePatternSearch(fieldPath: string): PatternSearchModule {
  const module = availablePatternSearch()
  if (module !== null) return module
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `Field "${fieldPath}" is a pattern field, but this bundle contains no pattern search code. Add import { patternSearch } from '@delali/narsil/pattern', then call registerPatternSearch(patternSearch) before you create or load the index`,
    { field: fieldPath },
  )
}
