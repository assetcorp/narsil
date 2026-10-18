import { partialWordSearchModule } from '../core/partition/partial-words/module'
import type { PartialWordSearch } from '../types/partial-words'

export type { PartialWordSearch } from '../types/partial-words'

/**
 * This object holds the partial-word search code, which a browser app has to
 * pass to {@link registerPartialWordSearch} before it creates or loads an
 * index with a `partial` field.
 *
 * ```ts
 * import { registerPartialWordSearch } from '@delali/narsil'
 * import { partialWordSearch } from '@delali/narsil/partial-words'
 *
 * registerPartialWordSearch(partialWordSearch)
 * ```
 *
 * A Node process loads the partial-word search code by itself, so it needs no
 * such call.
 *
 * @public
 */
export const partialWordSearch: PartialWordSearch = partialWordSearchModule
