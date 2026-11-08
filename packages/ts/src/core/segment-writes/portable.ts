import type { NativeGrowingSegment, NativeSegmentCore, NativeSurfaceTable } from '../../vector/native/types/segments'
import { prepareSpellingRuns } from '../partition/partial-words/registry'
import { PostingPlan } from './postings'
import { readRequest } from './regions'
import { requireSegment, SegmentRefusal } from './status'
import type { StringPlan } from './strings'
import { TokenPlan } from './tokens'

export { beginBatch, endBatch } from './batch'
export { removeDocument } from './remove'

function publishSurfaces(plan: StringPlan, table: NativeSurfaceTable): void {
  plan.publish()
  for (const entry of plan.entries) {
    table.token[entry.ordinal] = entry.token
    table.count[entry.ordinal] = (entry.added ? 0 : table.count[entry.ordinal]) + entry.count
  }
}

function publishStrings(plan: TokenPlan, segment: NativeGrowingSegment): void {
  if (plan.surfaces !== null && segment.surfaces !== null) {
    publishSurfaces(plan.surfaces, segment.surfaces)
    for (const entry of plan.surfaces.entries) {
      if (entry.token < segment.terms.header[0]) segment.columns.surfaceOccurrences[entry.token] += entry.count
    }
  }
  if (plan.spellings !== null && segment.spellings !== null) {
    publishSurfaces(plan.spellings, segment.spellings)
    for (const entry of plan.spellings.entries) segment.spellings.codePoints[entry.ordinal] = entry.points
  }
}

export const indexTerms: NativeSegmentCore['indexTerms'] = (input, ordinal, rawFields) => {
  try {
    const { segment, fields } = readRequest(input, ordinal, rawFields)
    requireSegment(segment.totalDocuments[0] < segment.ordinalCapacity)
    for (const total of segment.totalFieldLengths) requireSegment(Number.isFinite(total) && total >= 0)
    const tokens = new TokenPlan(segment, fields, false)
    const postings = new PostingPlan(segment, ordinal, tokens)
    const runs =
      tokens.spellings === null || segment.spellings === null
        ? null
        : prepareSpellingRuns(segment.spellings.runs, tokens.spellings)
    tokens.terms.publish()
    postings.publish()
    publishStrings(tokens, segment)
    runs?.()
    for (let field = 0; field < segment.partialFields.length; field++)
      segment.fieldLengths[field * segment.ordinalCapacity + ordinal] = 0
    for (const field of fields) {
      const count = field.tokens.length / 8
      segment.fieldLengths[field.field * segment.ordinalCapacity + ordinal] = count
      segment.totalFieldLengths[field.field] += count
    }
    segment.totalDocuments[0]++
    return 0
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}
