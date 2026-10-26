import { platformPartialWordSearch } from '#platform/partial-word-search'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { PartialWordHighlight } from '../../../highlighting/highlighter'
import { partialFieldsOf } from '../../../schema/validator/schema'
import type { ExpandedTermGroup } from '../../../types/internal'
import type { LanguageModule } from '../../../types/language'
import type { PartialWordSearch } from '../../../types/partial-words'
import type { AnyDocument, SchemaDefinition } from '../../../types/schema'
import type { FrozenTokenTable } from '../frozen/token-table'
import type { PartitionReadState } from '../read-state'
import type { PartialSpellings, PartialWordAnalysis, SpellingCounts } from './spellings'
import type {
  AddedWord,
  FrozenPartialWordDocuments,
  FrozenPartialWordSlot,
  GrowingPartialWordSlot,
  GrowingPartialWordView,
  PartialWordQuery,
  PartialWordQueryToken,
  PartialWordRequest,
  PartialWordSearchModule,
  PartialWordTableData,
} from './types'

let registered: PartialWordSearchModule | null = null

const MODULE_FUNCTIONS = [
  'createGrowingSlot',
  'createFrozenSlot',
  'buildTable',
  'expand',
  'countSpelling',
  'encodeSpellings',
  'spellingCountsOf',
  'highlightMatcher',
  'addTermMembers',
  'highlightWords',
] as const

function isPartialWordSearchModule(value: PartialWordSearch): value is PartialWordSearchModule {
  if (value === null || typeof value !== 'object' || value.name !== 'partialWords') return false
  return MODULE_FUNCTIONS.every(name => typeof Reflect.get(value, name) === 'function')
}

/**
 * Call this to give the engine the partial-word search code, so that it can
 * create and load an index with a field whose type includes `partial`.
 *
 * A Node process loads that code by itself, so only a browser app has to
 * make this call. In a browser, import `partialWordSearch` from
 * `@delali/narsil/partial-words` and pass it here before the app creates or
 * loads an index with a `partial` field.
 *
 * @param module - Pass the `partialWordSearch` object that
 * `@delali/narsil/partial-words` exports.
 * @throws The engine throws a `NarsilError` with `CONFIG_INVALID` for any
 * other object.
 *
 * @public
 */
export function registerPartialWordSearch(module: PartialWordSearch): void {
  if (!isPartialWordSearchModule(module)) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Pass registerPartialWordSearch the partialWordSearch object that "@delali/narsil/partial-words" exports',
    )
  }
  registered = module
}

function availablePartialWordSearch(): PartialWordSearchModule | null {
  return registered ?? platformPartialWordSearch()
}

const PARTIAL_WORD_IMPORT_ADVICE = `Add import { partialWordSearch } from '@delali/narsil/partial-words', then call registerPartialWordSearch(partialWordSearch) before you create or load an index with a partial field`

function partialWordModule(): PartialWordSearchModule {
  const module = availablePartialWordSearch()
  if (module !== null) return module
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `This bundle contains no partial-word search code. ${PARTIAL_WORD_IMPORT_ADVICE}`,
  )
}

export function requirePartialWordSearchFor(schema: SchemaDefinition): void {
  const fields = partialFieldsOf(schema)
  if (fields.length === 0 || availablePartialWordSearch() !== null) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `The type of field "${fields[0]}" includes "partial", but this bundle contains no partial-word search code. ${PARTIAL_WORD_IMPORT_ADVICE}`,
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
  tableOfEveryDocument: () => null,
  countKeptSpellings: () => undefined,
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

export function countPartialSpelling(counts: SpellingCounts, token: string, spelling: string, change: number): void {
  partialWordModule().countSpelling(counts, token, spelling, change)
}

export function encodePartialSpellingsOf(fields: readonly string[], counts: SpellingCounts): PartialSpellings {
  return partialWordModule().encodeSpellings(fields, counts)
}

export function partialSpellingsOfDocuments(
  documents: Iterable<AnyDocument>,
  analysis: PartialWordAnalysis,
): PartialSpellings {
  const module = partialWordModule()
  return module.encodeSpellings(analysis.fields, module.spellingCountsOf(documents, analysis))
}

export function partialWordHighlighter(
  text: string,
  language: LanguageModule,
  partial: PartialWordHighlight,
): (position: number, fieldToken: string) => boolean {
  return partialWordModule().highlightMatcher(text, language, partial)
}

export function addPartialWordMembers(
  query: PartialWordQuery,
  expand: (analysis: PartialWordAnalysis, requests: readonly PartialWordRequest[]) => AddedWord[][],
  groupOf: (token: string, typoMatches: boolean) => ExpandedTermGroup,
): void {
  partialWordModule().addTermMembers(query, expand, groupOf)
}

export function partialWordsToHighlight(
  queryTokens: readonly PartialWordQueryToken[],
  written: readonly PartialWordQueryToken[],
): string[] {
  return partialWordModule().highlightWords(queryTokens, written)
}
