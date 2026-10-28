import { combinePostingLists } from './combined-postings'
import { expandQuerySynonyms } from './expand'
import { buildSynonymLookup } from './lookup'
import { decodeSynonymRules, encodeSynonymRules, parseSynonymRules } from './rules'
import type { SynonymSearchModule } from './types'

export const synonymSearchModule: SynonymSearchModule = {
  name: 'synonyms',
  buildLookup: buildSynonymLookup,
  expandQuery: expandQuerySynonyms,
  combinePostings: combinePostingLists,
  parseRules: parseSynonymRules,
  encodeRules: encodeSynonymRules,
  decodeRules: decodeSynonymRules,
}
