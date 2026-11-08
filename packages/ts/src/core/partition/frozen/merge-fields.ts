import { bitsetIterator, storedText } from '#platform/segment-merge-host'
import type { NativeFieldMergeRegion, NativeFieldMergeSource } from '../../../vector/native/types/field-merge'
import { mergeFieldRegions } from '../../field-merges/host'
import type { SegmentPayload } from '../segment-payload'
import type { SegmentRemap } from './merge-postings'

type FieldIndexes = Pick<SegmentPayload, 'numeric' | 'boolean' | 'enums' | 'geo' | 'pattern' | 'sizes'>

function fieldsOf(inputs: readonly SegmentRemap[], kind: keyof FieldIndexes): string[] {
  const fields = new Set<string>()
  for (const input of inputs) for (const entry of input.segment.arrays[kind]) fields.add(entry.fieldPath)
  return [...fields]
}

function sourceOf(input: SegmentRemap, regions: readonly NativeFieldMergeRegion[]): NativeFieldMergeSource {
  return {
    mapping: new Uint32Array(input.remap.buffer, input.remap.byteOffset, input.remap.length),
    regions,
  }
}

function numeric(inputs: readonly SegmentRemap[], count: number, kind: 'numeric' | 'sizes'): SegmentPayload['numeric'] {
  return fieldsOf(inputs, kind).map(fieldPath => {
    const sources = inputs.map(input => {
      const regions = (kind === 'numeric' ? input.segment.numericIndexes : input.segment.sizeIndexes)
        .get(fieldPath)
        ?.regions()
      return sourceOf(input, [regions?.values ?? new Float64Array(0), regions?.ordinals ?? new Uint32Array(0)])
    })
    const output = mergeFieldRegions(1, sources, count)
    return { fieldPath, values: output[0] as Float64Array, docIds: output[1] as Uint32Array }
  })
}

function boolean(inputs: readonly SegmentRemap[], count: number): SegmentPayload['boolean'] {
  return fieldsOf(inputs, 'boolean').map(fieldPath => {
    const sources = inputs.map(input => {
      const regions = input.segment.booleanIndexes.get(fieldPath)?.regions(input.remap.length)
      const words = Math.max(1, Math.ceil(input.remap.length / 32))
      return sourceOf(input, [
        regions?.trueBits ?? new Uint32Array(words),
        regions?.falseBits ?? new Uint32Array(words),
      ])
    })
    const output = mergeFieldRegions(2, sources, count)
    return {
      fieldPath,
      trueDocs: Uint32Array.from(bitsetIterator(output[0] as Uint32Array)),
      falseDocs: Uint32Array.from(bitsetIterator(output[1] as Uint32Array)),
    }
  })
}

function enums(inputs: readonly SegmentRemap[], count: number): SegmentPayload['enums'] {
  return fieldsOf(inputs, 'enums').map(fieldPath => {
    const sources = inputs.map(input => {
      const regions = input.segment.enumIndexes.get(fieldPath)?.regions()
      return sourceOf(input, [
        regions?.units ?? new Uint16Array(0),
        regions?.offsets ?? new Uint32Array(1),
        regions?.postingOffsets ?? new Uint32Array(1),
        regions?.postings ?? new Uint32Array(0),
        regions?.suffixOrder ?? new Uint32Array(0),
      ])
    })
    const output = mergeFieldRegions(3, sources, count)
    const units = output[0] as Uint16Array
    const offsets = output[1] as Uint32Array
    const values: string[] = []
    for (let at = 0; at < offsets.length - 1; at++)
      values.push(storedText(units, offsets[at], offsets[at + 1] - offsets[at]))
    return { fieldPath, values, offsets: output[2] as Uint32Array, docIds: output[3] as Uint32Array }
  })
}

function geo(inputs: readonly SegmentRemap[], count: number): SegmentPayload['geo'] {
  return fieldsOf(inputs, 'geo').map(fieldPath => {
    const sources = inputs.map(input => {
      const regions = input.segment.geoIndexes.get(fieldPath)?.regions()
      return sourceOf(input, [
        regions?.codes ?? new BigUint64Array(0),
        regions?.lat ?? new Float64Array(0),
        regions?.lon ?? new Float64Array(0),
        regions?.ordinals ?? new Uint32Array(0),
      ])
    })
    const output = mergeFieldRegions(4, sources, count)
    return {
      fieldPath,
      latitudes: output[1] as Float64Array,
      longitudes: output[2] as Float64Array,
      docIds: output[3] as Uint32Array,
    }
  })
}

function pattern(inputs: readonly SegmentRemap[], count: number): SegmentPayload['pattern'] {
  return fieldsOf(inputs, 'pattern').map(fieldPath => {
    const sources = inputs.map(input => {
      const regions = input.segment.arrays.pattern.find(entry => entry.fieldPath === fieldPath)
      return sourceOf(input, [
        regions?.docIds ?? new Uint32Array(0),
        regions?.runs ?? new Uint32Array(0),
        regions?.offsets ?? new Uint32Array(1),
        regions?.postings ?? new Uint32Array(0),
      ])
    })
    const output = mergeFieldRegions(6, sources, count)
    return {
      fieldPath,
      docIds: output[0] as Uint32Array,
      runs: output[1] as Uint32Array,
      offsets: output[2] as Uint32Array,
      postings: output[3] as Uint32Array,
    }
  })
}

export function mergeFieldIndexes(inputs: readonly SegmentRemap[], documentCount: number): FieldIndexes {
  return {
    numeric: numeric(inputs, documentCount, 'numeric'),
    boolean: boolean(inputs, documentCount),
    enums: enums(inputs, documentCount),
    geo: geo(inputs, documentCount),
    pattern: pattern(inputs, documentCount),
    sizes: numeric(inputs, documentCount, 'sizes'),
  }
}
