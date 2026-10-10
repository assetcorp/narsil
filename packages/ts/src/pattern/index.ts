import type { PatternSearch } from '../types/pattern'
import { patternSearchModule } from './module'

export type { PatternSearch } from '../types/pattern'

/**
 * A browser app passes this object to {@link registerPatternSearch} before it
 * creates or loads an index with a pattern field.
 *
 * ```ts
 * import { registerPatternSearch } from '@delali/narsil'
 * import { patternSearch } from '@delali/narsil/pattern'
 *
 * registerPatternSearch(patternSearch)
 * ```
 *
 * A Node process loads the pattern search code by itself, so it needs no such
 * call.
 *
 * @public
 */
export const patternSearch: PatternSearch = patternSearchModule
