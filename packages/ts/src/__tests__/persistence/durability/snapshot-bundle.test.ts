import { encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../../errors'
import { decodeSnapshotBundle } from '../../../persistence/durability/earlier-layout/bundle'
import { sealEnvelope } from '../../e2e/portability/archive-oracle'

const SNAPSHOT_BUNDLE_ENVELOPE_VERSION = 2

function bundleBytes(payload: Record<string, unknown>): Uint8Array {
  return sealEnvelope(SNAPSHOT_BUNDLE_ENVELOPE_VERSION, encode(payload))
}

function sampleBundle(): Record<string, unknown> {
  return {
    version: 2,
    schema: { title: 'string', year: 'number' },
    language: 'english',
    partitions: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
    vectorIndexes: {},
    checkpoint: [
      { partitionId: 0, lastSeqNo: 12, primaryTerm: 1 },
      { partitionId: 1, lastSeqNo: 7, primaryTerm: 1 },
    ],
  }
}

async function refusalOf(bytes: Uint8Array): Promise<NarsilError> {
  try {
    await decodeSnapshotBundle(bytes)
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
  throw new Error('the reader accepted the bundle')
}

describe('the snapshot bundle of release 0.3', () => {
  it('reads the schema, the language, the partitions, and the checkpoint', async () => {
    const decoded = await decodeSnapshotBundle(bundleBytes(sampleBundle()))

    expect(decoded.schema).toEqual({ title: 'string', year: 'number' })
    expect(decoded.language).toBe('english')
    expect(decoded.partitions.map(part => [...part])).toEqual([
      [1, 2, 3],
      [4, 5],
    ])
    expect(decoded.checkpoint).toEqual([
      { partitionId: 0, lastSeqNo: 12, primaryTerm: 1 },
      { partitionId: 1, lastSeqNo: 7, primaryTerm: 1 },
    ])
  })

  it('treats a missing checkpoint as a replay from the first record', async () => {
    const decoded = await decodeSnapshotBundle(bundleBytes({ ...sampleBundle(), checkpoint: undefined }))

    expect(decoded.checkpoint).toEqual([])
  })

  it('refuses a payload whose checksum does not match', async () => {
    const bytes = bundleBytes(sampleBundle())
    bytes[bytes.length - 1] ^= 0xff

    expect((await refusalOf(bytes)).code).toBe(ErrorCodes.PERSISTENCE_CRC_MISMATCH)
  })

  it('refuses a bundle of another layout, naming the export as the way across', async () => {
    const refusal = await refusalOf(bundleBytes({ ...sampleBundle(), version: 99 }))

    expect(refusal.code).toBe(ErrorCodes.ENVELOPE_VERSION_MISMATCH)
    expect(refusal.message).toMatch(/export/i)
  })

  it('refuses a bundle with no schema, no language, or partitions that are not bytes', async () => {
    for (const broken of [
      { ...sampleBundle(), schema: 'title' },
      { ...sampleBundle(), language: 7 },
      { ...sampleBundle(), partitions: ['not bytes'] },
    ]) {
      expect((await refusalOf(bundleBytes(broken))).code).toBe(ErrorCodes.PERSISTENCE_LOAD_FAILED)
    }
  })

  it('refuses a schema that names a field type this release does not know', async () => {
    const refusal = await refusalOf(bundleBytes({ ...sampleBundle(), schema: { title: 'glob' } }))

    expect(refusal.code).toBe(ErrorCodes.SCHEMA_INVALID_TYPE)
  })
})
