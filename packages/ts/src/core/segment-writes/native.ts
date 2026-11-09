import { loadNativeCore } from '#platform/native-core'
import { type NativeOperation, nativeSearchCoreIsEnabled, noteFallback } from '../../vector/native/backend'
import type {
  NativeFieldTokenArgument,
  NativeFieldTokens,
  NativeGrowingSegment,
  NativeSegmentCore,
} from '../../vector/native/types/segments'
import * as portable from './portable'
import { type PreparedSegmentField, packedTokens } from './prepared-tokens'

const fieldArguments: NativeFieldTokenArgument[] = []

function core(operation: NativeOperation): NativeSegmentCore | null {
  if (!nativeSearchCoreIsEnabled()) return null
  const loaded = loadNativeCore()
  if (loaded === null) noteFallback(operation)
  return loaded
}

export function indexPreparedTerms(
  segment: NativeGrowingSegment,
  generation: number,
  ordinal: number,
  fields: readonly PreparedSegmentField[],
): number {
  const native = core('indexTerms')
  if (native === null) return portable.indexPreparedTerms(segment, generation, ordinal, fields)
  try {
    for (const { field, text } of fields) {
      const packed = packedTokens(text)
      fieldArguments.push(field, packed.tokens, packed.units)
    }
    return native.indexTerms(segment, generation, ordinal, ...fieldArguments)
  } finally {
    fieldArguments.length = 0
  }
}

export function removeDocument(
  segment: NativeGrowingSegment,
  generation: number,
  ordinal: number,
  fields: readonly NativeFieldTokens[],
): number {
  const native = core('removeDocument')
  if (native === null) return portable.removeDocument(segment, generation, ordinal, fields)
  try {
    for (const { field, tokens, units } of fields) fieldArguments.push(field, tokens, units)
    return native.removeDocument(segment, generation, ordinal, ...fieldArguments)
  } finally {
    fieldArguments.length = 0
  }
}

export function beginBatch(segment: NativeGrowingSegment, generation: number): number {
  const native = core('beginBatch')
  return native === null ? portable.beginBatch(segment, generation) : native.beginBatch(segment, generation)
}

export function endBatch(segment: NativeGrowingSegment, generation: number): number {
  const native = core('endBatch')
  return native === null ? portable.endBatch(segment, generation) : native.endBatch(segment, generation)
}
