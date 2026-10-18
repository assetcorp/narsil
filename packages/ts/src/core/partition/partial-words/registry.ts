import { platformPartialWordSearch } from '#platform/partial-word-search'
import { ErrorCodes, NarsilError } from '../../../errors'
import { partialFieldsOf } from '../../../schema/validator/schema'
import type { PartialWordSearch } from '../../../types/partial-words'
import type { SchemaDefinition } from '../../../types/schema'
import type { FrozenTokenTable } from '../frozen/token-table'
import type { PartitionReadState } from '../read-state'
import type { PartialSpellings, PartialWordAnalysis } from './spellings'
import type {
  AddedWord,
  FrozenPartialWordDocuments,
  FrozenPartialWordSlot,
  GrowingPartialWordSlot,
  GrowingPartialWordView,
  PartialWordRequest,
  PartialWordSearchModule,
  PartialWordTableData,
} from './types'

let registered: PartialWordSearchModule | null = null

function isPartialWordSearchModule(value: PartialWordSearch): value is PartialWordSearchModule {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.name === 'partialWords' &&
    'createGrowingSlot' in value &&
    typeof value.createGrowingSlot === 'function' &&
    'createFrozenSlot' in value &&
    typeof value.createFrozenSlot === 'function' &&
    'buildTable' in value &&
    typeof value.buildTable === 'function' &&
    'expand' in value &&
    typeof value.expand === 'function'
  )
}

/**
 * This makes partial-word search available to every index whose schema
 * declares a field whose type includes `partial`.
 *
 * A Node process needs no such call, because it loads the partial-word search
 * code by itself. A browser app has to import `partialWordSearch` from
 * `@delali/narsil/partial-words` and pass it to this function before it
 * creates or loads an index with a `partial` field.
 *
 * @param module - The `partialWordSearch` object that
 * `@delali/narsil/partial-words` exports.
 * @throws A `NarsilError` with `CONFIG_INVALID` for any other object.
 *
 * @public
 */
export function registerPartialWordSearch(module: PartialWordSearch): void {
  if (!isPartialWordSearchModule(module)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'registerPartialWordSearch takes the partialWordSearch object that "@delali/narsil/partial-words" exports',
    )
  }
  registered = module
}

function availablePartialWordSearch(): PartialWordSearchModule | null {
  return registered ?? platformPartialWordSearch()
}

export function requirePartialWordSearchFor(schema: SchemaDefinition): void {
  const fields = partialFieldsOf(schema)
  if (fields.length === 0 || availablePartialWordSearch() !== null) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `Field "${fields[0]}" declares "partial", but this bundle contains no partial-word search code. Add import { partialWordSearch } from '@delali/narsil/partial-words', then call registerPartialWordSearch(partialWordSearch) before you create or load the index`,
    { field: fields[0] },
  )
}

const EMPTY_GROWING_SLOT: GrowingPartialWordSlot = {
  readerFor: () => null,
  spellings: () => null,
  bytes: () => 0,
  afterDocument: () => undefined,
  afterMerge: () => undefined,
  forgetSpellings: () => undefined,
  clear: () => undefined,
}

const EMPTY_FROZEN_SLOT: FrozenPartialWordSlot = {
  readerFor: () => null,
  spellings: () => null,
  bytes: () => 0,
  afterRemoval: () => undefined,
}

export function createGrowingPartialWords(view: GrowingPartialWordView): GrowingPartialWordSlot {
  return availablePartialWordSearch()?.createGrowingSlot(view) ?? EMPTY_GROWING_SLOT
}

export function createFrozenPartialWords(
  initial: PartialWordTableData | null,
  tokenTable: FrozenTokenTable,
  documents: FrozenPartialWordDocuments,
): FrozenPartialWordSlot {
  return availablePartialWordSearch()?.createFrozenSlot(initial, tokenTable, documents) ?? EMPTY_FROZEN_SLOT
}

export function buildPartialWordTableFrom(
  source: PartialSpellings,
  tokenTable: FrozenTokenTable,
): PartialWordTableData | null {
  return availablePartialWordSearch()?.buildTable(source, tokenTable) ?? null
}

export function expandPartialWords(
  subs: readonly PartitionReadState[],
  analysis: PartialWordAnalysis,
  requests: readonly PartialWordRequest[],
): AddedWord[][] {
  const module = availablePartialWordSearch()
  return module === null ? requests.map(() => []) : module.expand(subs, analysis, requests)
}
