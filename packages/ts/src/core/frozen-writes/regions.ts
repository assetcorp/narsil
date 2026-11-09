import type {
  NativeFrozenSegment,
  NativeFrozenSegmentState,
  NativeFrozenStrings,
} from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { regionsOverlap } from '../regions'
import { requireSegment } from '../segment-writes/status'
import { regionLength, typedRegion } from '../stored-values/regions'
import {
  PENDING_DOCUMENTS,
  PENDING_HEADER_WORDS,
  PENDING_TOKEN_WORDS,
  PENDING_TOKENS,
  PENDING_UNITS,
  pendingSettled,
} from './pending'

type RegionKind = Parameters<typeof typedRegion>[1]

const NO_VIEWS: readonly ArrayBufferView[] = []

function copy<T extends object>(value: T): T {
  requireSegment(typeof value === 'object' && value !== null)
  return { ...value }
}

class Regions {
  readonly reads: ArrayBufferView[] = []
  readonly writes: ArrayBufferView[] = []
  private readonly writesByBuffer = new Map<ArrayBufferLike, ArrayBufferView[]>()
  private readonly readsByBuffer = new Map<ArrayBufferLike, ArrayBufferView[]>()
  private checkedWrites = 0
  private checkedReads = 0

  constructor(private readonly base: Regions | null = null) {}

  private readsOn(buffer: ArrayBufferLike): readonly ArrayBufferView[] {
    return this.readsByBuffer.get(buffer) ?? NO_VIEWS
  }

  array<K extends RegionKind>(value: unknown, kind: K, length?: number, write = false) {
    const array = typedRegion(value, kind)
    requireSegment(array !== null && (length === undefined || array.length === length))
    if (write) this.writes.push(array)
    else this.reads.push(array)
    return array
  }

  writesOn(buffer: ArrayBufferLike): readonly ArrayBufferView[] {
    return this.writesByBuffer.get(buffer) ?? NO_VIEWS
  }

  check(): void {
    const { base } = this
    for (; this.checkedWrites < this.writes.length; this.checkedWrites++) {
      const write = this.writes[this.checkedWrites]
      for (const held of this.writesOn(write.buffer)) requireSegment(!regionsOverlap(write, held))
      const sharing = this.writesByBuffer.get(write.buffer)
      if (sharing === undefined) this.writesByBuffer.set(write.buffer, [write])
      else sharing.push(write)
      for (const read of this.readsOn(write.buffer)) requireSegment(!regionsOverlap(write, read))
      if (base === null) continue
      for (const held of base.writesOn(write.buffer)) requireSegment(!regionsOverlap(write, held))
      for (const read of base.readsOn(write.buffer)) requireSegment(!regionsOverlap(write, read))
    }
    for (; this.checkedReads < this.reads.length; this.checkedReads++) {
      const read = this.reads[this.checkedReads]
      for (const held of this.writesOn(read.buffer)) requireSegment(!regionsOverlap(held, read))
      if (base !== null) for (const held of base.writesOn(read.buffer)) requireSegment(!regionsOverlap(held, read))
      const sharing = this.readsByBuffer.get(read.buffer)
      if (sharing === undefined) this.readsByBuffer.set(read.buffer, [read])
      else sharing.push(read)
    }
  }

  views(): ArrayBufferView[] {
    return [...(this.base?.views() ?? NO_VIEWS), ...this.reads, ...this.writes]
  }
}

function strings(value: NativeFrozenStrings, stride: number, regions: Regions): NativeFrozenStrings {
  const counts = regions.array(value.counts, 'Uint32Array')
  const text = regions.array(value.text, 'Uint8Array')
  requireSegment(counts.length <= 0xffffffff && text.length <= 0xffffffff)
  return {
    text,
    offsets: regions.array(value.offsets, 'Uint32Array', counts.length * stride + 1),
    counts,
  }
}

function checkText(units: Uint16Array, start: number, length: number): void {
  requireSegment(length <= 0x40000000 && start <= units.length && length <= units.length - start)
  const end = start + length
  for (let at = start; at < end; at++) {
    const unit = units[at]
    if (unit < 0xd800 || unit >= 0xe000) continue
    requireSegment(unit < 0xdc00 && ++at < end)
    requireSegment(units[at] >= 0xdc00 && units[at] < 0xe000)
  }
}

export function captureFrozen(input: NativeFrozenSegment, output: NativeFrozenSegmentState) {
  const captured = copy(input)
  const raw = {
    ...captured,
    terms: copy(captured.terms),
    surfaces: captured.surfaces === null ? null : copy(captured.surfaces),
    spellings: captured.spellings === null ? null : copy(captured.spellings),
    removalIndex: captured.removalIndex === null ? null : copy(captured.removalIndex),
  }
  const writable = copy(output)
  return { raw, writable }
}

type CapturedFrozen = ReturnType<typeof captureFrozen>

interface HeldFrozen {
  output: NativeFrozenSegmentState
  raws: readonly unknown[]
  lengths: readonly (number | null)[]
  segment: NativeFrozenSegment
  state: NativeFrozenSegmentState
  regions: Regions
}

const heldFrozen = new WeakMap<NativeFrozenSegment, HeldFrozen>()

function rawsOf({ raw, writable }: CapturedFrozen): unknown[] {
  const { terms, surfaces, spellings, removalIndex } = raw
  return [
    raw.documentCount,
    terms.text,
    terms.offsets,
    terms.counts,
    surfaces === null,
    surfaces?.text,
    surfaces?.offsets,
    surfaces?.counts,
    spellings === null,
    spellings?.text,
    spellings?.offsets,
    spellings?.counts,
    raw.postingDocuments,
    raw.payloadSlots,
    raw.postingOffsets,
    raw.postingFrequencies,
    raw.postingFields,
    raw.spellingTokens,
    removalIndex === null,
    removalIndex?.starts,
    removalIndex?.rows,
    removalIndex?.termOfSlot,
    writable.tombstones,
    writable.tombstoneCount,
    writable.removedDocuments,
    writable.removedOccurrences,
    writable.removedSurfaces,
    writable.removedSpellings,
    writable.pendingHeader,
    writable.pendingDocuments,
    writable.pendingTokens,
    writable.pendingUnits,
  ]
}

function stillHeld(raws: readonly unknown[], held: HeldFrozen): boolean {
  if (raws.length !== held.raws.length) return false
  for (let at = 0; at < raws.length; at++) {
    if (raws[at] !== held.raws[at]) return false
    const length = held.lengths[at]
    if (length !== null && regionLength(raws[at]) !== length) return false
  }
  return true
}

function readHeld(input: NativeFrozenSegment, output: NativeFrozenSegmentState, captured: CapturedFrozen): HeldFrozen {
  const raws = rawsOf(captured)
  const known = heldFrozen.get(input)
  if (known !== undefined && known.output === output && stillHeld(raws, known)) return known
  const { raw, writable } = captured
  const regions = new Regions()
  const documentCount = raw.documentCount
  requireSegment(Number.isInteger(documentCount) && documentCount >= 0 && documentCount <= 0xffffffff)
  const terms = strings(raw.terms, 1, regions)
  const surfaces = raw.surfaces === null ? null : strings(raw.surfaces, 2, regions)
  const spellings = raw.spellings === null ? null : strings(raw.spellings, 1, regions)
  const postingDocuments = regions.array(raw.postingDocuments, 'Uint32Array')
  requireSegment(postingDocuments.length <= 0xffffffff)
  const segment: NativeFrozenSegment = {
    terms,
    surfaces,
    spellings,
    postingDocuments,
    partialFields: new Uint8Array(0),
    documentCount,
    payloadSlots: regions.array(raw.payloadSlots, 'Uint32Array', terms.counts.length),
    postingOffsets: regions.array(raw.postingOffsets, 'Uint32Array', terms.counts.length + 1),
    postingFrequencies: regions.array(raw.postingFrequencies, 'Uint16Array', postingDocuments.length),
    postingFields: regions.array(raw.postingFields, 'Uint16Array', postingDocuments.length),
    spellingTokens: regions.array(raw.spellingTokens, 'Uint32Array', spellings?.counts.length ?? 0),
    removalIndex:
      raw.removalIndex === null
        ? null
        : {
            starts: regions.array(raw.removalIndex.starts, 'Uint32Array', documentCount + 1),
            rows: regions.array(raw.removalIndex.rows, 'Uint32Array', postingDocuments.length),
            termOfSlot: regions.array(raw.removalIndex.termOfSlot, 'Uint32Array', terms.counts.length),
          },
  }
  const state: NativeFrozenSegmentState = {
    tombstones: regions.array(writable.tombstones, 'Uint32Array', Math.max(1, Math.ceil(documentCount / 32)), true),
    tombstoneCount: regions.array(writable.tombstoneCount, 'Uint32Array', 1, true),
    removedDocuments: regions.array(writable.removedDocuments, 'Uint32Array', terms.counts.length, true),
    removedOccurrences: regions.array(writable.removedOccurrences, 'Float64Array', terms.counts.length, true),
    removedSurfaces: regions.array(writable.removedSurfaces, 'Uint32Array', surfaces?.counts.length ?? 0, true),
    removedSpellings: regions.array(writable.removedSpellings, 'Uint32Array', spellings?.counts.length ?? 0, true),
    pendingHeader: regions.array(writable.pendingHeader, 'Uint32Array', PENDING_HEADER_WORDS, true),
    pendingDocuments: regions.array(writable.pendingDocuments, 'Uint32Array', undefined, true),
    pendingTokens: regions.array(writable.pendingTokens, 'Uint32Array', undefined, true),
    pendingUnits: regions.array(writable.pendingUnits, 'Uint16Array', undefined, true),
  }
  requireSegment(state.pendingTokens.length % PENDING_TOKEN_WORDS === 0)
  regions.check()
  const held: HeldFrozen = { output, raws, lengths: raws.map(raw => regionLength(raw)), segment, state, regions }
  heldFrozen.set(input, held)
  return held
}

function readFrozen(
  input: NativeFrozenSegment,
  output: NativeFrozenSegmentState,
  ordinal: number | null,
  rawFields: readonly NativeFieldTokens[],
) {
  const captured = captureFrozen(input, output)
  requireSegment(Array.isArray(rawFields) && rawFields.length <= 65536)
  const fields = rawFields.map(copy)
  const held = readHeld(input, output, captured)
  const { segment, state } = held
  const documentCount = segment.documentCount
  requireSegment(ordinal === null || (Number.isInteger(ordinal) && ordinal >= 0 && ordinal < documentCount))
  const regions = new Regions(held.regions)
  const partialFields = regions.array(captured.raw.partialFields, 'Uint8Array')
  requireSegment(partialFields.length <= 65536 && fields.length <= partialFields.length)
  for (const flag of partialFields) requireSegment(flag <= 1)
  segment.partialFields = partialFields
  const header = state.pendingHeader
  requireSegment(
    header[PENDING_DOCUMENTS] <= state.pendingDocuments.length &&
      header[PENDING_TOKENS] <= state.pendingTokens.length / PENDING_TOKEN_WORDS &&
      header[PENDING_UNITS] <= state.pendingUnits.length,
  )
  let previous = -1
  for (const field of fields) {
    requireSegment(Number.isInteger(field.field) && field.field > previous && field.field < partialFields.length)
    field.tokens = regions.array(field.tokens, 'Uint32Array')
    field.units = regions.array(field.units, 'Uint16Array')
    requireSegment(
      field.tokens.length % 8 === 0 && field.tokens.length / 8 <= 0xffffffff && field.units.length <= 0xffffffff,
    )
    for (let at = 0; at < field.tokens.length; at += 8) {
      checkText(field.units, field.tokens[at + 1], field.tokens[at + 2])
      if (field.tokens[at + 3] !== 0xffffffff) checkText(field.units, field.tokens[at + 3], field.tokens[at + 4])
    }
    previous = field.field
  }
  regions.check()
  requireSegment(state.tombstoneCount[0] <= documentCount)
  return {
    segment,
    state,
    fields,
    get arrays() {
      return regions.views()
    },
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
  return readFrozen(input, output, ordinal, fields)
}

export function readFrozenSettle(input: NativeFrozenSegment, state: NativeFrozenSegmentState) {
  return readFrozen(input, state, null, [])
}

export function readFrozenSource(input: NativeFrozenSegment, state: NativeFrozenSegmentState) {
  const source = readFrozen(input, state, null, [])
  requireSegment(pendingSettled(source.state))
  return source
}
