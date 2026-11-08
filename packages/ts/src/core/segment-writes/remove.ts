import type { NativeGrowingSegment, NativeSegmentCore, NativeSurfaceTable } from '../../vector/native/types/segments'
import { prepareSpellingRemoval } from '../partition/partial-words/registry'
import { rowRemoved } from './postings'
import { readRequest } from './regions'
import { RemovalPlan } from './removal'
import { requireSegment, SegmentRefusal } from './status'
import { removeString, type StringPlan } from './strings'
import { TokenPlan } from './tokens'

function nonnegative(value: number): number {
  return value > 0 ? value : 0
}

function removeSurfaces(plan: StringPlan, table: NativeSurfaceTable, segment: NativeGrowingSegment): void {
  for (const entry of plan.entries) {
    const removed = Math.min(entry.count, table.count[entry.ordinal])
    table.count[entry.ordinal] -= removed
    if (table === segment.surfaces && entry.token < segment.terms.header[0])
      segment.columns.surfaceOccurrences[entry.token] = nonnegative(
        segment.columns.surfaceOccurrences[entry.token] - removed,
      )
    if (table.count[entry.ordinal] === 0) removeString(table.strings, entry)
  }
}

export const removeDocument: NativeSegmentCore['removeDocument'] = (input, ordinal, rawFields) => {
  try {
    const { segment, fields } = readRequest(input, ordinal, rawFields)
    if (rowRemoved(segment, ordinal)) return 0
    requireSegment(segment.totalDocuments[0] > 0 && segment.totalDocuments[0] <= segment.ordinalCapacity)
    for (let field = 0; field < segment.totalFieldLengths.length; field++) {
      const total = segment.totalFieldLengths[field]
      requireSegment(Number.isFinite(total) && total >= segment.fieldLengths[field * segment.ordinalCapacity + ordinal])
    }
    const tokens = new TokenPlan(segment, fields, true)
    const removal = new RemovalPlan(segment, ordinal, tokens.terms)
    if (tokens.spellings !== null && segment.spellings !== null) {
      for (const entry of tokens.spellings.entries) entry.added = entry.count >= segment.spellings.count[entry.ordinal]
    }
    const runs =
      tokens.spellings === null || segment.spellings === null
        ? null
        : prepareSpellingRemoval(segment.spellings.runs, tokens.spellings)
    removal.publish()
    if (tokens.surfaces !== null && segment.surfaces !== null)
      removeSurfaces(tokens.surfaces, segment.surfaces, segment)
    if (tokens.spellings !== null && segment.spellings !== null && runs !== null) {
      runs()
      removeSurfaces(tokens.spellings, segment.spellings, segment)
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
