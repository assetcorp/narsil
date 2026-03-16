import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import {
  CURRENT_ENVELOPE_VERSION,
  readMetadataEnvelope,
  readPartitionEnvelope,
  writeMetadataEnvelope,
  writePartitionEnvelope,
} from '../../serialization/envelope'
import { HEADER_SIZE } from '../../serialization/header'
import type { IndexMetadata, SerializablePartition } from '../../types/internal'

function makePartition(overrides: Partial<SerializablePartition> = {}): SerializablePartition {
  return {
    indexName: 'books',
    partitionId: 0,
    totalPartitions: 2,
    language: 'english',
    schema: { title: 'string', year: 'number' },
    docCount: 1,
    avgDocLength: 3,
    documents: {
      'book-1': {
        fields: { title: 'the lord of the rings', year: 1954 },
        fieldLengths: { title: 5 },
      },
    },
    invertedIndex: {
      lord: {
        docFrequency: 1,
        postings: [{ docId: 'book-1', termFrequency: 1, field: 'title', positions: [1] }],
      },
      ring: {
        docFrequency: 1,
        postings: [{ docId: 'book-1', termFrequency: 1, field: 'title', positions: [4] }],
      },
    },
    fieldIndexes: {
      numeric: { year: [{ value: 1954, docId: 'book-1' }] },
      boolean: {},
      enum: {},
      geopoint: {},
    },
    vectorData: {},
    statistics: {
      totalDocuments: 1,
      totalFieldLengths: { title: 5 },
      averageFieldLengths: { title: 5 },
      docFrequencies: { lord: 1, ring: 1 },
    },
    ...overrides,
  }
}

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

describe('partition envelope', () => {
  it('roundtrips a partition without compression or checksum', async () => {
    const original = makePartition()
    const envelope = await writePartitionEnvelope(original)
    const { header, partition } = await readPartitionEnvelope(envelope)

    expect(header.magic).toBe('NRSL')
    expect(header.envelopeFormatVersion).toBe(CURRENT_ENVELOPE_VERSION)
    expect(header.flags.compressionEnabled).toBe(false)
    expect(header.flags.checksumPresent).toBe(false)

    expect(partition.indexName).toBe('books')
    expect(partition.partitionId).toBe(0)
    expect(partition.documents['book-1'].fields.title).toBe('the lord of the rings')
    expect(partition.invertedIndex.lord.docFrequency).toBe(1)
    expect(partition.fieldIndexes.numeric.year[0].value).toBe(1954)
    expect(partition.statistics.docFrequencies.ring).toBe(1)
  })

  it('roundtrips a partition with CRC32 checksum', async () => {
    const original = makePartition()
    const envelope = await writePartitionEnvelope(original, { checksum: true })
    const { header, partition } = await readPartitionEnvelope(envelope)

    expect(header.flags.checksumPresent).toBe(true)
    expect(header.checksum).toBeGreaterThan(0)
    expect(partition.indexName).toBe('books')
  })

  it('roundtrips a partition with gzip compression', async () => {
    const original = makePartition()
    const envelope = await writePartitionEnvelope(original, { compression: 'gzip' })
    const { header, partition } = await readPartitionEnvelope(envelope)

    expect(header.flags.compressionEnabled).toBe(true)
    expect(header.flags.compressionAlgorithm).toBe('gzip')
    expect(partition.indexName).toBe('books')
    expect(partition.documents['book-1'].fields.year).toBe(1954)
  })

  it('roundtrips with both compression and checksum', async () => {
    const original = makePartition()
    const envelope = await writePartitionEnvelope(original, { compression: 'gzip', checksum: true })
    const { header, partition } = await readPartitionEnvelope(envelope)

    expect(header.flags.compressionEnabled).toBe(true)
    expect(header.flags.checksumPresent).toBe(true)
    expect(partition.invertedIndex.ring.postings[0].positions).toEqual([4])
  })

  it('detects corrupted data via CRC32 mismatch', async () => {
    const envelope = await writePartitionEnvelope(makePartition(), { checksum: true })
    const corrupted = new Uint8Array(envelope)
    corrupted[HEADER_SIZE + 5] ^= 0xff

    await expect(readPartitionEnvelope(corrupted)).rejects.toThrow(NarsilError)
    try {
      await readPartitionEnvelope(corrupted)
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.PERSISTENCE_CRC_MISMATCH)
    }
  })

  it('starts with NRSL magic bytes', async () => {
    const envelope = await writePartitionEnvelope(makePartition())
    expect(envelope[0]).toBe(0x4e)
    expect(envelope[1]).toBe(0x52)
    expect(envelope[2]).toBe(0x53)
    expect(envelope[3]).toBe(0x4c)
  })

  it('rejects data with wrong magic bytes', async () => {
    const envelope = await writePartitionEnvelope(makePartition())
    const bad = new Uint8Array(envelope)
    bad[0] = 0x00
    await expect(readPartitionEnvelope(bad)).rejects.toThrow(NarsilError)
  })

  it('rejects truncated data where payload is shorter than declared length', async () => {
    const envelope = await writePartitionEnvelope(makePartition())
    const truncated = envelope.slice(0, HEADER_SIZE + 5)
    await expect(readPartitionEnvelope(truncated)).rejects.toThrow(NarsilError)
    try {
      await readPartitionEnvelope(truncated)
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.PERSISTENCE_LOAD_FAILED)
      expect((e as NarsilError).message).toContain('truncated')
    }
  })

  it('rejects a future envelope format version', async () => {
    const envelope = await writePartitionEnvelope(makePartition())
    const modified = new Uint8Array(envelope)
    modified[4] = 99
    await expect(readPartitionEnvelope(modified)).rejects.toThrow(NarsilError)
    try {
      await readPartitionEnvelope(modified)
    } catch (e) {
      expect((e as NarsilError).code).toBe(ErrorCodes.ENVELOPE_VERSION_MISMATCH)
    }
  })

  it('compressed envelope is smaller than uncompressed for larger data', async () => {
    const docs: SerializablePartition['documents'] = {}
    const postings: SerializablePartition['invertedIndex'] = {}
    for (let i = 0; i < 100; i++) {
      const id = `doc-${i}`
      docs[id] = {
        fields: { title: `product number ${i} with a longer description to make the payload bigger`, year: 2000 + i },
        fieldLengths: { title: 10 },
      }
      const token = `product${i}`
      postings[token] = {
        docFrequency: 1,
        postings: [{ docId: id, termFrequency: 1, field: 'title', positions: [0] }],
      }
    }

    const large = makePartition({
      docCount: 100,
      documents: docs,
      invertedIndex: postings,
    })

    const uncompressed = await writePartitionEnvelope(large)
    const compressed = await writePartitionEnvelope(large, { compression: 'gzip' })

    expect(compressed.length).toBeLessThan(uncompressed.length)
  })
})

describe('metadata envelope', () => {
  it('roundtrips index metadata without compression', async () => {
    const original = makeMetadata()
    const envelope = await writeMetadataEnvelope(original)
    const { header, metadata } = await readMetadataEnvelope(envelope)

    expect(header.magic).toBe('NRSL')
    expect(metadata.indexName).toBe('books')
    expect(metadata.schema).toEqual({ title: 'string', year: 'number' })
    expect(metadata.language).toBe('english')
    expect(metadata.partitionCount).toBe(2)
    expect(metadata.bm25Params).toEqual({ k1: 1.2, b: 0.75 })
    expect(metadata.createdAt).toBe(1700000000000)
    expect(metadata.engineVersion).toBe('0.1.0')
  })

  it('roundtrips metadata with compression and checksum', async () => {
    const original = makeMetadata()
    const envelope = await writeMetadataEnvelope(original, { compression: 'gzip', checksum: true })
    const { header, metadata } = await readMetadataEnvelope(envelope)

    expect(header.flags.compressionEnabled).toBe(true)
    expect(header.flags.checksumPresent).toBe(true)
    expect(metadata.indexName).toBe('books')
  })
})

describe('envelope format version', () => {
  it('current version is 1', () => {
    expect(CURRENT_ENVELOPE_VERSION).toBe(1)
  })
})
