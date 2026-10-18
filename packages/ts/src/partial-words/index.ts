import { partialWordSearchModule } from '../core/partition/partial-words/module'
import type { PartialWordSearch } from '../types/partial-words'

export type { PartialWordSearch } from '../types/partial-words'

/**
 * This object contains the partial-word search code. A browser app has to
 * pass it to {@link registerPartialWordSearch} before the app creates or
 * loads an index with a `partial` field.
 *
 * ```ts
 * import { registerPartialWordSearch } from '@delali/narsil'
 * import { partialWordSearch } from '@delali/narsil/partial-words'
 *
 * registerPartialWordSearch(partialWordSearch)
 * ```
 *
 * A Node process loads that code by itself, so only a browser app has to make
 * this call.
 *
 * @public
 */
export const partialWordSearch: PartialWordSearch = partialWordSearchModule
