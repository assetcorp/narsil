import { filteredSearchOf } from './filter-subsets'
import { partitionsForVectorSearch, resolveVectorIndex, vectorResultsToScored } from './shared'
import { textLeg } from './text-leg'

export interface VectorQueryHost {
  readonly textLeg: typeof textLeg
  readonly filteredSearchOf: typeof filteredSearchOf
  readonly partitionsForVectorSearch: typeof partitionsForVectorSearch
  readonly resolveVectorIndex: typeof resolveVectorIndex
  readonly vectorResultsToScored: typeof vectorResultsToScored
}

export const vectorQueryHost: VectorQueryHost = {
  textLeg,
  filteredSearchOf,
  partitionsForVectorSearch,
  resolveVectorIndex,
  vectorResultsToScored,
}
