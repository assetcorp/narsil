import type { NativeGrowingSegment, NativeSegmentCore, NativeSurfaceTable } from '../../vector/native/types/segments'
import { prepareSpellingRemoval } from '../partition/partial-words/registry'
import { rowRemoved } from './postings'
import { readRequest } from './regions'
import { RemovalPlan } from './removal'
import { requireSegment, SegmentRefusal } from './status'
import { removeString, type StringPlan } from './strings'
import { tokenSources } from './token-sources'
import { acquireTokenPlan, releaseTokenPlan, type TokenPlan } from './tokens'

function nonnegative(value: number): number {
  return value > 0 ? value : 0
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

function removeTokens(segment: NativeGrowingSegment, ordinal: number, tokens: TokenPlan): void {
  const removal = new RemovalPlan(segment, ordinal, tokens.terms)
  const spellings = tokens.spellings
  if (spellings !== null && segment.spellings !== null) {
    for (let at = 0; at < spellings.size; at++)
      spellings.added[at] = spellings.counts[at] >= segment.spellings.count[spellings.ordinals[at]] ? 1 : 0
  }
  const runs =
    spellings === null || segment.spellings === null ? null : prepareSpellingRemoval(segment.spellings.runs, spellings)
  removal.publish()
  if (tokens.surfaces !== null && segment.surfaces !== null) removeSurfaces(tokens.surfaces, segment.surfaces, segment)
  if (spellings !== null && segment.spellings !== null && runs !== null) {
    runs()
    removeSurfaces(spellings, segment.spellings, segment)
  }
}

export const removeDocument: NativeSegmentCore['removeDocument'] = (input, ordinal, rawFields) => {
  try {
    const { segment, fields, text } = readRequest(input, ordinal, rawFields)
    if (rowRemoved(segment, ordinal)) return 0
    requireSegment(segment.totalDocuments[0] > 0 && segment.totalDocuments[0] <= segment.ordinalCapacity)
    for (let field = 0; field < segment.totalFieldLengths.length; field++) {
      const total = segment.totalFieldLengths[field]
      requireSegment(Number.isFinite(total) && total >= segment.fieldLengths[field * segment.ordinalCapacity + ordinal])
    }
    const tokens = acquireTokenPlan(segment, tokenSources(fields, text), true)
    try {
      removeTokens(segment, ordinal, tokens)
    } finally {
      releaseTokenPlan(tokens)
    }
    for (let field = 0; field < segment.partialFields.length; field++) {
      const at = field * segment.ordinalCapacity + ordinal
      segment.totalFieldLengths[field] = nonnegative(segment.totalFieldLengths[field] - segment.fieldLengths[at])
      segment.fieldLengths[at] = 0
    }
    segment.retired[ordinal >>> 5] |= 1 << (ordinal & 31)
    segment.totalDocuments[0]--
    return 0
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}
