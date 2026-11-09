import type { NativeKeywordMergeInput, NativePostingMergeOutput } from '../../vector/native/types/segment-merge'
import { regionLength } from '../stored-values/regions'
import { MergeRegions, type SegmentRegions } from './regions'

export interface PostingOutputs {
  documents: Uint32Array
  frequencies: Uint16Array
  fields: Uint16Array
  offsets: Uint32Array
  positions: Uint32Array
  totals: Float64Array
}

export interface PreparedPostings {
  inputs: NativeKeywordMergeInput[]
  outputs: PostingOutputs
}

interface HeldValues {
  raws: readonly unknown[]
  lengths: readonly (number | null)[]
}

interface HeldSource extends HeldValues {
  regions: SegmentRegions
}

interface PostingContext extends HeldValues {
  outputs: PostingOutputs
  writes: readonly ArrayBufferView[]
  sources: Map<object, HeldSource>
}

const contexts = new WeakMap<object, PostingContext>()

function lengthsOf(raws: readonly unknown[]): (number | null)[] {
  return raws.map(raw => (ArrayBuffer.isView(raw) ? regionLength(raw) : null))
}

function stillHeld(raws: readonly unknown[], held: HeldValues): boolean {
  if (raws.length !== held.raws.length) return false
  for (let at = 0; at < raws.length; at++) {
    if (raws[at] !== held.raws[at]) return false
    const length = held.lengths[at]
    if (length !== null && regionLength(raws[at]) !== length) return false
  }
  return true
}

function outputRaws(target: NativePostingMergeOutput): unknown[] {
  return [target.documents, target.frequencies, target.fields, target.positionOffsets, target.positions, target.totals]
}

function readOutputs(regions: MergeRegions, target: NativePostingMergeOutput): PostingOutputs {
  const documents = regions.read(target.documents, 'Uint32Array', undefined, true)
  return {
    documents,
    frequencies: regions.read(target.frequencies, 'Uint16Array', documents.length, true),
    fields: regions.read(target.fields, 'Uint16Array', documents.length, true),
    offsets: regions.read(target.positionOffsets, 'Uint32Array', undefined, true),
    positions: regions.read(target.positions, 'Uint32Array', undefined, true),
    totals: regions.read(target.totals, 'Float64Array', undefined, true),
  }
}

function sourceRaws(input: NativeKeywordMergeInput): unknown[] {
  const { terms, surfaces, spellings } = input
  return [
    input.documentCount,
    terms.text,
    terms.offsets,
    terms.counts,
    input.fieldMapping,
    input.payloadSlots,
    input.postingOffsets,
    input.mapping,
    surfaces === null,
    surfaces?.text,
    surfaces?.offsets,
    surfaces?.counts,
    spellings === null,
    spellings?.text,
    spellings?.offsets,
    spellings?.counts,
    ...input.fieldLengths,
  ]
}

function contextOf(key: object, target: NativePostingMergeOutput): PostingContext {
  const raws = outputRaws(target)
  const held = contexts.get(key)
  if (held !== undefined && stillHeld(raws, held)) return held
  const regions = new MergeRegions()
  const outputs = readOutputs(regions, target)
  regions.check()
  const writes = [
    outputs.documents,
    outputs.frequencies,
    outputs.fields,
    outputs.offsets,
    outputs.positions,
    outputs.totals,
  ]
  const context = { raws, lengths: lengthsOf(raws), outputs, writes, sources: new Map<object, HeldSource>() }
  contexts.set(key, context)
  return context
}

function segmentRegionsOf(context: PostingContext, key: object, input: NativeKeywordMergeInput): SegmentRegions {
  const raws = sourceRaws(input)
  const held = context.sources.get(key)
  if (held !== undefined && stillHeld(raws, held)) return held.regions
  const regions = new MergeRegions()
  const segment = regions.segmentSource(input)
  regions.checkReadsAgainst(context.writes)
  context.sources.set(key, { raws, lengths: lengthsOf(raws), regions: segment })
  return segment
}

export function preparePostingsInContext(
  key: object,
  target: NativePostingMergeOutput,
  rawInputs: readonly NativeKeywordMergeInput[],
  inputs: readonly NativeKeywordMergeInput[],
): PreparedPostings {
  const context = contextOf(key, target)
  const prepared = inputs.map((input, at) => {
    const segment = segmentRegionsOf(context, rawInputs[at], input)
    const regions = new MergeRegions()
    const token = regions.tokenSource(input)
    regions.checkReadsAgainst(context.writes)
    return { ...segment, ...token }
  })
  return { inputs: prepared, outputs: context.outputs }
}

export function preparePostings(
  target: NativePostingMergeOutput,
  inputs: readonly NativeKeywordMergeInput[],
): PreparedPostings {
  const regions = new MergeRegions()
  const prepared = inputs.map(input => regions.source(input))
  const outputs = readOutputs(regions, target)
  regions.check()
  return { inputs: prepared, outputs }
}
