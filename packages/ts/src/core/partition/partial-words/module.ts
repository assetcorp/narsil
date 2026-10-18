import { expandPartialWords } from './expansion'
import { createFrozenPartialWordSlot } from './frozen-slot'
import { buildPartialWordTable } from './frozen-table'
import { createGrowingPartialWordSlot } from './growing-slot'
import type { PartialWordSearchModule } from './types'

export const partialWordSearchModule: PartialWordSearchModule = {
  name: 'partialWords',
  createGrowingSlot: createGrowingPartialWordSlot,
  createFrozenSlot: createFrozenPartialWordSlot,
  buildTable: buildPartialWordTable,
  expand: expandPartialWords,
}
