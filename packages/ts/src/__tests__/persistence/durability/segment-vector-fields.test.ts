import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { unpackEnvelopeBytes } from '../../../serialization/envelope'
import type { IndexConfig } from '../../../types/schema'

const DIMENSION = 8

const CONFIG: IndexConfig = {
  schema: { title: 'string', embedding: `vector[${DIMENSION}]` },
  language: 'english',
}

function embeddingFor(seed: number): number[] {
  const values: number[] = []
  for (let i = 0; i < DIMENSION; i += 1) {
    values.push(((seed * 31 + i * 7) % 100) / 100)
  }
  return values
}

async function documentSegmentFields(
  directory: DurableDirectory,
  indexName: string,
  docId: string,
): Promise<Record<string, unknown>> {
  const keys = await directory.list(`${indexName}/segments/0/`)
  const documentKeys = keys.filter(key => !key.includes('/vec-'))
  expect(documentKeys.length).toBeGreaterThan(0)

  for (const key of documentKeys) {
    const bytes = await directory.read(key)
    if (bytes === null) {
      continue
    }
    const { payloadBytes } = await unpackEnvelopeBytes(bytes)
    const container = decode(payloadBytes) as { payload: Uint8Array }
    const payload = decode(container.payload) as {
      documents: Record<string, { fields: Record<string, unknown> }>
    }
    const stored = payload.documents[docId]
    if (stored !== undefined) {
      return stored.fields
    }
  }
  throw new Error(`Document "${docId}" appears in no segment`)
}

describe('vector fields in a segmented checkpoint', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-segvec-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes the documents without their vectors and recovers the vectors from the vector segment', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('papers', CONFIG)
    for (let i = 0; i < 5; i += 1) {
      await writer.insert('papers', { title: `Paper ${i}`, embedding: embeddingFor(i) }, `p${i}`)
    }
    await writer.checkpoint('papers')
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const fields = await documentSegmentFields(directory, 'papers', 'p3')
    expect(fields.embedding).toBeUndefined()
    expect(fields.title).toBe('Paper 3')

    const vectorKeys = await directory.list('papers/segments/0/')
    expect(vectorKeys.some(key => key.includes('/vec-embedding-'))).toBe(true)

    const reader = await createNarsil({ durability: { directory: root } })
    const recovered = await reader.get('papers', 'p3')
    const recoveredEmbedding = recovered?.embedding as Float32Array
    expect(recoveredEmbedding).toBeInstanceOf(Float32Array)
    expect(recoveredEmbedding.buffer.byteLength).toBe(DIMENSION * 4)
    for (const [i, expected] of embeddingFor(3).entries()) {
      expect(recoveredEmbedding[i]).toBeCloseTo(expected, 5)
    }

    const hits = await reader.query('papers', { vector: { field: 'embedding', value: embeddingFor(3) }, limit: 1 })
    expect(hits.hits[0]?.id).toBe('p3')
    await reader.shutdown()
  })

  it('recovers the vector an update replaced', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('papers', CONFIG)
    await writer.insert('papers', { title: 'Paper', embedding: embeddingFor(1) }, 'p1')
    await writer.checkpoint('papers')
    await writer.update('papers', 'p1', { title: 'Paper revised', embedding: embeddingFor(2) })
    await writer.checkpoint('papers')
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root } })
    const recovered = await reader.get('papers', 'p1')
    const recoveredEmbedding = recovered?.embedding as Float32Array
    for (const [i, expected] of embeddingFor(2).entries()) {
      expect(recoveredEmbedding[i]).toBeCloseTo(expected, 5)
    }
    await reader.shutdown()
  })

  it('recovers no vector for a document whose update dropped the field', async () => {
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('papers', CONFIG)
    await writer.insert('papers', { title: 'Paper', embedding: embeddingFor(1) }, 'p1')
    await writer.insert('papers', { title: 'Other', embedding: embeddingFor(9) }, 'p2')
    await writer.checkpoint('papers')
    await writer.update('papers', 'p1', { title: 'Paper without a vector' })
    await writer.checkpoint('papers')
    const live = await writer.get('papers', 'p1')
    await writer.shutdown()

    expect(live?.embedding).toBeUndefined()

    const reader = await createNarsil({ durability: { directory: root } })
    const recovered = await reader.get('papers', 'p1')
    expect(recovered?.title).toBe('Paper without a vector')
    expect(recovered?.embedding).toBeUndefined()
    await reader.shutdown()
  })
})
