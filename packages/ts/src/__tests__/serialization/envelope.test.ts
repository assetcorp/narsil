import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { CURRENT_ENVELOPE_VERSION, readMetadataEnvelope, writeMetadataEnvelope } from '../../serialization/envelope'
import { HEADER_SIZE } from '../../serialization/header'
import type { IndexMetadata } from '../../types/internal'

function makeMetadata(overrides: Partial<IndexMetadata> = {}): IndexMetadata {
  return {
    indexName: 'books',
    schema: { title: 'string', year: 'number' },
    language: 'english',
    partitionCount: 2,
    bm25Params: { k1: 1.2, b: 0.75 },
    createdAt: 1700000000000,
    engineVersion: '0.1.0',
    ...overrides,
  }
}

async function refusalOf(data: Uint8Array): Promise<NarsilError> {
  try {
    await readMetadataEnvelope(data)
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
  throw new Error('the reader accepted the envelope')
}

describe('metadata envelope', () => {
  it('roundtrips index metadata without compression', async () => {
    const envelope = await writeMetadataEnvelope(makeMetadata())
    const { header, metadata } = await readMetadataEnvelope(envelope)

    expect(header.magic).toBe('NRSL')
    expect(header.envelopeFormatVersion).toBe(CURRENT_ENVELOPE_VERSION)
    expect(header.flags.compressionEnabled).toBe(false)
    expect(header.flags.checksumPresent).toBe(false)
    expect(metadata.indexName).toBe('books')
    expect(metadata.schema).toEqual({ title: 'string', year: 'number' })
    expect(metadata.language).toBe('english')
    expect(metadata.partitionCount).toBe(2)
    expect(metadata.bm25Params).toEqual({ k1: 1.2, b: 0.75 })
    expect(metadata.createdAt).toBe(1700000000000)
    expect(metadata.engineVersion).toBe('0.1.0')
  })

  it('roundtrips metadata with compression and checksum', async () => {
    const envelope = await writeMetadataEnvelope(makeMetadata(), { compression: 'gzip', checksum: true })
    const { header, metadata } = await readMetadataEnvelope(envelope)

    expect(header.flags.compressionEnabled).toBe(true)
    expect(header.flags.compressionAlgorithm).toBe('gzip')
    expect(header.flags.checksumPresent).toBe(true)
    expect(metadata.indexName).toBe('books')
  })

  it('starts with the NRSL magic bytes and header version 1', async () => {
    const envelope = await writeMetadataEnvelope(makeMetadata())
    expect([...envelope.subarray(0, 5)]).toEqual([0x4e, 0x52, 0x53, 0x4c, 1])
  })

  it('refuses a payload whose checksum does not match', async () => {
    const envelope = await writeMetadataEnvelope(makeMetadata(), { checksum: true })
    const corrupted = new Uint8Array(envelope)
    corrupted[HEADER_SIZE + 5] ^= 0xff

    expect((await refusalOf(corrupted)).code).toBe(ErrorCodes.PERSISTENCE_CRC_MISMATCH)
  })

  it('refuses data with the wrong magic bytes', async () => {
    const bad = new Uint8Array(await writeMetadataEnvelope(makeMetadata()))
    bad[0] = 0x00

    await expect(readMetadataEnvelope(bad)).rejects.toThrow(NarsilError)
  })

  it('refuses a payload shorter than its header declares', async () => {
    const envelope = await writeMetadataEnvelope(makeMetadata())
    const refusal = await refusalOf(envelope.slice(0, HEADER_SIZE + 5))

    expect(refusal.code).toBe(ErrorCodes.PERSISTENCE_LOAD_FAILED)
    expect(refusal.message).toContain('truncated')
  })

  it('refuses a later envelope format version', async () => {
    for (const version of [2, 99]) {
      const modified = new Uint8Array(await writeMetadataEnvelope(makeMetadata()))
      modified[4] = version

      expect((await refusalOf(modified)).code).toBe(ErrorCodes.ENVELOPE_VERSION_MISMATCH)
    }
  })
})
