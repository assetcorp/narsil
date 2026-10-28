import type { PartialWordHighlight } from '../../../highlighting/highlighter'
import type { ExpandedTermGroup } from '../../../types/internal'
import type { LanguageModule } from '../../../types/language'
import type { PartialWordSearch } from '../../../types/partial-words'
import type { AnyDocument } from '../../../types/schema'
import type { DocumentStoreReader } from '../../document-store'
import type { FrozenTokenTable } from '../frozen/token-table'
import type { PartitionReadState } from '../read-state'
import type { PartialSpellings, PartialWordAnalysis, SpellingCounts } from './spellings'

export interface PartialWordProbe {
  readonly text: string
  readonly codePoints: readonly number[]
  readonly utf8: Uint8Array
}

export type PartialWordVisitor = (token: string, spellingLength: number) => void

export interface PartialWordReader {
  forEachContaining(probe: PartialWordProbe, visit: PartialWordVisitor): void
  bytes(): number
}

export interface PartialWordTableReader extends PartialWordReader {
  entryOf(spelling: string): number
}

export interface PartialWordSlot {
  readerFor(analysis: PartialWordAnalysis): PartialWordReader | null
  spellings(): PartialSpellings | null
  bytes(): number
}

export interface PartialWordTableData {
  fields: string[]
  spellings: Uint8Array
  spellingOffsets: Uint32Array
  spellingTokens: Uint32Array
  spellingCounts: Uint32Array
  runs: Uint32Array
  runOffsets: Uint32Array
  runEntries: Uint32Array
}

export interface PartialWordRequest {
  readonly written: string
  readonly ownToken: string
  readonly share: number
  readonly tolerance: number
  readonly prefixLength: number
}

export interface PartialWordQueryToken {
  readonly token: string
  readonly position: number
}

export interface PartialWordQuery {
  readonly queryTokens: readonly PartialWordQueryToken[]
  readonly written: ReadonlyMap<number, string>
  readonly prefixToken: string | undefined
  readonly tolerance: number
  readonly prefixLength: number | undefined
  readonly analysis: PartialWordAnalysis
}

export interface AddedWord {
  readonly token: string
  readonly factor: number
}

export interface GrowingPartialWordView {
  readonly docStore: Pick<DocumentStoreReader, 'all' | 'count' | 'get' | 'getExternalId'>
}

export interface GrowingPartialWordSlot extends PartialWordSlot {
  afterDocument(
    fields: readonly string[],
    internalId: number,
    spellings: SpellingCounts | null,
    direction: 1 | -1,
  ): void
  afterMerge(spellings: PartialSpellings | null, internalIds: readonly number[]): void
  forgetSpellings(): void
  clear(): void
}

export interface FrozenPartialWordDocuments {
  readonly count: number
  documentAt(ordinal: number): AnyDocument
  isTombstoned(ordinal: number): boolean
}

export interface FrozenPartialWordSlot extends PartialWordSlot {
  afterRemoval(ordinal: number): void
  tableOfEveryDocument(analysis: PartialWordAnalysis): PartialWordTableData | null
  countKeptSpellings(counts: SpellingCounts, analysis: PartialWordAnalysis, mergedOrdinals: Int32Array): void
}

export interface PartialWordSearchModule extends PartialWordSearch {
  createGrowingSlot(view: GrowingPartialWordView): GrowingPartialWordSlot
  createFrozenSlot(
    initial: PartialWordTableData | null,
    tokenTable: FrozenTokenTable,
    documents: FrozenPartialWordDocuments,
  ): FrozenPartialWordSlot
  buildTable(source: PartialSpellings, tokenTable: FrozenTokenTable): PartialWordTableData
  expand(
    subs: readonly PartitionReadState[],
    analysis: PartialWordAnalysis,
    requests: readonly PartialWordRequest[],
  ): AddedWord[][]
  countSpelling(counts: SpellingCounts, token: string, spelling: string, change: number): void
  encodeSpellings(fields: readonly string[], counts: SpellingCounts): PartialSpellings
  spellingCountsOf(documents: Iterable<AnyDocument>, analysis: PartialWordAnalysis): SpellingCounts
  highlightMatcher(
    text: string,
    language: LanguageModule,
    partial: PartialWordHighlight,
  ): (position: number, fieldToken: string) => boolean
  addTermMembers(
    query: PartialWordQuery,
    expand: (analysis: PartialWordAnalysis, requests: readonly PartialWordRequest[]) => AddedWord[][],
    groupOf: (token: string, typoMatches: boolean) => ExpandedTermGroup,
  ): void
  highlightWords(queryTokens: readonly PartialWordQueryToken[], written: readonly PartialWordQueryToken[]): string[]
}
