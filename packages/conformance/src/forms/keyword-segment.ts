import { anyValue, type FieldCodec, listOfCodec, numbers, orNil, structCodec } from './codec'

const uint16s = numbers('uint16')
const uint32s = numbers('uint32')
const uint64s = numbers('uint64')
const float64s = numbers('float64')

const fieldLengthColumn = structCodec({ fields: { field: anyValue, lengths: uint32s } })
const valueColumn = structCodec({ fields: { field: anyValue, documents: uint32s, values: float64s } })
const booleanColumn = structCodec({ fields: { field: anyValue, trueDocuments: uint32s, falseDocuments: uint32s } })
const enumColumn = structCodec({ fields: { field: anyValue, values: anyValue, offsets: uint32s, documents: uint32s } })
const geopointColumn = structCodec({
  fields: { field: anyValue, documents: uint32s, latitudes: float64s, longitudes: float64s },
})
const patternColumn = structCodec({
  fields: { field: anyValue, documents: uint32s, runs: uint32s, offsets: uint32s, postings: uint32s },
})

export const surfaceFormColumn = structCodec({
  fields: { counts: uint32s },
  joined: [{ blob: 'text', offsets: 'offsets', kind: 'textPairs' }],
})

export const partialWordColumn = structCodec({
  fields: {
    fields: anyValue,
    tokens: uint32s,
    counts: uint32s,
    runs: uint32s,
    runOffsets: uint32s,
    runEntries: uint32s,
  },
  joined: [{ blob: 'text', offsets: 'offsets', kind: 'text' }],
})

export const COLUMN_CODECS: Record<string, FieldCodec> = {
  fieldLengths: listOfCodec(fieldLengthColumn),
  numeric: listOfCodec(valueColumn),
  sizes: listOfCodec(valueColumn),
  boolean: listOfCodec(booleanColumn),
  enum: listOfCodec(enumColumn),
  geopoint: listOfCodec(geopointColumn),
  pattern: listOfCodec(patternColumn),
  surfaceForms: orNil(surfaceFormColumn),
  partialWords: orNil(partialWordColumn),
}

export const keywordSegmentPayload = structCodec({
  fields: {
    v: anyValue,
    schema: anyValue,
    tombstones: anyValue,
    documentCount: anyValue,
    idOrder: uint32s,
    fieldNames: anyValue,
    documentFrequencies: uint32s,
    postingOffsets: uint32s,
    postingDocuments: uint32s,
    postingFrequencies: uint16s,
    postingFields: uint16s,
    positionOffsets: orNil(uint32s),
    positions: orNil(uint32s),
    ...COLUMN_CODECS,
    seqNos: uint64s,
    primaryTerms: uint64s,
  },
  joined: [
    { blob: 'ids', offsets: 'idOffsets', kind: 'text' },
    { blob: 'documents', offsets: 'documentOffsets', kind: 'packed' },
    { blob: 'tokens', offsets: 'tokenOffsets', kind: 'text' },
  ],
})
