import { combinePostingLists } from './combined-postings'
import { expandQuerySynonyms } from './expand'
import { buildSynonymLookup } from './lookup'
import type { SynonymSearchModule } from './types'

export const synonymSearchModule: SynonymSearchModule = {
  name: 'synonyms',
  buildLookup: buildSynonymLookup,
  expandQuery: expandQuerySynonyms,
  combinePostings: combinePostingLists,
}
