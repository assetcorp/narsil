import type { NativeFieldMergeRegion, NativeFieldMergeSource } from '../../vector/native/types/field-merge'
import type { NativeStoredValues } from '../../vector/native/types/stored-values'
import { requireSegment } from '../segment-writes/status'
import { validStoredValue } from '../stored-values/read'
import { embedded, type FieldMergePlan, type MergeDocument, uint32 } from './regions'

function valuesOf(r: readonly NativeFieldMergeRegion[]): NativeStoredValues {
  return {
    shapes: r[0] as Uint8Array,
    starts: r[1] as Uint32Array,
    kinds: r[2] as Uint8Array,
    numbers: r[3] as Float64Array,
    textStart: r[4] as Uint32Array,
    textLength: r[5] as Uint32Array,
    units: r[6] as Uint16Array,
    bytes: r[7] as Uint8Array,
  }
}

export function storedPlan(
  sources: readonly NativeFieldMergeSource[],
  documents: readonly MergeDocument[],
): FieldMergePlan {
  let elements = 0
  let units = 0
  let bytes = 0
  const values = new Map(sources.map(source => [source, valuesOf(source.regions)]))
  for (const source of sources) {
    const field = values.get(source)
    requireSegment(field !== undefined)
    embedded(field.starts[0] === 0 && field.starts[field.shapes.length] === field.kinds.length)
    for (let ordinal = 0; ordinal < source.mapping.length; ordinal++) {
      embedded(validStoredValue(field, ordinal))
      if (source.mapping[ordinal] === 0xffffffff) continue
      const start = field.starts[ordinal]
      const end = field.starts[ordinal + 1]
      elements += end - start
      uint32(elements)
      for (let at = start; at < end; at++) {
        if (field.kinds[at] === 4) units += field.textLength[at]
        if (field.kinds[at] === 5) bytes += field.textLength[at]
        uint32(units)
        uint32(bytes)
      }
    }
  }
  uint32(documents.length + 1)
  const lengths = Uint32Array.of(
    documents.length,
    documents.length + 1,
    elements,
    elements,
    elements,
    elements,
    units,
    bytes,
  )
  const raw = new Map(
    sources.map(source => {
      const field = valuesOf(source.regions)
      return [source, new BigUint64Array(field.numbers.buffer, field.numbers.byteOffset, field.numbers.length)] as const
    }),
  )
  const inputs = documents.map(document => {
    const bits = raw.get(document.source)
    requireSegment(bits !== undefined)
    return { values: valuesOf(document.source.regions), ordinal: document.ordinal, bits }
  })
  return {
    lengths,
    publish(output): void {
      const out = valuesOf(output)
      const numberBits = new BigUint64Array(out.numbers.buffer, out.numbers.byteOffset, out.numbers.length)
      let element = 0
      let unit = 0
      let byte = 0
      out.starts[0] = 0
      for (let ordinal = 0; ordinal < inputs.length; ordinal++) {
        const { values: input, ordinal: source, bits: inputBits } = inputs[ordinal]
        out.shapes[ordinal] = input.shapes[source]
        for (let at = input.starts[source]; at < input.starts[source + 1]; at++, element++) {
          const kind = input.kinds[at]
          const start = input.textStart[at]
          const length = input.textLength[at]
          out.kinds[element] = kind
          numberBits[element] = inputBits[at]
          out.textStart[element] = start
          out.textLength[element] = length
          if (kind === 4) {
            out.textStart[element] = unit
            for (let at = 0; at < length; at++) out.units[unit + at] = input.units[start + at]
            unit += length
          } else if (kind === 5) {
            out.textStart[element] = byte
            for (let at = 0; at < length; at++) out.bytes[byte + at] = input.bytes[start + at]
            byte += length
          }
        }
        out.starts[ordinal + 1] = element
      }
    },
  }
}
