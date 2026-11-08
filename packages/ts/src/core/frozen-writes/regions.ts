import type {
  NativeFrozenSegment,
  NativeFrozenSegmentState,
  NativeFrozenStrings,
} from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { regionsOverlap } from '../regions'
import { requireSegment } from '../segment-writes/status'
import { typedRegion } from '../stored-values/regions'

type RegionKind = Parameters<typeof typedRegion>[1]

function copy<T extends object>(value: T): T {
  requireSegment(typeof value === 'object' && value !== null)
  return { ...value }
}

class Regions {
  readonly reads: ArrayBufferView[] = []
  readonly writes: ArrayBufferView[] = []

  array<K extends RegionKind>(value: unknown, kind: K, length?: number, write = false) {
    const array = typedRegion(value, kind)
    requireSegment(array !== null && (length === undefined || array.length === length))
    if (write) this.writes.push(array)
    else this.reads.push(array)
    return array
  }

  check(): void {
    for (let at = 0; at < this.writes.length; at++) {
      for (let previous = 0; previous < at; previous++)
        requireSegment(!regionsOverlap(this.writes[at], this.writes[previous]))
      for (const read of this.reads) requireSegment(!regionsOverlap(this.writes[at], read))
    }
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

function readFrozen(
  input: NativeFrozenSegment,
  output: NativeFrozenSegmentState,
  ordinal: number | null,
  rawFields: readonly NativeFieldTokens[],
) {
  const { raw, writable } = captureFrozen(input, output)
  requireSegment(Array.isArray(rawFields) && rawFields.length <= 65536)
  const fields = rawFields.map(copy)
  const regions = new Regions()
  const documentCount = raw.documentCount
  requireSegment(Number.isInteger(documentCount) && documentCount >= 0 && documentCount <= 0xffffffff)
  requireSegment(ordinal === null || (Number.isInteger(ordinal) && ordinal >= 0 && ordinal < documentCount))
  const terms = strings(raw.terms, 1, regions)
  const surfaces = raw.surfaces === null ? null : strings(raw.surfaces, 2, regions)
  const spellings = raw.spellings === null ? null : strings(raw.spellings, 1, regions)
  const postingDocuments = regions.array(raw.postingDocuments, 'Uint32Array')
  requireSegment(postingDocuments.length <= 0xffffffff)
  const partialFields = regions.array(raw.partialFields, 'Uint8Array')
  requireSegment(partialFields.length <= 65536 && fields.length <= partialFields.length)
  for (const flag of partialFields) requireSegment(flag <= 1)
  const segment: NativeFrozenSegment = {
    terms,
    surfaces,
    spellings,
    postingDocuments,
    partialFields,
    documentCount,
    payloadSlots: regions.array(raw.payloadSlots, 'Uint32Array', terms.counts.length),
    postingOffsets: regions.array(raw.postingOffsets, 'Uint32Array', terms.counts.length + 1),
    postingFrequencies: regions.array(raw.postingFrequencies, 'Uint16Array', postingDocuments.length),
    postingFields: regions.array(raw.postingFields, 'Uint16Array', postingDocuments.length),
    spellingTokens: regions.array(raw.spellingTokens, 'Uint32Array', spellings?.counts.length ?? 0),
    removalTerms: raw.removalTerms == null ? null : regions.array(raw.removalTerms, 'Uint32Array'),
    removalIndex:
      raw.removalIndex === null
        ? null
        : {
            starts: regions.array(raw.removalIndex.starts, 'Uint32Array', documentCount + 1),
            rows: regions.array(raw.removalIndex.rows, 'Uint32Array', postingDocuments.length),
            termOfSlot: regions.array(raw.removalIndex.termOfSlot, 'Uint32Array', terms.counts.length),
          },
  }
  if (segment.removalTerms != null) {
    requireSegment(segment.removalTerms.length % 2 === 0)
    for (let at = 0; at < segment.removalTerms.length; at += 2)
      requireSegment(
        segment.removalTerms[at] < terms.counts.length &&
          (at === 0 || segment.removalTerms[at] > segment.removalTerms[at - 2]),
      )
  }
  const state: NativeFrozenSegmentState = {
    tombstones: regions.array(writable.tombstones, 'Uint32Array', Math.max(1, Math.ceil(documentCount / 32)), true),
    tombstoneCount: regions.array(writable.tombstoneCount, 'Uint32Array', 1, true),
    removedDocuments: regions.array(writable.removedDocuments, 'Uint32Array', terms.counts.length, true),
    removedOccurrences: regions.array(writable.removedOccurrences, 'Float64Array', terms.counts.length, true),
    removedSurfaces: regions.array(writable.removedSurfaces, 'Uint32Array', surfaces?.counts.length ?? 0, true),
    removedSpellings: regions.array(writable.removedSpellings, 'Uint32Array', spellings?.counts.length ?? 0, true),
  }
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
    arrays: [...regions.reads, ...regions.writes],
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

export function readFrozenSource(input: NativeFrozenSegment, state: NativeFrozenSegmentState) {
  return readFrozen(input, state, null, [])
}
