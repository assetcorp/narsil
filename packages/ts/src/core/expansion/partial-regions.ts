import type { NativePartialRequest, NativePartialSource } from '../../vector/native/types/partial-expansion'
import { regionsOverlap } from '../regions'
import { requireRoom, requireSegment } from '../segment-writes/status'
import { typedRegion } from '../stored-values/regions'
import { captureExpansionSource, expansionText, readExpansion } from './regions'

function unsigned(value: number): void {
  requireSegment(Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
}

export function readPartialExpansion(
  input: readonly NativePartialSource[],
  requests: readonly NativePartialRequest[],
  outStarts: Uint32Array,
  outSegments: Uint32Array,
  outTokens: Uint32Array,
  outFactors: Float64Array,
) {
  requireSegment(Array.isArray(input) && input.length <= 0xffffffff)
  requireSegment(Array.isArray(requests) && requests.length <= 0xffffffff)
  const sources = input.map(source => {
    requireSegment(typeof source === 'object' && source !== null)
    const raw = { ...source }
    requireSegment(raw.runs === null || (typeof raw.runs === 'object' && raw.runs !== null))
    return { segment: captureExpansionSource(raw.segment), runs: raw.runs === null ? null : { ...raw.runs } }
  })
  const words: NativePartialRequest[] = requests.map(request => {
    requireSegment(typeof request === 'object' && request !== null)
    return { ...request }
  })
  const held = readExpansion(
    sources.map(source => source.segment),
    words.flatMap(word => [word.written, word.own]),
    outSegments,
    outTokens,
    outFactors,
  )
  const starts = typedRegion(outStarts, 'Uint32Array')
  requireSegment(starts !== null)
  const outputs = [starts, held.segments, held.tokens, held.factors]
  for (let at = 1; at < outputs.length; at++) requireSegment(!regionsOverlap(starts, outputs[at]))
  for (const region of held.arrays) requireSegment(!regionsOverlap(starts, region))
  const runs = sources.map((source, at) => {
    const raw = source.runs
    requireSegment(held.sources[at].growing === null || raw === null)
    if (raw === null) return null
    const points = typedRegion(raw.runs, 'Uint32Array')
    const offsets = typedRegion(raw.offsets, 'Uint32Array')
    const members = typedRegion(raw.members, 'Uint32Array')
    requireSegment(points !== null && offsets !== null && members !== null)
    requireSegment(points.length % 3 === 0 && points.length / 3 <= 0xffffffff)
    requireSegment(offsets.length === points.length / 3 + 1 && members.length <= 0xffffffff)
    for (const output of outputs)
      for (const region of [points, offsets, members]) requireSegment(!regionsOverlap(output, region))
    return { runs: points, offsets, members }
  })
  const queries = words.map(word => {
    unsigned(word.tolerance)
    unsigned(word.prefixLength)
    return { ...word, written: expansionText(word.written), own: expansionText(word.own) }
  })
  requireRoom(starts.length >= words.length + 1)
  return { ...held, starts, runs, queries }
}
