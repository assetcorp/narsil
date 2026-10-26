import { expandPartialWords } from './expansion'
import { createFrozenPartialWordSlot } from './frozen-slot'
import { buildPartialWordTable } from './frozen-table'
import { createGrowingPartialWordSlot } from './growing-slot'
import { partialWordMatcher } from './highlight'
import { addPartialWordMembers, partialWordsToHighlight } from './query'
import { countSpelling, encodePartialSpellings, spellingCountsOf } from './spellings'
import type { PartialWordSearchModule } from './types'

export const partialWordSearchModule: PartialWordSearchModule = {
  name: 'partialWords',
  createGrowingSlot: createGrowingPartialWordSlot,
  createFrozenSlot: createFrozenPartialWordSlot,
  buildTable: buildPartialWordTable,
  expand: expandPartialWords,
  countSpelling,
  encodeSpellings: encodePartialSpellings,
  spellingCountsOf,
  highlightMatcher: partialWordMatcher,
  addTermMembers: addPartialWordMembers,
  highlightWords: partialWordsToHighlight,
}
