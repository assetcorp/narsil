import { checkText, readFrozenParts, requireSegment } from '#platform/frozen-kernel-host'
import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { FIELD_TOKEN_WORDS, NO_SURFACE } from './pending-writes'

function copyField(value: NativeFieldTokens): NativeFieldTokens {
  requireSegment(typeof value === 'object' && value !== null)
  return { ...value }
}

function readFrozenFields(
  input: NativeFrozenSegment,
  output: NativeFrozenSegmentState,
  ordinal: number | null,
  rawFields: readonly NativeFieldTokens[],
) {
  const { segment, state, regions } = readFrozenParts(input, output)
  requireSegment(Array.isArray(rawFields) && rawFields.length <= 65536)
  const fields = rawFields.map(copyField)
  requireSegment(ordinal === null || ordinal < segment.documentCount)
  const fieldCount = segment.partialFields.length
  requireSegment(fields.length <= fieldCount)
  let previous = -1
  for (const field of fields) {
    requireSegment(Number.isInteger(field.field) && field.field > previous && field.field < fieldCount)
    field.tokens = regions.array(field.tokens, 'Uint32Array')
    field.units = regions.array(field.units, 'Uint16Array')
    requireSegment(
      field.tokens.length % FIELD_TOKEN_WORDS === 0 &&
        field.tokens.length / FIELD_TOKEN_WORDS <= 0xffffffff &&
        field.units.length <= 0xffffffff,
    )
    for (let at = 0; at < field.tokens.length; at += FIELD_TOKEN_WORDS) {
      checkText(field.units, field.tokens[at + 1], field.tokens[at + 2])
      if (field.tokens[at + 3] !== NO_SURFACE) checkText(field.units, field.tokens[at + 3], field.tokens[at + 4])
    }
    previous = field.field
  }
  regions.check()
  return {
    segment,
    state,
    fields,
    readOutput(rawEntries: Uint32Array, rawValues: Float64Array) {
      const entries = regions.array(rawEntries, 'Uint32Array', undefined, true)
      const values = regions.array(rawValues, 'Float64Array', undefined, true)
      requireSegment(entries.length % 2 === 0)
      regions.check()
      return { entries, values }
    },
  }
}

export function readFrozenRequest(
  input: NativeFrozenSegment,
  output: NativeFrozenSegmentState,
  ordinal: number,
  fields: readonly NativeFieldTokens[],
) {
  requireSegment(Number.isInteger(ordinal) && ordinal >= 0)
  return readFrozenFields(input, output, ordinal, fields)
}

export function readFrozenSettle(input: NativeFrozenSegment, output: NativeFrozenSegmentState) {
  return readFrozenFields(input, output, null, [])
}
