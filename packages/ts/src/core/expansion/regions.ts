import {
  captureFrozen,
  captureSegment,
  readFrozenSource,
  readMergeSegment,
  regionsOverlap,
  requireSegment,
  storedText,
  typedRegion,
} from '../../engine/optional-reads-host-bindings'
import type { NativeExpansionSegment } from '../../vector/native/types/expansion'

export function expansionText(input: Uint16Array): string {
  const value = typedRegion(input, 'Uint16Array')
  requireSegment(value !== null && value.length <= 0x40000000)
  const text = storedText(value, 0, value.length)
  for (let at = 0; at < text.length; at++) {
    const unit = text.charCodeAt(at)
    if (unit < 0xd800 || unit >= 0xe000) continue
    requireSegment(unit < 0xdc00 && ++at < text.length)
    requireSegment(text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) < 0xe000)
  }
  return text
}

export function captureExpansionSource(input: NativeExpansionSegment): NativeExpansionSegment {
  requireSegment(typeof input === 'object' && input !== null)
  const value = { ...input }
  if (value.growing !== null) {
    requireSegment(value.frozen === null && value.state === null && value.occurrences == null)
    return { growing: captureSegment(value.growing), frozen: null, state: null }
  }
  requireSegment(value.frozen !== null && value.state !== null)
  const { raw, writable } = captureFrozen(value.frozen, value.state)
  return { growing: null, frozen: raw, state: writable, occurrences: value.occurrences }
}

export function readExpansion(
  inputs: readonly NativeExpansionSegment[],
  text: readonly Uint16Array[],
  outSegments: Uint32Array,
  outTokens: Uint32Array,
  outFactors: Float64Array,
) {
  requireSegment(Array.isArray(inputs) && inputs.length <= 0xffffffff)
  const captured = inputs.map(captureExpansionSource)
  const arrays: ArrayBufferView[] = [...text]
  const sources = captured.map(source => {
    if (source.growing !== null) {
      const value = readMergeSegment(source.growing)
      arrays.push(...value.arrays)
      return { growing: value.segment, frozen: null, state: null }
    }
    requireSegment(source.frozen !== null && source.state !== null)
    const value = readFrozenSource(source.frozen, source.state)
    arrays.push(...value.arrays)
    const occurrences = source.occurrences == null ? null : typedRegion(source.occurrences, 'Float64Array')
    requireSegment(source.occurrences == null || occurrences !== null)
    if (occurrences !== null) {
      requireSegment(occurrences.length === value.segment.terms.counts.length)
      for (const count of occurrences) requireSegment(Number.isFinite(count) && count >= 0)
      arrays.push(occurrences)
    }
    return { growing: null, frozen: value.segment, state: value.state, occurrences }
  })
  const words = text.map(expansionText)
  const segments = typedRegion(outSegments, 'Uint32Array')
  const tokens = typedRegion(outTokens, 'Uint32Array')
  const factors = typedRegion(outFactors, 'Float64Array')
  requireSegment(segments !== null && tokens !== null && factors !== null)
  const outputs = [segments, tokens, factors]
  for (let at = 0; at < outputs.length; at++) {
    for (const read of arrays) requireSegment(!regionsOverlap(outputs[at], read))
    for (let before = 0; before < at; before++) requireSegment(!regionsOverlap(outputs[at], outputs[before]))
  }
  return { sources, words, segments, tokens, factors, arrays }
}
