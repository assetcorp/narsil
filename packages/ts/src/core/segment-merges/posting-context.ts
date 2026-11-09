import { MergeRegions, regionLength, regionsOverlap, requireSegment, typedRegion } from '#platform/segment-merge-host'
import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeKeywordMergeInput, NativePostingMergeOutput } from '../../vector/native/types/segment-merge'

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

interface HeldViews {
  views: readonly unknown[]
  lengths: readonly (number | null)[]
}

interface HeldSource extends HeldViews {
  raw: NativeKeywordMergeInput
  prepared: NativeKeywordMergeInput
}

interface PostingContext extends HeldViews {
  raw: NativePostingMergeOutput
  outputs: PostingOutputs
  writes: readonly ArrayBufferView[]
  buffers: readonly ArrayBufferLike[]
  sources: Map<object, HeldSource>
}

const contexts = new WeakMap<object, PostingContext>()

function heldViews(views: unknown[]): HeldViews {
  return { views, lengths: views.map(view => (ArrayBuffer.isView(view) ? regionLength(view) : null)) }
}

function lengthsHeld(held: HeldViews): boolean {
  const { views, lengths } = held
  for (let at = 0; at < views.length; at++) {
    const length = lengths[at]
    if (length !== null && regionLength(views[at]) !== length) return false
  }
  return true
}

function sameOutput(raw: NativePostingMergeOutput, held: NativePostingMergeOutput): boolean {
  return (
    raw.documents === held.documents &&
    raw.frequencies === held.frequencies &&
    raw.fields === held.fields &&
    raw.positionOffsets === held.positionOffsets &&
    raw.positions === held.positions &&
    raw.totals === held.totals
  )
}

function sameStrings(left: NativeFrozenStrings | null, right: NativeFrozenStrings | null): boolean {
  if (left === null || right === null) return left === right
  return left.text === right.text && left.offsets === right.offsets && left.counts === right.counts
}

function sameSegment(raw: NativeKeywordMergeInput, held: NativeKeywordMergeInput): boolean {
  if (
    raw.documentCount !== held.documentCount ||
    raw.fieldMapping !== held.fieldMapping ||
    raw.payloadSlots !== held.payloadSlots ||
    raw.postingOffsets !== held.postingOffsets ||
    raw.mapping !== held.mapping ||
    raw.fieldLengths.length !== held.fieldLengths.length ||
    !sameStrings(raw.terms, held.terms) ||
    !sameStrings(raw.surfaces, held.surfaces) ||
    !sameStrings(raw.spellings, held.spellings)
  ) {
    return false
  }
  for (let at = 0; at < raw.fieldLengths.length; at++) {
    if (raw.fieldLengths[at] !== held.fieldLengths[at]) return false
  }
  return true
}

function stringViews(strings: NativeFrozenStrings | null): unknown[] {
  return strings === null ? [] : [strings.text, strings.offsets, strings.counts]
}

function segmentViews(input: NativeKeywordMergeInput): unknown[] {
  return [
    ...stringViews(input.terms),
    input.fieldMapping,
    input.payloadSlots,
    input.postingOffsets,
    input.mapping,
    ...stringViews(input.surfaces),
    ...stringViews(input.spellings),
    ...input.fieldLengths,
  ]
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

function contextOf(key: object, target: NativePostingMergeOutput): PostingContext {
  const held = contexts.get(key)
  if (held !== undefined && sameOutput(target, held.raw) && lengthsHeld(held)) return held
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
  const context = {
    ...heldViews([
      target.documents,
      target.frequencies,
      target.fields,
      target.positionOffsets,
      target.positions,
      target.totals,
    ]),
    raw: target,
    outputs,
    writes,
    buffers: writes.map(output => output.buffer),
    sources: new Map<object, HeldSource>(),
  }
  contexts.set(key, context)
  return context
}

function sourceOf(
  context: PostingContext,
  key: object,
  input: NativeKeywordMergeInput,
  target: NativePostingMergeOutput,
): NativeKeywordMergeInput {
  const held = context.sources.get(key)
  if (held !== undefined && sameSegment(input, held.raw) && lengthsHeld(held)) return held.prepared
  const regions = new MergeRegions()
  const prepared = regions.source(input)
  readOutputs(regions, target)
  regions.check()
  context.sources.set(key, { ...heldViews(segmentViews(input)), raw: input, prepared })
  return prepared
}

function tokenRegion<K extends 'Uint16Array' | 'Uint32Array'>(
  context: PostingContext,
  value: unknown,
  kind: K,
  length?: number,
): NonNullable<ReturnType<typeof typedRegion<K>>> {
  const view = typedRegion(value, kind)
  requireSegment(view !== null && (length === undefined || view.length === length))
  const { writes, buffers } = context
  const buffer = view.buffer
  for (let at = 0; at < writes.length; at++) {
    if (buffers[at] === buffer) requireSegment(!regionsOverlap(writes[at], view))
  }
  return view
}

function prepareToken(
  context: PostingContext,
  input: NativeKeywordMergeInput,
  prepared: NativeKeywordMergeInput,
): void {
  const postingDocuments = tokenRegion(context, input.postingDocuments, 'Uint32Array')
  requireSegment(postingDocuments.length <= 0xffffffff)
  requireSegment((input.positionOffsets === null) === (input.positionValues === null))
  const positionOffsets =
    input.positionOffsets === null
      ? null
      : tokenRegion(context, input.positionOffsets, 'Uint32Array', postingDocuments.length + 1)
  const positionValues =
    input.positionValues === null ? null : tokenRegion(context, input.positionValues, 'Uint32Array')
  requireSegment(positionValues === null || positionValues.length <= 0xffffffff)
  prepared.postingDocuments = postingDocuments
  prepared.positionOffsets = positionOffsets
  prepared.positionValues = positionValues
  prepared.postingFrequencies = tokenRegion(context, input.postingFrequencies, 'Uint16Array', postingDocuments.length)
  prepared.postingFields = tokenRegion(context, input.postingFields, 'Uint16Array', postingDocuments.length)
}

export function preparePostingsInContext(
  key: object,
  target: NativePostingMergeOutput,
  rawInputs: readonly NativeKeywordMergeInput[],
  inputs: readonly NativeKeywordMergeInput[],
): PreparedPostings {
  const context = contextOf(key, target)
  const prepared: NativeKeywordMergeInput[] = []
  for (let at = 0; at < inputs.length; at++) {
    const input = inputs[at]
    const held = sourceOf(context, rawInputs[at], input, target)
    const source = prepared.includes(held) ? { ...held } : held
    prepareToken(context, input, source)
    prepared.push(source)
  }
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
