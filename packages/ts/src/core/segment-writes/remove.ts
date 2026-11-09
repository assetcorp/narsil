import {
  acquireTokenPlan,
  checkText,
  prepareSpellingRemoval,
  readSegmentRegions,
  releaseTokenPlan,
  removeString,
  requireSegment,
  rowRemoved,
  SegmentRefusal,
  tokenSources,
  tokenTextOf,
} from '#platform/segment-removal-host'
import type { NativeFieldTokens, NativeGrowingSegment, NativeSurfaceTable } from '../../vector/native/types/segments'
import { RemovalPlan } from './removal'
import type { StringPlan } from './strings'
import type { TokenPlan } from './tokens'

const FIELD_TOKEN_WORDS = 8
const TOKEN_TEXT_WORDS = 4
const NO_SURFACE = 0xffffffff

function nonnegative(value: number): number {
  return value > 0 ? value : 0
}

function copyField(value: NativeFieldTokens): NativeFieldTokens {
  requireSegment(typeof value === 'object' && value !== null)
  return { ...value }
}

function readRequest(input: NativeGrowingSegment, ordinal: number, rawFields: readonly NativeFieldTokens[]) {
  const { segment, regions } = readSegmentRegions(input)
  requireSegment(Array.isArray(rawFields) && rawFields.length <= 65536)
  const fields = rawFields.map(copyField)
  requireSegment(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < segment.ordinalCapacity)
  requireSegment(fields.length <= segment.partialFields.length)
  const text: Array<ReadonlyArray<string | undefined> | undefined> = []
  let previous = -1
  for (const field of fields) {
    requireSegment(
      Number.isInteger(field.field) && field.field > previous && field.field < segment.partialFields.length,
    )
    const known = tokenTextOf(field.tokens)
    field.tokens = regions.read(field.tokens, 'Uint32Array', undefined, false)
    text.push(known?.length === field.tokens.length / TOKEN_TEXT_WORDS ? known : undefined)
    field.units = regions.read(field.units, 'Uint16Array', undefined, false)
    requireSegment(field.units.length <= 0xffffffff)
    requireSegment(
      field.tokens.length % FIELD_TOKEN_WORDS === 0 && field.tokens.length / FIELD_TOKEN_WORDS <= 0xffffffff,
    )
    for (let at = 0; at < field.tokens.length; at += FIELD_TOKEN_WORDS) {
      checkText(field.units, field.tokens[at + 1], field.tokens[at + 2])
      if (field.tokens[at + 3] !== NO_SURFACE) checkText(field.units, field.tokens[at + 3], field.tokens[at + 4])
    }
    previous = field.field
  }
  regions.check()
  return { segment, fields, text }
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

export function removeDocument(
  input: NativeGrowingSegment,
  _generation: number,
  ordinal: number,
  rawFields: readonly NativeFieldTokens[],
): number {
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
