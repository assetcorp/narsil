import {
  acquireTokenPlan,
  holdsUnpairedSurrogate,
  preparedSources,
  prepareSpellingRemoval,
  readSegmentView,
  releaseTokenPlan,
  removeString,
  requireSegment,
  rowRemoved,
  SegmentRefusal,
  sharedTexts,
} from '#platform/segment-removal-host'
import type { NativeGrowingSegment, NativeSurfaceTable } from '../../vector/native/types/segments'
import { DocumentRemoval } from './document-removal'
import type { PreparedSegmentField } from './prepared-tokens'
import { RemovalPlan } from './removal'
import type { StringPlan } from './strings'
import type { TokenPlan } from './tokens'

const removalPlan = new RemovalPlan()
const documentRemoval = new DocumentRemoval()

function nonnegative(value: number): number {
  return value > 0 ? value : 0
}

function requireOrdinal(segment: NativeGrowingSegment, ordinal: number): void {
  requireSegment(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < segment.ordinalCapacity)
}

function requireFields(segment: NativeGrowingSegment, fields: readonly PreparedSegmentField[]): void {
  const fieldCount = segment.partialFields.length
  requireSegment(fields.length <= fieldCount)
  let previous = -1
  for (const { field } of fields) {
    requireSegment(Number.isInteger(field) && field > previous && field < fieldCount)
    previous = field
  }
}

function removeSurfaces(plan: StringPlan, table: NativeSurfaceTable, segment: NativeGrowingSegment): void {
  for (let at = 0; at < plan.size; at++) {
    const ordinal = plan.ordinals[at]
    const token = plan.tokens[at]
    const removed = Math.min(plan.counts[at], table.count[ordinal])
    table.count[ordinal] -= removed
    if (table === segment.surfaces && token < segment.terms.header[0])
      segment.columns.surfaceOccurrences[token] = nonnegative(segment.columns.surfaceOccurrences[token] - removed)
    if (table.count[ordinal] === 0) removeString(table.strings, plan.texts[at], ordinal, plan.hashes[at])
  }
}

function removeSharedTexts(
  segment: NativeGrowingSegment,
  ordinal: number,
  texts: readonly string[],
  fields: readonly PreparedSegmentField[],
): void {
  for (const text of texts) requireSegment(!holdsUnpairedSurrogate(text))
  documentRemoval.collect(segment, texts, fields)
  removalPlan.prepare(segment, ordinal, documentRemoval)
  removalPlan.publish(segment, ordinal, documentRemoval)
  const surfaces = documentRemoval.surfaces
  if (surfaces !== null && segment.surfaces !== null) removeSurfaces(surfaces, segment.surfaces, segment)
}

function removeTokens(segment: NativeGrowingSegment, ordinal: number, tokens: TokenPlan): void {
  removalPlan.prepare(segment, ordinal, tokens.terms)
  const spellings = tokens.spellings
  if (spellings !== null && segment.spellings !== null) {
    for (let at = 0; at < spellings.size; at++)
      spellings.added[at] = spellings.counts[at] >= segment.spellings.count[spellings.ordinals[at]] ? 1 : 0
  }
  const runs =
    spellings === null || segment.spellings === null ? null : prepareSpellingRemoval(segment.spellings.runs, spellings)
  removalPlan.publish(segment, ordinal, tokens.terms)
  if (tokens.surfaces !== null && segment.surfaces !== null) removeSurfaces(tokens.surfaces, segment.surfaces, segment)
  if (spellings !== null && segment.spellings !== null && runs !== null) {
    runs()
    removeSurfaces(spellings, segment.spellings, segment)
  }
}

function retirable(segment: NativeGrowingSegment, ordinal: number): boolean {
  if (rowRemoved(segment, ordinal)) return false
  requireSegment(segment.totalDocuments[0] > 0 && segment.totalDocuments[0] <= segment.ordinalCapacity)
  for (let field = 0; field < segment.totalFieldLengths.length; field++) {
    const total = segment.totalFieldLengths[field]
    requireSegment(Number.isFinite(total) && total >= segment.fieldLengths[field * segment.ordinalCapacity + ordinal])
  }
  return true
}

function retire(segment: NativeGrowingSegment, ordinal: number): void {
  for (let field = 0; field < segment.partialFields.length; field++) {
    const at = field * segment.ordinalCapacity + ordinal
    segment.totalFieldLengths[field] = nonnegative(segment.totalFieldLengths[field] - segment.fieldLengths[at])
    segment.fieldLengths[at] = 0
  }
  segment.retired[ordinal >>> 5] |= 1 << (ordinal & 31)
  segment.totalDocuments[0]--
}

function holdsText(fields: readonly PreparedSegmentField[]): boolean {
  for (const { text } of fields) if (text.count > 0) return true
  return false
}

export function removeDocument(
  input: NativeGrowingSegment,
  generation: number,
  ordinal: number,
  fields: readonly PreparedSegmentField[],
): number {
  try {
    const segment = readSegmentView(input, generation)
    requireOrdinal(segment, ordinal)
    requireFields(segment, fields)
    if (!retirable(segment, ordinal)) return 0
    if (!holdsText(fields)) {
      retire(segment, ordinal)
      return 0
    }
    const texts = sharedTexts(fields)
    if (texts !== null && segment.spellings === null) removeSharedTexts(segment, ordinal, texts, fields)
    else {
      const tokens = acquireTokenPlan(segment, preparedSources(fields), true)
      try {
        removeTokens(segment, ordinal, tokens)
      } finally {
        releaseTokenPlan(tokens)
      }
    }
    retire(segment, ordinal)
    return 0
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}
