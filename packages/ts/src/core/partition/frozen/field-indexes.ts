import { countBooleanFacet, countEnumFacet, countNumberFacet } from '../../../search/facets'
import { bitsetSet, createBitSet } from '../../bitset'
import type { BooleanFieldIndexReader, EnumFieldIndexReader, NumericFieldIndexReader } from '../../field-index'
import { buildEnumRegions, type EnumRegions, enumRegionBytes } from '../../field-index/enum-regions'
import { FieldPresence } from '../../field-index/presence'
import type { SegmentPayload } from '../segment-payload'

function bitsetOfRange(docIds: Uint32Array, from: number, to: number, capacity: number): Uint32Array {
  const bits = createBitSet(capacity)
  for (let i = from; i < to; i++) bitsetSet(bits, docIds[i])
  return bits
}

export function createFrozenNumericReader(entry: SegmentPayload['numeric'][number]): NumericFieldIndexReader {
  const { docIds, values } = entry
  const present = new FieldPresence(() => docIds)
  return {
    cachedBytes: () => present.bytes(),
    regions: () => ({ values, ordinals: docIds }),
    serialize: () => Array.from(docIds, (docId, i) => ({ docId, value: values[i] })),
    getAllDocIdsBitset: capacity => present.regions(capacity),
    count: () => docIds.length,
    facetValueCounts: matched => countNumberFacet({ values, ordinals: docIds }, matched),
  }
}

export function createFrozenBooleanReader(entry: SegmentPayload['boolean'][number]): BooleanFieldIndexReader {
  const { trueDocs, falseDocs } = entry
  const present = new FieldPresence(function* () {
    yield* trueDocs
    yield* falseDocs
  })
  let cached: { trueBits: Uint32Array; falseBits: Uint32Array } | null = null
  function regions(capacity: number): { trueBits: Uint32Array; falseBits: Uint32Array } {
    const words = Math.max(1, Math.ceil(capacity / 32))
    if (cached === null || cached.trueBits.length < words) {
      cached = {
        trueBits: bitsetOfRange(trueDocs, 0, trueDocs.length, capacity),
        falseBits: bitsetOfRange(falseDocs, 0, falseDocs.length, capacity),
      }
    }
    return cached
  }
  return {
    regions,
    regionBytes: () =>
      present.bytes() + (cached === null ? 0 : cached.trueBits.byteLength + cached.falseBits.byteLength),
    serialize: () => ({ trueDocs: [...trueDocs], falseDocs: [...falseDocs] }),
    getAllDocIdsBitset: capacity => present.regions(capacity),
    count: () => trueDocs.length + falseDocs.length,
    facetCounts: matched => {
      const bits = regions(matched.length * 32)
      return countBooleanFacet(bits.trueBits, bits.falseBits, matched)
    },
  }
}

export function createFrozenEnumReader(entry: SegmentPayload['enums'][number]): EnumFieldIndexReader {
  const { values, offsets, docIds } = entry
  const present = new FieldPresence(() => docIds)
  let held: EnumRegions | null = null
  function regions(): EnumRegions {
    held ??= buildEnumRegions(
      new Map(values.map((value, at) => [value, new Set(docIds.subarray(offsets[at], offsets[at + 1]))])),
    )
    return held
  }
  return {
    regions,
    regionBytes: () => present.bytes() + enumRegionBytes(held),
    serialize: () => {
      const byValue: Record<string, number[]> = Object.create(null)
      for (let i = 0; i < values.length; i++) {
        byValue[values[i]] = [...docIds.subarray(offsets[i], offsets[i + 1])]
      }
      return byValue
    },
    getAllDocIdsBitset: capacity => present.regions(capacity),
    count: () => docIds.length,
    facetCounts: matched => countEnumFacet(values, offsets, docIds, matched),
  }
}
