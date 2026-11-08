import type { NativeGrowingSegment, NativeSegmentCore } from '../../vector/native/types/segments'
import { prepareSpellingRuns } from '../partition/partial-words/registry'
import { DOCUMENT_INSERT_DECLINED, insertPreparedDocument } from './document-insert'
import { acquirePostingPlan, releasePostingPlan } from './postings'
import type { PreparedSegmentField } from './prepared-tokens'
import { readRequest } from './regions'
import { requireSegment, SegmentRefusal } from './status'
import { publishSurfaces } from './strings'
import { preparedSources, type TokenSource, tokenSources } from './token-sources'
import { acquireTokenPlan, releaseTokenPlan, type TokenPlan } from './tokens'

export { beginBatch, endBatch } from './batch'
export { removeDocument } from './remove'

function publishStrings(plan: TokenPlan, segment: NativeGrowingSegment): void {
  if (plan.surfaces !== null && segment.surfaces !== null) {
    const surfaces = plan.surfaces
    publishSurfaces(surfaces, segment.surfaces)
    for (let at = 0; at < surfaces.size; at++) {
      const token = surfaces.tokens[at]
      if (token < segment.terms.header[0]) segment.columns.surfaceOccurrences[token] += surfaces.counts[at]
    }
  }
  if (plan.spellings !== null && segment.spellings !== null) {
    const spellings = plan.spellings
    publishSurfaces(spellings, segment.spellings)
    for (let at = 0; at < spellings.size; at++)
      segment.spellings.codePoints[spellings.ordinals[at]] = spellings.points[at]
  }
}

function publishPlans(segment: NativeGrowingSegment, ordinal: number, tokens: TokenPlan): void {
  const postings = acquirePostingPlan(segment, ordinal, tokens)
  try {
    const runs =
      tokens.spellings === null || segment.spellings === null
        ? null
        : prepareSpellingRuns(segment.spellings.runs, tokens.spellings)
    tokens.terms.publish()
    postings.publish()
    publishStrings(tokens, segment)
    runs?.()
  } finally {
    releasePostingPlan(postings)
  }
}

function publishTerms(segment: NativeGrowingSegment, ordinal: number, sources: readonly TokenSource[]): number {
  requireSegment(segment.totalDocuments[0] < segment.ordinalCapacity)
  for (const total of segment.totalFieldLengths) requireSegment(Number.isFinite(total) && total >= 0)
  const tokens = acquireTokenPlan(segment, sources, false)
  try {
    publishPlans(segment, ordinal, tokens)
  } finally {
    releaseTokenPlan(tokens)
  }
  for (let field = 0; field < segment.partialFields.length; field++)
    segment.fieldLengths[field * segment.ordinalCapacity + ordinal] = 0
  for (const source of sources) {
    segment.fieldLengths[source.field * segment.ordinalCapacity + ordinal] = source.records
    segment.totalFieldLengths[source.field] += source.records
  }
  segment.totalDocuments[0]++
  return 0
}

export const indexTerms: NativeSegmentCore['indexTerms'] = (input, ordinal, rawFields) => {
  try {
    const { segment, fields, text } = readRequest(input, ordinal, rawFields)
    return publishTerms(segment, ordinal, tokenSources(fields, text))
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}

export function indexPreparedTerms(
  segment: NativeGrowingSegment,
  ordinal: number,
  fields: readonly PreparedSegmentField[],
): number {
  try {
    requireSegment(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < segment.ordinalCapacity)
    requireSegment(fields.length <= segment.partialFields.length)
    let previous = -1
    for (const { field } of fields) {
      requireSegment(Number.isInteger(field) && field > previous && field < segment.partialFields.length)
      previous = field
    }
    const status = insertPreparedDocument(segment, ordinal, fields)
    return status === DOCUMENT_INSERT_DECLINED ? publishTerms(segment, ordinal, preparedSources(fields)) : status
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}
