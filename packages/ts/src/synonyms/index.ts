import { synonymSearchModule } from '../core/synonyms/module'
import type { SynonymSearch } from '../types/synonyms'

export type { SynonymSearch } from '../types/synonyms'

/**
 * This object contains the synonym code. A browser app has to pass it to
 * {@link registerSynonyms} before the app creates or loads an index that
 * holds a synonym set.
 *
 * ```ts
 * import { registerSynonyms } from '@delali/narsil'
 * import { synonyms } from '@delali/narsil/synonyms'
 *
 * registerSynonyms(synonyms)
 * ```
 *
 * A Node process loads that code by itself, so only a browser app has to make
 * this call.
 *
 * @public
 */
export const synonyms: SynonymSearch = synonymSearchModule
