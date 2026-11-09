import {
  packedTokens,
  resolveStopWords,
  storedText,
  transformToken,
  visitDocumentSurfaceSpellings,
} from '#platform/frozen-kernel-host'
import type { LanguageModule } from '../../types/language'
import type { AnyDocument } from '../../types/schema'
import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import type { RemovedSpellings } from '../partition/frozen/removed-spellings'
import type { FrozenSurfaceSlot, TextAnalysis } from '../partition/frozen/surface-slot'
import type { PartialWordAnalysis } from '../partition/partial-words/spellings'
import type { FrozenPartialWordSlot } from '../partition/partial-words/types'
import type { PreparedText } from '../partition/prepared-text'
import { FIELD_TOKEN_WORDS, NO_KEY, NO_SURFACE, RemovalScratch } from './removal-scratch'

export interface FrozenStringRemoval
  extends Pick<NativeFrozenSegment, 'surfaces' | 'spellings' | 'spellingTokens' | 'partialFields'>,
    Pick<NativeFrozenSegmentState, 'removedSurfaces' | 'removedSpellings'> {
  fields: NativeFieldTokens[]
}

export interface FrozenStrings {
  readonly spellings: RemovedSpellings
  readonly core: FrozenStringRemoval
  publish(): void
}

export interface FrozenRemovalAnalysis extends TextAnalysis {
  readonly text: PreparedText | undefined
}

const SURFACE_TAG = 0
const PARTIAL_TAG = 1
const NO_SPELLING_TOKENS = new Uint32Array(0)
const NO_REMOVED_PARTIAL_SPELLINGS = new Uint32Array(0)

const scratch = new RemovalScratch()
const visitedFields: string[] = ['']
let visitedTag = SURFACE_TAG
let visitedPosition = 0
let sharedListing = false
let visitedSurfaces: FrozenSurfaceSlot | null = null
let visitedPartialWords: FrozenPartialWordSlot | null = null
let normalizingLanguage: LanguageModule | null = null
let normalizingStopWords: ReadonlySet<string> | null = null

function normalizedOf(spelling: string): string | null {
  if (normalizingLanguage === null || normalizingStopWords?.has(spelling) === true) return null
  return transformToken(spelling, normalizingLanguage, false, false)
}

function resolveSpelling(written: string): number {
  const partial = visitedTag === PARTIAL_TAG
  let spelling = written
  let token = partial ? visitedPartialWords?.tokenForSpelling(written) : undefined
  if (token === undefined && partial) {
    const normalized = normalizedOf(written)
    if (normalized !== null) {
      token = visitedPartialWords?.tokenForSpelling(normalized)
      if (token !== undefined) spelling = normalized
    }
  }
  token ??= visitedSurfaces?.tokenOf(written)
  const differs = token !== undefined && spelling !== token && spelling.length > 0
  const records = token !== undefined && (partial || differs)
  const key = scratch.add(
    written,
    visitedTag,
    records && token !== undefined ? token : null,
    records && spelling !== token ? spelling : null,
  )
  if (differs) scratch.listSpelling(key, spelling, sharedListing)
  return key
}

function visitSpelling(spelling: string): void {
  let key = scratch.find(spelling, visitedTag)
  if (key === NO_KEY) key = resolveSpelling(spelling)
  scratch.countListed(key)
  if (scratch.recordsTokens(key)) scratch.writeRecord(visitedPosition++, key)
}

function visitedRecords(
  field: number,
  document: AnyDocument,
  analysis: PartialWordAnalysis,
  isPartial: boolean,
): NativeFieldTokens | null {
  const firstWord = scratch.tokenWords
  scratch.beginField()
  visitedTag = isPartial ? PARTIAL_TAG : SURFACE_TAG
  visitedPosition = 0
  visitDocumentSurfaceSpellings(document, analysis, visitSpelling)
  if (scratch.tokenWords === firstWord) return null
  return { field, tokens: scratch.tokens.subarray(firstWord, scratch.tokenWords), units: scratch.fieldUnits() }
}

function preparedRecords(
  field: number,
  isPartial: boolean,
  { tokens, units }: Pick<NativeFieldTokens, 'tokens' | 'units'>,
): NativeFieldTokens | null {
  const firstWord = scratch.tokenWords
  for (let at = 0; at < tokens.length; at += FIELD_TOKEN_WORDS) {
    const surface =
      tokens[at + 3] === NO_SURFACE || tokens[at + 4] === 0 ? '' : storedText(units, tokens[at + 3], tokens[at + 4])
    const differs = surface.length > 0 && surface !== storedText(units, tokens[at + 1], tokens[at + 2])
    if (differs) {
      let key = scratch.find(surface, SURFACE_TAG)
      if (key === NO_KEY) {
        key = scratch.add(surface, SURFACE_TAG, null, null)
        scratch.listSpelling(key, surface, true)
      }
      scratch.countListed(key)
    }
    if (isPartial || differs) scratch.copyRecord(tokens, at)
  }
  if (scratch.tokenWords === firstWord) return null
  return { field, tokens: scratch.tokens.subarray(firstWord, scratch.tokenWords), units }
}

function beginVisit(
  surfaces: FrozenSurfaceSlot,
  partialWords: FrozenPartialWordSlot,
  analysis: FrozenRemovalAnalysis,
  partialFields: readonly string[] | undefined,
): void {
  scratch.reset()
  visitedSurfaces = surfaces
  visitedPartialWords = partialWords
  sharedListing = partialFields !== undefined
  const { language, options } = analysis
  const normalizes =
    partialFields !== undefined &&
    options?.customTokenizer === undefined &&
    language.normalizer !== undefined &&
    language.tokenizer?.normalizeDiacritics !== true
  normalizingLanguage = normalizes ? language : null
  normalizingStopWords = normalizes ? resolveStopWords(language, options?.stopWordOverride) : null
}

function endVisit(): void {
  visitedSurfaces = null
  visitedPartialWords = null
  normalizingLanguage = null
  normalizingStopWords = null
}

function collectRecords(
  fieldNames: readonly string[],
  textFields: readonly string[],
  document: AnyDocument,
  analysis: FrozenRemovalAnalysis,
  surfaces: FrozenSurfaceSlot,
  partialFields: readonly string[] | undefined,
): NativeFieldTokens[] {
  const fields: NativeFieldTokens[] = []
  const custom = analysis.options?.customTokenizer !== undefined
  if (!custom && partialFields === undefined && !surfaces.holdsAny()) return fields
  const visiting: PartialWordAnalysis = {
    language: analysis.language,
    options: analysis.options,
    fields: visitedFields,
  }
  for (let field = 0; field < fieldNames.length; field++) {
    const name = fieldNames[field]
    const isPartial = partialFields?.includes(name) === true
    let records: NativeFieldTokens | null = null
    if (custom) {
      const prepared = analysis.text?.fields.get(name)
      if (prepared !== undefined) records = preparedRecords(field, isPartial, packedTokens(prepared.records))
    } else if (textFields.includes(name)) {
      visitedFields[0] = name
      records = visitedRecords(field, document, visiting, isPartial)
    }
    if (records !== null) fields.push(records)
  }
  return fields
}

export function prepareFrozenStrings(
  fieldNames: readonly string[],
  textFields: readonly string[],
  ordinal: number,
  document: AnyDocument,
  analysis: FrozenRemovalAnalysis,
  surfaces: FrozenSurfaceSlot,
  partialWords: FrozenPartialWordSlot,
): FrozenStrings {
  const partial = partialWords.removalState()
  const partialFields = partial?.table.fields
  beginVisit(surfaces, partialWords, analysis, partialFields)
  let fields: NativeFieldTokens[]
  try {
    fields = collectRecords(fieldNames, textFields, document, analysis, surfaces, partialFields)
  } finally {
    endVisit()
  }
  const spellings = scratch.removedSpellings()
  const surface = surfaces.prepareCoreRemoval(ordinal, spellings)
  const partialFlags = new Uint8Array(fieldNames.length)
  for (const path of partialFields ?? []) {
    const field = fieldNames.indexOf(path)
    if (field >= 0) partialFlags[field] = 1
  }
  return {
    spellings,
    core: {
      fields,
      partialFields: partialFlags,
      surfaces: surface.table,
      removedSurfaces: surface.removed,
      spellings:
        partial === null
          ? null
          : {
              text: partial.table.spellings,
              offsets: partial.table.spellingOffsets,
              counts: partial.table.spellingCounts,
            },
      spellingTokens: partial?.table.spellingTokens ?? NO_SPELLING_TOKENS,
      removedSpellings: partial?.removed ?? NO_REMOVED_PARTIAL_SPELLINGS,
    },
    publish: surface.publish,
  }
}
