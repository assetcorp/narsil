import { embedded, numbers, uint32, words } from '#platform/segment-merge-host'
import type { NativeFieldMergeSource } from '../../vector/native/types/field-merge'
import type { FieldMergePlan, MergeDocument } from './regions'

interface Row {
  source: NativeFieldMergeSource
  at: number
  ordinal: number
  value: number
  code: bigint
  bits: bigint
}

export function rowPlan(sources: readonly NativeFieldMergeSource[], geo: boolean): FieldMergePlan {
  const rows: Row[] = []
  for (const source of sources) {
    const ordinals = words(source, geo ? 3 : 1)
    const values = numbers(source, geo ? 1 : 0)
    const codes = geo ? (source.regions[0] as BigUint64Array) : null
    const raw = new BigUint64Array(values.buffer, values.byteOffset, values.length)
    for (let at = 0; at < ordinals.length; at++) {
      const ordinal = ordinals[at]
      embedded(ordinal < source.mapping.length)
      if (!geo) embedded(!Number.isNaN(values[at]))
      if (geo) {
        const longitude = numbers(source, 2)[at]
        embedded(
          Number.isFinite(values[at]) &&
            values[at] >= -90 &&
            values[at] <= 90 &&
            Number.isFinite(longitude) &&
            longitude >= -180 &&
            longitude <= 180,
        )
      }
      const target = source.mapping[ordinal]
      if (target !== 0xffffffff)
        rows.push({ source, at, ordinal: target, value: values[at], code: codes?.[at] ?? 0n, bits: raw[at] })
    }
  }
  uint32(rows.length)
  rows.sort((left, right) => {
    if (geo) {
      if (left.code !== right.code) return left.code < right.code ? -1 : 1
    } else {
      if (Number.isNaN(left.value) !== Number.isNaN(right.value)) return Number.isNaN(left.value) ? 1 : -1
      if (left.value < right.value) return -1
      if (left.value > right.value) return 1
    }
    return left.ordinal - right.ordinal
  })
  const lengths = new Uint32Array(8)
  lengths.fill(rows.length, 0, geo ? 4 : 2)
  return {
    lengths,
    publish(output): void {
      const values = output[geo ? 1 : 0] as Float64Array
      const valueBits = new BigUint64Array(values.buffer, values.byteOffset, values.length)
      const ordinals = output[geo ? 3 : 1] as Uint32Array
      for (let at = 0; at < rows.length; at++) {
        const row = rows[at]
        valueBits[at] = row.bits
        ordinals[at] = row.ordinal
        if (geo) {
          ;(output[0] as BigUint64Array)[at] = row.code
          ;(output[2] as Float64Array)[at] = numbers(row.source, 2)[row.at]
        }
      }
    },
  }
}

export function booleanPlan(documents: readonly MergeDocument[]): FieldMergePlan {
  const lengths = new Uint32Array(8)
  lengths[0] = lengths[1] = Math.max(1, Math.ceil(documents.length / 32))
  return {
    lengths,
    publish(output): void {
      for (let value = 0; value < 2; value++) {
        const bits = output[value] as Uint32Array
        bits.fill(0, 0, lengths[value])
        for (let ordinal = 0; ordinal < documents.length; ordinal++) {
          const document = documents[ordinal]
          const input = words(document.source, value)
          if ((input[document.ordinal >>> 5] & (1 << (document.ordinal & 31))) !== 0)
            bits[ordinal >>> 5] |= 1 << (ordinal & 31)
        }
      }
    },
  }
}
