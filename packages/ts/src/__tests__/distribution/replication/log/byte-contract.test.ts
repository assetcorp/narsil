import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { buildEntry, computeEntryChecksum } from '../../../../distribution/replication/entry-checksum'
import type { ReplicationLogEntry } from '../../../../distribution/replication/types'
import {
  frameRecord,
  readDurableRegion,
  SEGMENT_HEADER_SIZE,
  writeSegmentHeader,
} from '../../../../persistence/durability/wal-framing'
import { crc32 } from '../../../../serialization/crc32'

const SEGMENT_MAX = 67_108_864

const SPEC_CHECKSUM_FIELD_ORDER = [
  'seqNo',
  'primaryTerm',
  'operation',
  'partitionId',
  'indexName',
  'documentId',
  'document',
] as const

function fixedIndexFields(): Omit<ReplicationLogEntry, 'checksum'> {
  return {
    seqNo: 7,
    primaryTerm: 3,
    operation: 'INDEX',
    partitionId: 2,
    indexName: 'products',
    documentId: 'doc-001',
    document: encode({ title: 'Wireless Headphones', price: 149 }),
  }
}

function fixedDeleteFields(): Omit<ReplicationLogEntry, 'checksum'> {
  return {
    seqNo: 9,
    primaryTerm: 3,
    operation: 'DELETE',
    partitionId: 2,
    indexName: 'products',
    documentId: 'doc-002',
    document: null,
  }
}

function checksumInputArray(fields: Omit<ReplicationLogEntry, 'checksum'>): unknown[] {
  const view = fields as unknown as Record<string, unknown>
  return SPEC_CHECKSUM_FIELD_ORDER.map(name => view[name])
}

function buildSegment(entries: ReplicationLogEntry[]): Uint8Array {
  const frames = entries.map(frameRecord)
  const total = SEGMENT_HEADER_SIZE + frames.reduce((sum, f) => sum + f.length, 0)
  const out = new Uint8Array(total)
  out.set(writeSegmentHeader(), 0)
  let offset = SEGMENT_HEADER_SIZE
  for (const frame of frames) {
    out.set(frame, offset)
    offset += frame.length
  }
  return out
}

describe('replication entry checksum field coverage', () => {
  it('feeds the seven content fields in the spec-declared order', () => {
    const fields = fixedIndexFields()
    const expected = crc32(encode(checksumInputArray(fields)))
    expect(computeEntryChecksum(fields)).toBe(expected)
  })

  it('changes the checksum when any single content field changes', () => {
    const base = buildEntry(fixedIndexFields()).checksum

    const mutations: Array<Omit<ReplicationLogEntry, 'checksum'>> = [
      { ...fixedIndexFields(), seqNo: 8 },
      { ...fixedIndexFields(), primaryTerm: 4 },
      { ...fixedIndexFields(), operation: 'DELETE', document: null },
      { ...fixedIndexFields(), partitionId: 3 },
      { ...fixedIndexFields(), indexName: 'orders' },
      { ...fixedIndexFields(), documentId: 'doc-999' },
      { ...fixedIndexFields(), document: encode({ title: 'Wired Headphones', price: 149 }) },
    ]

    expect(mutations).toHaveLength(SPEC_CHECKSUM_FIELD_ORDER.length)
    for (const mutated of mutations) {
      expect(computeEntryChecksum(mutated)).not.toBe(base)
    }
  })

  it('reorders to a different checksum, proving order is part of the contract', () => {
    const fields = fixedIndexFields()
    const inOrder = crc32(encode(checksumInputArray(fields)))
    const swapped = crc32(
      encode([
        fields.primaryTerm,
        fields.seqNo,
        fields.operation,
        fields.partitionId,
        fields.indexName,
        fields.documentId,
        fields.document,
      ]),
    )
    expect(swapped).not.toBe(inOrder)
    expect(computeEntryChecksum(fields)).toBe(inOrder)
  })
})

describe('replication entry golden bytes', () => {
  it('pins the INDEX checksum-input bytes and checksum', () => {
    const fields = fixedIndexFields()
    const goldenArrayHex =
      '970703a5494e44455802a870726f6475637473a7646f632d303031c42382a57469746c65b3576972656c657373204865616470686f6e6573a57072696365cc95'
    expect(toHex(encode(checksumInputArray(fields)))).toBe(goldenArrayHex)
    expect(computeEntryChecksum(fields)).toBe(198_311_079)
  })

  it('pins the DELETE checksum-input bytes and checksum', () => {
    const fields = fixedDeleteFields()
    const goldenArrayHex = '970903a644454c45544502a870726f6475637473a7646f632d303032c0'
    expect(toHex(encode(checksumInputArray(fields)))).toBe(goldenArrayHex)
    expect(computeEntryChecksum(fields)).toBe(1_321_292_726)
  })
})

describe('replication entry WAL frame round-trip', () => {
  it('returns an identical INDEX entry through framing and verifies its checksum', () => {
    const entry = buildEntry(fixedIndexFields())
    const segment = buildSegment([entry])
    const [decoded] = readDurableRegion(segment, segment.length, SEGMENT_MAX)
    expectEntryEqual(decoded, entry)
    expect(computeEntryChecksum(decoded)).toBe(decoded.checksum)
  })

  it('returns an identical DELETE entry through framing and verifies its checksum', () => {
    const entry = buildEntry(fixedDeleteFields())
    const segment = buildSegment([entry])
    const [decoded] = readDurableRegion(segment, segment.length, SEGMENT_MAX)
    expectEntryEqual(decoded, entry)
    expect(decoded.document).toBeNull()
    expect(computeEntryChecksum(decoded)).toBe(decoded.checksum)
  })
})

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) {
    out += bytes[i].toString(16).padStart(2, '0')
  }
  return out
}

function expectEntryEqual(actual: ReplicationLogEntry, expected: ReplicationLogEntry): void {
  expect(actual.seqNo).toBe(expected.seqNo)
  expect(actual.primaryTerm).toBe(expected.primaryTerm)
  expect(actual.operation).toBe(expected.operation)
  expect(actual.partitionId).toBe(expected.partitionId)
  expect(actual.indexName).toBe(expected.indexName)
  expect(actual.documentId).toBe(expected.documentId)
  expect(actual.checksum).toBe(expected.checksum)
  if (expected.document === null) {
    expect(actual.document).toBeNull()
  } else {
    expect(actual.document).not.toBeNull()
    expect(Array.from(actual.document ?? [])).toEqual(Array.from(expected.document))
  }
}
