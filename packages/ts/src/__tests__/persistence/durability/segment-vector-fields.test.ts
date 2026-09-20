import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { unpackEnvelopeBytes, unpackIndexSnapshotEnvelope } from '../../../serialization/envelope'
import type { IndexConfig } from '../../../types/schema'
import { osqRecordBytes } from '../../../vector/osq/record'
import { decodeVectorIndexPart } from '../../../vector/vector-index/payload'

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

    const vectorKeys = await directory.list('papers/segments/')
    expect(vectorKeys.some(key => key.startsWith('papers/segments/vec-embedding-'))).toBe(true)

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

  it('writes the graph and the codes with the vectors and grows them at the next checkpoint', async () => {
    const config: IndexConfig = { ...CONFIG, vectorPromotion: { threshold: 8 } }
    const writer = await createNarsil({ durability: { directory: root } })
    await writer.createIndex('papers', config)
    for (let i = 0; i < 12; i += 1) {
      await writer.insert('papers', { title: `Paper ${i}`, embedding: embeddingFor(i) }, `p${i}`)
    }
    await writer.checkpoint('papers')
    for (let i = 12; i < 16; i += 1) {
      await writer.insert('papers', { title: `Paper ${i}`, embedding: embeddingFor(i) }, `p${i}`)
    }
    await writer.checkpoint('papers')
    const query = { vector: { field: 'embedding', value: embeddingFor(14) }, limit: 3 }
    const expected = (await writer.query('papers', query)).hits.map(hit => hit.id)
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const vectorKeys = (await directory.list('papers/segments/')).filter(key => key.includes('/vec-embedding-'))
    expect(vectorKeys).toHaveLength(1)
    const bytes = await directory.read(vectorKeys[0])
    if (bytes === null) throw new Error('vector part missing')
    const { payloadBytes } = await unpackEnvelopeBytes(bytes)
    const part = decodeVectorIndexPart(decode(payloadBytes))
    expect(part.docIds).toHaveLength(16)
    expect(part.graphs).toHaveLength(1)
    expect(part.graphs[0].nodes.map(node => node[0]).sort()).toEqual([...part.docIds].sort())
    expect(part.codes?.records.byteLength).toBe(16 * osqRecordBytes(DIMENSION, 8))

    const reader = await createNarsil({ durability: { directory: root } })
    expect((await reader.query('papers', query)).hits.map(hit => hit.id)).toEqual(expected)
    await reader.shutdown()
  })

  it('saves the graph that the index already searches through, and builds no second one', async () => {
    const config: IndexConfig = { ...CONFIG, vectorPromotion: { threshold: 8 } }
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('papers', config)
    for (let i = 0; i < 200; i += 1) {
      await writer.insert('papers', { title: `Paper ${i}`, embedding: embeddingFor(i) }, `p${i}`)
    }
    await writer.optimizeVectors('papers', 'embedding')
    await writer.checkpoint('papers')
    const snapshot = decode(await unpackIndexSnapshotEnvelope(await writer.snapshot('papers'))) as {
      vectorIndexes: Record<string, unknown[]>
    }
    const searchedThrough = decodeVectorIndexPart(snapshot.vectorIndexes.embedding[0]).graphs[0]
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const vectorKeys = (await directory.list('papers/segments/')).filter(key => key.includes('/vec-embedding-'))
    const bytes = await directory.read(vectorKeys[0])
    if (bytes === null) throw new Error('vector part missing')
    const { payloadBytes } = await unpackEnvelopeBytes(bytes)
    const saved = decodeVectorIndexPart(decode(payloadBytes)).graphs[0]

    expect(saved.nodes).toHaveLength(200)
    expect(saved.nodes).toEqual(searchedThrough.nodes)
    expect(saved.entryPoint).toEqual(searchedThrough.entryPoint)
  })

  it('writes each vector field once for an index of several partitions, and recovers its graph whole', async () => {
    const config: IndexConfig = { ...CONFIG, vectorPromotion: { threshold: 8 } }
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('papers', config)
    for (let i = 0; i < 60; i += 1) {
      await writer.insert('papers', { title: `Paper ${i}`, embedding: embeddingFor(i) }, `p${i}`)
    }
    await writer.rebalance('papers', 3)
    for (let i = 60; i < 90; i += 1) {
      await writer.insert('papers', { title: `Paper ${i}`, embedding: embeddingFor(i) }, `p${i}`)
    }
    await writer.optimizeVectors('papers', 'embedding')
    await writer.checkpoint('papers')
    const query = { vector: { field: 'embedding', value: embeddingFor(77) }, limit: 5 }
    const expected = (await writer.query('papers', query)).hits.map(hit => hit.id)
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const vectorKeys = (await directory.list('papers/segments/')).filter(key => key.includes('/vec-'))
    expect(vectorKeys).toHaveLength(1)
    expect(vectorKeys[0]).toMatch(/^papers\/segments\/vec-embedding-[a-z0-9]+-g\d+-p0000$/)
    const bytes = await directory.read(vectorKeys[0])
    if (bytes === null) throw new Error('vector part missing')
    const part = decodeVectorIndexPart(decode((await unpackEnvelopeBytes(bytes)).payloadBytes))
    expect(part.docIds).toHaveLength(90)
    expect(part.graphs[0].nodes).toHaveLength(90)

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect((await reader.vectorMaintenanceStatus('papers'))[0]).toMatchObject({ graphCount: 1, bufferSize: 0 })
    expect((await reader.query('papers', query)).hits.map(hit => hit.id)).toEqual(expected)
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
