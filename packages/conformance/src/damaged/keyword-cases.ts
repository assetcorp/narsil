import { type CaseBuild, damagedCheckpoint } from './build'
import {
  baseFile,
  bytesAt,
  float64s,
  listAt,
  mapAt,
  packedFloat64s,
  packedUint32s,
  packedUint64s,
  type RawMap,
  rewritten,
  uint32s,
} from './bytes'

const INDEX = 'products'
const SEGMENT = 'segments/0/s0000000000000001'
const LOAD_FAILED = 'PERSISTENCE_LOAD_FAILED'
const RULE = 'envelope.md#keyword-segment-payload'
const INVALID_UTF8 = 0xff
const RUN_CODE_POINTS = 3
const NEWER_PAYLOAD_LAYOUT = 2

type Change = (payload: RawMap) => void

function words(payload: RawMap, key: string): number[] {
  return uint32s(bytesAt(payload[key], key))
}

function setWords(target: RawMap, key: string, values: readonly number[]): void {
  target[key] = packedUint32s(values)
}

function changedWords(key: string, change: (values: number[]) => void): Change {
  return payload => {
    const values = words(payload, key)
    change(values)
    setWords(payload, key, values)
  }
}

function columnOf(payload: RawMap, list: string): RawMap {
  return mapAt(listAt(payload[list], list)[0], `${list}[0]`)
}

function inColumn(list: string, change: (column: RawMap) => void): Change {
  return payload => change(columnOf(payload, list))
}

function swapped<T>(values: T[], left: number, right: number): void {
  const held = values[left]
  const other = values[right]
  if (held === undefined || other === undefined) throw new Error(`no values at ${left} and ${right}`)
  values[left] = other
  values[right] = held
}

function textEntries(text: Uint8Array, offsets: readonly number[]): Uint8Array[] {
  return offsets.slice(0, -1).map((start, at) => text.slice(start, offsets[at + 1]))
}

function withSwappedEntries(target: RawMap, textKey: string, offsetsKey: string, left: number, right: number) {
  const entries = textEntries(bytesAt(target[textKey], textKey), words(target, offsetsKey))
  swapped(entries, left, right)
  const offsets = [0]
  for (const entry of entries) offsets.push((offsets.at(-1) ?? 0) + entry.byteLength)
  const text = new Uint8Array(offsets.at(-1) ?? 0)
  for (const [at, entry] of entries.entries()) text.set(entry, offsets[at] ?? 0)
  target[textKey] = text
  setWords(target, offsetsKey, offsets)
}

function withInvalidByte(key: string): Change {
  return payload => {
    const bytes = bytesAt(payload[key], key).slice()
    bytes[0] = INVALID_UTF8
    payload[key] = bytes
  }
}

function swappedRuns(target: RawMap, key: string): void {
  const runs = words(target, key)
  const first = runs.slice(0, RUN_CODE_POINTS)
  runs.splice(0, RUN_CODE_POINTS, ...runs.slice(RUN_CODE_POINTS, 2 * RUN_CODE_POINTS))
  runs.splice(RUN_CODE_POINTS, RUN_CODE_POINTS, ...first)
  setWords(target, key, runs)
}

function swappedMembersOfFirstLongRun(target: RawMap, offsetsKey: string, membersKey: string): void {
  const offsets = words(target, offsetsKey)
  const members = words(target, membersKey)
  const run = offsets.findIndex((start, at) => (offsets[at + 1] ?? start) - start >= 2)
  if (run < 0) throw new Error(`${membersKey} holds no run with two members`)
  const start = offsets[run] ?? 0
  swapped(members, start, start + 1)
  setWords(target, membersKey, members)
}

function postingCountOfFirstToken(payload: RawMap): number {
  const offsets = words(payload, 'postingOffsets')
  return (offsets[1] ?? 0) - (offsets[0] ?? 0)
}

const KEYWORD_CHANGES: Record<string, Change> = {
  'segment-bytes-not-whole-values': payload => {
    payload.postingFrequencies = bytesAt(payload.postingFrequencies, 'postingFrequencies').slice(0, -1)
  },
  'segment-offsets-start-above-zero': changedWords('tokenOffsets', values => {
    values[0] = 1
  }),
  'segment-offsets-decrease': changedWords('idOffsets', values => {
    values[1] = (values[2] ?? 0) + 1
  }),
  'segment-offsets-end-short': changedWords('documentOffsets', values => {
    values[values.length - 1] = (values.at(-1) ?? 1) - 1
  }),
  'segment-column-count': changedWords('documentFrequencies', values => {
    values.pop()
  }),
  'segment-ids-not-utf8': withInvalidByte('ids'),
  'segment-tokens-not-utf8': withInvalidByte('tokens'),
  'segment-surface-text-not-utf8': payload => withInvalidByte('text')(mapAt(payload.surfaceForms, 'surfaceForms')),
  'segment-ordinal-past-document-count': payload => {
    const values = words(payload, 'postingDocuments')
    values[0] = Number(payload.documentCount)
    setWords(payload, 'postingDocuments', values)
  },
  'segment-posting-field-past-field-names': payload => {
    const fields = bytesAt(payload.postingFields, 'postingFields').slice()
    new DataView(fields.buffer).setUint16(0, listAt(payload.fieldNames, 'fieldNames').length, true)
    payload.postingFields = fields
  },
  'segment-id-order-repeats': changedWords('idOrder', values => {
    values[1] = values[0] ?? 0
  }),
  'segment-document-frequency-zero': changedWords('documentFrequencies', values => {
    values[0] = 0
  }),
  'segment-document-frequency-above-postings': payload => {
    const values = words(payload, 'documentFrequencies')
    values[0] = postingCountOfFirstToken(payload) + 1
    setWords(payload, 'documentFrequencies', values)
  },
  'segment-tokens-not-ascending': payload => withSwappedEntries(payload, 'tokens', 'tokenOffsets', 0, 1),
  'segment-ids-not-ascending': changedWords('idOrder', values => swapped(values, 0, 1)),
  'segment-pattern-runs-not-ascending': inColumn('pattern', column => swappedRuns(column, 'runs')),
  'segment-pattern-documents-not-ascending': inColumn('pattern', column => {
    const values = words(column, 'documents')
    swapped(values, 0, 1)
    setWords(column, 'documents', values)
  }),
  'segment-pattern-run-postings-not-ascending': inColumn('pattern', column =>
    swappedMembersOfFirstLongRun(column, 'offsets', 'postings'),
  ),
  'segment-enum-value-twice': inColumn('enum', column => {
    const values = listAt(column.values, 'values')
    values[1] = values[0]
  }),
  'segment-value-column-descends': inColumn('numeric', column => {
    const values = float64s(bytesAt(column.values, 'values'))
    values[0] = (values.at(-1) ?? 0) + 1
    column.values = packedFloat64s(values)
  }),
  'segment-value-column-nan': inColumn('numeric', column => {
    const values = float64s(bytesAt(column.values, 'values'))
    values[0] = Number.NaN
    column.values = packedFloat64s(values)
  }),
  'segment-latitude-out-of-range': inColumn('geopoint', column => {
    const values = float64s(bytesAt(column.latitudes, 'latitudes'))
    values[0] = 90.5
    column.latitudes = packedFloat64s(values)
  }),
  'segment-longitude-out-of-range': inColumn('geopoint', column => {
    const values = float64s(bytesAt(column.longitudes, 'longitudes'))
    values[0] = -180.5
    column.longitudes = packedFloat64s(values)
  }),
  'segment-positions-without-offsets': payload => {
    payload.positionOffsets = null
  },
  'segment-partial-token-past-tokens': payload => {
    const column = mapAt(payload.partialWords, 'partialWords')
    const values = words(column, 'tokens')
    values[0] = words(payload, 'tokenOffsets').length - 1
    setWords(column, 'tokens', values)
  },
  'segment-partial-count-zero': payload =>
    changedWords('counts', values => {
      values[0] = 0
    })(mapAt(payload.partialWords, 'partialWords')),
  'segment-partial-run-entry-past-entries': payload => {
    const column = mapAt(payload.partialWords, 'partialWords')
    const values = words(column, 'runEntries')
    values[0] = words(column, 'tokens').length
    setWords(column, 'runEntries', values)
  },
  'segment-partial-entries-not-ascending': payload => {
    const column = mapAt(payload.partialWords, 'partialWords')
    withSwappedEntries(column, 'text', 'offsets', 0, 1)
    const tokens = words(column, 'tokens')
    const counts = words(column, 'counts')
    swapped(tokens, 0, 1)
    swapped(counts, 0, 1)
    setWords(column, 'tokens', tokens)
    setWords(column, 'counts', counts)
  },
  'segment-partial-runs-not-ascending': payload => swappedRuns(mapAt(payload.partialWords, 'partialWords'), 'runs'),
  'segment-partial-run-members-not-ascending': payload =>
    swappedMembersOfFirstLongRun(mapAt(payload.partialWords, 'partialWords'), 'runOffsets', 'runEntries'),
  'segment-seq-nos-without-primary-terms': payload => {
    payload.seqNos = packedUint64s(Array.from({ length: Number(payload.documentCount) }, (_, at) => at + 1))
  },
  'segment-primary-term-without-seq-no': payload => {
    const count = Number(payload.documentCount)
    payload.seqNos = packedUint64s(Array.from({ length: count }, (_, at) => at))
    payload.primaryTerms = packedUint64s(Array.from({ length: count }, () => 1))
  },
}

const SCHEMA_CHANGES: Record<string, [string, string, string]> = {
  'schema-unknown-base-type': ['title', 'text', 'SCHEMA_INVALID_TYPE'],
  'schema-option-outside-its-row': ['price', 'number:sortable', 'SCHEMA_INVALID_TYPE'],
  'schema-option-twice': ['title', 'string:pattern:pattern', 'SCHEMA_INVALID_TYPE'],
  'schema-vector-dimension-zero': ['embedding', 'vector[0]', 'SCHEMA_INVALID_VECTOR_DIMENSION'],
  'schema-vector-dimension-too-wide': ['embedding', 'vector[65536]', 'SCHEMA_INVALID_VECTOR_DIMENSION'],
  'schema-vector-dimension-fraction': ['embedding', 'vector[1.5]', 'SCHEMA_INVALID_VECTOR_DIMENSION'],
  'schema-vector-dimension-negative': ['embedding', 'vector[-1]', 'SCHEMA_INVALID_VECTOR_DIMENSION'],
}

export async function keywordSegmentCases(): Promise<CaseBuild[]> {
  const segment = await baseFile(INDEX, SEGMENT)
  const builds: CaseBuild[] = []
  for (const [name, change] of Object.entries(KEYWORD_CHANGES)) {
    const bytes = await rewritten(segment, name, change)
    builds.push(damagedCheckpoint(name, RULE, LOAD_FAILED, INDEX, { [SEGMENT]: bytes }))
  }
  const newerLayout = await rewritten(segment, 'segment-layout-newer', payload => {
    payload.v = NEWER_PAYLOAD_LAYOUT
  })
  builds.push(
    damagedCheckpoint('segment-layout-newer', 'envelope.md#payload-format', 'ENVELOPE_VERSION_MISMATCH', INDEX, {
      [SEGMENT]: newerLayout,
    }),
  )
  for (const [name, [field, type, code]] of Object.entries(SCHEMA_CHANGES)) {
    const bytes = await rewritten(segment, name, payload => {
      mapAt(payload.schema, 'schema')[field] = type
    })
    builds.push(damagedCheckpoint(name, 'envelope.md#field-types', code, INDEX, { [SEGMENT]: bytes }))
  }
  return builds
}
