import type { NativeFrozenStrings } from '../../vector/native/types/frozen-segments'
import type { NativeKeywordMergeInput, NativeKeywordMergeOutput } from '../../vector/native/types/segment-merge'
import { regionsOverlap } from '../regions'
import { captureSegment, readMergeSegment } from '../segment-writes/regions'
import { requireSegment } from '../segment-writes/status'
import { typedRegion } from '../stored-values/regions'

interface MergeArrays {
  Uint8Array: Uint8Array
  Uint16Array: Uint16Array
  Uint32Array: Uint32Array
  Float64Array: Float64Array
}

type RegionKind = keyof MergeArrays

export function captureMergeObject<T extends object>(value: T): T {
  requireSegment(typeof value === 'object' && value !== null)
  return { ...value }
}

export function captureInputs(inputs: readonly NativeKeywordMergeInput[]): NativeKeywordMergeInput[] {
  requireSegment(Array.isArray(inputs))
  return inputs.map(input => {
    const value = captureMergeObject(input)
    requireSegment(Array.isArray(value.fieldLengths))
    return {
      ...value,
      growing: value.growing == null ? null : captureSegment(value.growing),
      terms: value.growing == null ? captureMergeObject(value.terms) : value.terms,
      surfaces: value.surfaces === null ? null : captureMergeObject(value.surfaces),
      spellings: value.spellings === null ? null : captureMergeObject(value.spellings),
      fieldLengths: [...value.fieldLengths],
    }
  })
}

export function captureOutput(input: NativeKeywordMergeOutput): NativeKeywordMergeOutput {
  const value = captureMergeObject(input)
  return {
    ...value,
    terms: captureMergeObject(value.terms),
    surfaces: captureMergeObject(value.surfaces),
    spellings: captureMergeObject(value.spellings),
  }
}

export function uint32(value: number): void {
  requireSegment(Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
}

export class MergeRegions {
  private readonly reads: ArrayBufferView[] = []
  private readonly writes: ArrayBufferView[] = []

  read<K extends RegionKind>(input: unknown, kind: K, length?: number, writable = false): MergeArrays[K] {
    const value = typedRegion(input, kind)
    requireSegment(value !== null && (length === undefined || value.length === length))
    ;(writable ? this.writes : this.reads).push(value)
    return value
  }

  check(): void {
    for (let at = 0; at < this.writes.length; at++) {
      const output = this.writes[at]
      for (let before = 0; before < at; before++) requireSegment(!regionsOverlap(output, this.writes[before]))
      for (const input of this.reads) requireSegment(!regionsOverlap(output, input))
    }
  }

  strings(input: NativeFrozenStrings, stride: number, writable = false): NativeFrozenStrings {
    const counts = this.read(input.counts, 'Uint32Array', undefined, writable)
    const text = this.read(input.text, 'Uint8Array', undefined, writable)
    const offsets = this.read(input.offsets, 'Uint32Array', writable ? undefined : counts.length * stride + 1, writable)
    if (!writable) requireSegment(counts.length <= 0xffffffff && text.length <= 0xffffffff)
    return { text, offsets, counts }
  }

  source(input: NativeKeywordMergeInput): NativeKeywordMergeInput {
    uint32(input.documentCount)
    const held = input.growing == null ? null : readMergeSegment(input.growing)
    if (held !== null) this.reads.push(...held.arrays)
    const growing = held?.segment ?? null
    const terms = growing === null ? this.strings(input.terms, 1) : input.terms
    const fieldMapping = this.read(input.fieldMapping, 'Uint16Array', input.fieldLengths.length)
    requireSegment(fieldMapping.length <= 65536)
    requireSegment(
      growing === null ||
        (growing.ordinalCapacity >= input.documentCount && growing.partialFields.length === fieldMapping.length),
    )
    const postingRegions = growing === null ? this : new MergeRegions()
    const postingDocuments = postingRegions.read(input.postingDocuments, 'Uint32Array')
    requireSegment(postingDocuments.length <= 0xffffffff)
    const fieldLengths = input.fieldLengths.map(value =>
      value === null ? null : this.read(value, 'Uint32Array', input.documentCount),
    )
    const positions = postingRegions.positions(input, false, postingDocuments.length + 1)
    return {
      growing,
      terms,
      fieldMapping,
      fieldLengths,
      postingDocuments,
      postingFrequencies: postingRegions.read(input.postingFrequencies, 'Uint16Array', postingDocuments.length),
      postingFields: postingRegions.read(input.postingFields, 'Uint16Array', postingDocuments.length),
      payloadSlots: postingRegions.read(
        input.payloadSlots,
        'Uint32Array',
        growing === null ? terms.counts.length : undefined,
      ),
      postingOffsets: postingRegions.read(
        input.postingOffsets,
        'Uint32Array',
        growing === null ? terms.counts.length + 1 : undefined,
      ),
      mapping: this.read(input.mapping, 'Uint32Array', input.documentCount),
      documentCount: input.documentCount,
      surfaces: input.surfaces === null ? null : this.strings(input.surfaces, 2),
      spellings: input.spellings === null ? null : this.strings(input.spellings, 2),
      ...positions,
    }
  }

  output(input: NativeKeywordMergeOutput): NativeKeywordMergeOutput {
    const postingDocuments = this.read(input.postingDocuments, 'Uint32Array', undefined, true)
    return {
      terms: this.strings(input.terms, 1, true),
      surfaces: this.strings(input.surfaces, 2, true),
      spellings: this.strings(input.spellings, 2, true),
      postingDocuments,
      postingOffsets: this.read(input.postingOffsets, 'Uint32Array', undefined, true),
      postingFrequencies: this.read(input.postingFrequencies, 'Uint16Array', postingDocuments.length, true),
      postingFields: this.read(input.postingFields, 'Uint16Array', postingDocuments.length, true),
      fieldLengths: this.read(input.fieldLengths, 'Uint32Array', undefined, true),
      totalFieldLengths: this.read(input.totalFieldLengths, 'Float64Array', undefined, true),
      ...this.positions(input, true),
    }
  }

  private positions(
    input: Pick<NativeKeywordMergeInput, 'positionOffsets' | 'positionValues'>,
    writable: boolean,
    count?: number,
  ) {
    requireSegment((input.positionOffsets === null) === (input.positionValues === null))
    const positionOffsets =
      input.positionOffsets === null ? null : this.read(input.positionOffsets, 'Uint32Array', count, writable)
    const positionValues =
      input.positionValues === null ? null : this.read(input.positionValues, 'Uint32Array', undefined, writable)
    if (!writable) requireSegment(positionValues === null || positionValues.length <= 0xffffffff)
    return { positionOffsets, positionValues }
  }
}
