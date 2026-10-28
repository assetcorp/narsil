import { platformSynonymSearch } from '#platform/synonym-search'
import { ErrorCodes, NarsilError } from '../../errors'
import type { SynonymSearch } from '../../types/synonyms'
import type { SynonymSearchModule } from './types'

let registered: SynonymSearchModule | null = null

const MODULE_FUNCTIONS = ['prepare', 'storedLookup', 'decodeRules', 'replace', 'applyLoaded'] as const

function isSynonymSearchModule(value: SynonymSearch): value is SynonymSearchModule {
  if (value === null || typeof value !== 'object' || value.name !== 'synonyms') return false
  return MODULE_FUNCTIONS.every(name => typeof Reflect.get(value, name) === 'function')
}

/**
 * Call this to give the engine its synonym code, so that it can create and
 * load an index that holds a synonym set.
 *
 * A Node process loads that code by itself, so only a browser app has to make
 * this call. In a browser, import `synonyms` from `@delali/narsil/synonyms` and
 * pass it here before the app creates or loads an index with a synonym set.
 *
 * @param module - Pass the `synonyms` object that `@delali/narsil/synonyms`
 * exports.
 * @throws The engine throws a `NarsilError` with `CONFIG_INVALID` for any
 * other object.
 *
 * @public
 */
export function registerSynonyms(module: SynonymSearch): void {
  if (!isSynonymSearchModule(module)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Pass registerSynonyms the synonyms object that "@delali/narsil/synonyms" exports',
    )
  }
  registered = module
}

export function availableSynonymModule(): SynonymSearchModule | null {
  return registered ?? platformSynonymSearch()
}

export function synonymModule(): SynonymSearchModule {
  const module = availableSynonymModule()
  if (module !== null) return module
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    "This bundle holds no synonym code, so import { synonyms } from '@delali/narsil/synonyms' and pass it to registerSynonyms before you use a synonym set",
  )
}

export function isEmptySynonymSet(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0)
}
