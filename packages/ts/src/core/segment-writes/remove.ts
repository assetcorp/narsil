import {
  acquireTokenPlan,
  preparedRemovalReach,
  preparedSources,
  prepareSpellingRemoval,
  readRetirementRegions,
  readSegmentRegions,
  releaseTokenPlan,
  removeString,
  requireSegment,
  rowRemoved,
  SegmentRefusal,
} from '#platform/segment-removal-host'
import type { NativeGrowingSegment, NativeSurfaceTable } from '../../vector/native/types/segments'
import type { PreparedSegmentField } from './prepared-tokens'
import type { SegmentRetirement } from './regions'
import { RemovalPlan } from './removal'
import type { StringPlan } from './strings'
import type { TokenPlan } from './tokens'

function nonnegative(value: number): number {
  return value > 0 ? value : 0
}

function readRequest(input: NativeGrowingSegment, ordinal: number, fields: readonly PreparedSegmentField[]) {
  const { segment, regions } = readSegmentRegions(input, preparedRemovalReach(fields))
  requireSegment(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < segment.ordinalCapacity)
  requireSegment(fields.length <= segment.partialFields.length)
  let previous = -1
  for (const { field } of fields) {
    requireSegment(Number.isInteger(field) && field > previous && field < segment.partialFields.length)
    previous = field
  }
  regions.check()
  return { segment, sources: preparedSources(fields) }
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

function retirable(segment: SegmentRetirement, ordinal: number): boolean {
  if (rowRemoved(segment, ordinal)) return false
  requireSegment(segment.totalDocuments[0] > 0 && segment.totalDocuments[0] <= segment.ordinalCapacity)
  for (let field = 0; field < segment.totalFieldLengths.length; field++) {
    const total = segment.totalFieldLengths[field]
    requireSegment(Number.isFinite(total) && total >= segment.fieldLengths[field * segment.ordinalCapacity + ordinal])
  }
  return true
}

function retire(segment: SegmentRetirement, ordinal: number): void {
  for (let field = 0; field < segment.partialFields.length; field++) {
    const at = field * segment.ordinalCapacity + ordinal
    segment.totalFieldLengths[field] = nonnegative(segment.totalFieldLengths[field] - segment.fieldLengths[at])
    segment.fieldLengths[at] = 0
  }
  segment.retired[ordinal >>> 5] |= 1 << (ordinal & 31)
  segment.totalDocuments[0]--
}

function removeTextlessDocument(input: NativeGrowingSegment, ordinal: number): void {
  const segment = readRetirementRegions(input)
  requireSegment(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < segment.ordinalCapacity)
  if (retirable(segment, ordinal)) retire(segment, ordinal)
}

export function removeDocument(
  input: NativeGrowingSegment,
  _generation: number,
  ordinal: number,
  fields: readonly PreparedSegmentField[],
): number {
  try {
    requireSegment(Array.isArray(fields) && fields.length <= 65536)
    if (fields.every(({ text }) => text.count === 0)) {
      removeTextlessDocument(input, ordinal)
      return 0
    }
    const { segment, sources } = readRequest(input, ordinal, fields)
    if (!retirable(segment, ordinal)) return 0
    const tokens = acquireTokenPlan(segment, sources, true)
    try {
      removeTokens(segment, ordinal, tokens)
    } finally {
      releaseTokenPlan(tokens)
    }
    retire(segment, ordinal)
    return 0
  } catch (error) {
    if (error instanceof SegmentRefusal) return error.status
    throw error
  }
}
