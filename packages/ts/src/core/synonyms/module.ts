import { applyLoadedSynonyms, replaceSynonymSet } from './operations'
import { prepareSynonyms, storedSynonymLookup, storedSynonymRules } from './prepare'
import type { SynonymSearchModule } from './types'

export const synonymSearchModule: SynonymSearchModule = {
  name: 'synonyms',
  prepare: prepareSynonyms,
  storedLookup: storedSynonymLookup,
  decodeRules: storedSynonymRules,
  replace: replaceSynonymSet,
  applyLoaded: applyLoadedSynonyms,
}
