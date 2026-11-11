import { ErrorCodes, NarsilError } from '../../errors'
import type { NativeExpansionSegment } from '../../vector/native/types/expansion'
import { growingKeywordRegions } from '../partition/keyword-writes'
import type { PartitionReadState } from '../partition/read-state'
import { growingMergeSource } from '../segment-merges/growing-source'
import { SurfaceTable } from '../segment-writes/surface-table'

const frozenSources = new WeakMap<PartitionReadState, () => NativeExpansionSegment>()

export function registerExpansionSource(state: PartitionReadState, source: () => NativeExpansionSegment): void {
  frozenSources.set(state, source)
}

export function expansionSource(state: PartitionReadState): NativeExpansionSegment | null {
  const frozen = frozenSources.get(state)
  if (frozen !== undefined) return frozen()
  const held = growingKeywordRegions(state)
  if (held !== null) return { growing: held, frozen: null, state: null }
  const growing = growingMergeSource(state)
  const terms = state.invertedIdx.livePostings?.terms.ids
  if (growing === null || terms === undefined) return null
  const surfaces = new SurfaceTable()
  const occurrences = new Float64Array(growing.columns.surfaceOccurrences.length)
  for (const [surface, value] of Object.entries(state.surfaceRegistry.serialize())) {
    if (!Array.isArray(value)) continue
    const token = terms.get(value[1])
    if (token === undefined) continue
    if (!Number.isInteger(value[0]) || value[0] < 0 || value[0] > 0xffffffff)
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The stored surface count is outside uint32')
    const entry = surfaces.strings.header[0]
    surfaces.reserve(entry + 1, surfaces.strings.header[4] + surface.length)
    surfaces.strings.set(surface, entry)
    surfaces.token[entry] = token
    surfaces.count[entry] = value[0]
    occurrences[token] += value[0]
  }
  return {
    growing: { ...growing, surfaces, columns: { ...growing.columns, surfaceOccurrences: occurrences } },
    frozen: null,
    state: null,
  }
}
