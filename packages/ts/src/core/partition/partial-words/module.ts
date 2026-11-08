import { bindPartialExpansionCode } from '../../expansion/partial-bindings'
import { collectRuns, prepareRunRemoval, RunPlan } from '../../segment-writes/runs'
import { SpellingTable } from '../../segment-writes/spelling-table'
import { RunVacuum } from '../../segment-writes/vacuum-runs'
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
  bindExpansionCode: bindPartialExpansionCode,
  createSpellingTable: () => new SpellingTable(),
  prepareSpellingRuns(table, plan) {
    const runs = new RunPlan(table, collectRuns(plan))
    return () => runs.publish()
  },
  prepareSpellingRemoval(table, plan) {
    return prepareRunRemoval(table, collectRuns(plan))
  },
  prepareSpellingVacuum(table, mapping) {
    const vacuum = new RunVacuum(table, mapping)
    return () => vacuum.publish()
  },
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
