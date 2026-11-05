import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encode } from '@msgpack/msgpack'
import { createSharedFrozenSegment, shareSegmentArrays } from '../../../ts/src/core/partition/frozen'
import { createDurableDirectory } from '../../../ts/src/persistence/durability/durable-filesystem'
import { PAGED_SEGMENT_ENVELOPE_VERSION } from '../../../ts/src/persistence/paged/format'
import { writePagedSegment } from '../../../ts/src/persistence/paged/write-segment'
import { decodeKeywordSegment } from '../../../ts/src/serialization/keyword-segment/decode'
import { KEYWORD_SEGMENT_PAYLOAD_VERSION } from '../../../ts/src/serialization/keyword-segment/types'
import { FormError } from '../forms/decoded'
import { headerFromJson } from '../forms/header'
import type { Json, JsonObject } from '../forms/json'
import { keywordSegmentPayload } from '../forms/keyword-segment'
import { plainOf, referenceContext } from './context'
import { objectAt } from './write-envelopes'

const PAGED_SEGMENT_KEY = 'conformance/segments/0/s0000000000000000'
const HEAD_KEYS = ['schema', 'tombstones', 'documentCount', 'fieldNames'] as const
const REQUIRED_SECTIONS = [
  'ids',
  'documents',
  'tokens',
  'idOrder',
  'documentFrequencies',
  'postingOffsets',
  'postingDocuments',
  'postingFrequencies',
  'postingFields',
  'fieldLengths',
  'numeric',
  'sizes',
  'boolean',
  'enum',
  'geopoint',
  'pattern',
] as const
const NIL_WHEN_ABSENT = ['positionOffsets', 'positions', 'surfaceForms', 'partialWords'] as const
const WRITE_RECORD_SECTIONS = ['seqNos', 'primaryTerms'] as const

function keywordPayloadOfPaged(json: JsonObject, what: string): JsonObject {
  const head = objectAt(json.head, `${what}.head`)
  const sections = objectAt(json.sections, `${what}.sections`)
  const payload: JsonObject = { v: KEYWORD_SEGMENT_PAYLOAD_VERSION }
  for (const key of HEAD_KEYS) {
    const value = head[key]
    if (value === undefined) throw new FormError(`${what}.head has no ${key}`)
    payload[key] = value
  }
  for (const name of REQUIRED_SECTIONS) {
    const value = sections[name]
    if (value === undefined) throw new FormError(`${what}.sections has no ${name}`)
    payload[name] = value
  }
  for (const name of NIL_WHEN_ABSENT) payload[name] = sections[name] ?? null
  for (const name of WRITE_RECORD_SECTIONS) {
    const value: Json | undefined = sections[name]
    if (value !== undefined) payload[name] = value
  }
  return payload
}

export async function writePagedSegmentFile(json: JsonObject, what: string): Promise<Uint8Array> {
  const header = headerFromJson(json.header, `${what} header`)
  if (
    header.envelopeFormatVersion !== PAGED_SEGMENT_ENVELOPE_VERSION ||
    header.compression !== 'none' ||
    !header.checksum
  ) {
    throw new FormError(
      `${what} header must name version 6, uncompressed, with a checksum, as every paged segment does`,
    )
  }
  const decoded = keywordSegmentPayload.fromJson(keywordPayloadOfPaged(json, what), what, referenceContext)
  const contents = decodeKeywordSegment(encode(plainOf(decoded, what)), false)
  const segment = createSharedFrozenSegment(shareSegmentArrays(contents.arrays, null))
  const root = await mkdtemp(join(tmpdir(), 'narsil-conformance-paged-'))
  try {
    await writePagedSegment({
      directory: createDurableDirectory(root),
      key: PAGED_SEGMENT_KEY,
      schema: contents.schema,
      tombstones: contents.tombstones,
      selections: [{ segment }],
      partialWordAnalysis: null,
      textAnalysis: null,
      ...(contents.writeRecords === undefined ? {} : { writeRecords: new Map([[segment, contents.writeRecords]]) }),
    })
    return new Uint8Array(await readFile(join(root, PAGED_SEGMENT_KEY)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
