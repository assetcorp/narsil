import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory, type DurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { readSegmentManifest } from '../../../persistence/durability/segment'
import { unpackEnvelopeBytes, unpackIndexSnapshotEnvelope } from '../../../serialization/envelope'
import type { IndexConfig } from '../../../types/schema'
import { osqRecordBytes } from '../../../vector/osq/record'
import type { VectorFilePayload, VectorGraphPayload } from '../../../vector/vector-index'
import { decodeVectorFilePayload, decodeVectorGraphPayload } from '../../../vector/vector-index/checkpoint-payload'
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

async function savedVectorField(
  directory: DurableDirectory,
  indexName: string,
): Promise<{ files: VectorFilePayload[]; graph: VectorGraphPayload }> {
  const manifest = await readSegmentManifest(directory, indexName)
  const field = manifest?.vectors[0]
  if (field === undefined || field.graphKey === null) throw new Error('the manifest lists no vector field with a graph')
  const payloadOf = async (key: string): Promise<unknown> => {
    const bytes = await directory.read(key)
    if (bytes === null) throw new Error(`"${key}" is missing`)
    return decode((await unpackEnvelopeBytes(bytes)).payloadBytes)
  }
  const files: VectorFilePayload[] = []
  for (const file of field.files) files.push(decodeVectorFilePayload(await payloadOf(file.key)))
  return { files, graph: decodeVectorGraphPayload(await payloadOf(field.graphKey)) }
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
    const saved = await savedVectorField(directory, 'papers')
    expect(saved.files.map(file => file.docIds.length)).toEqual([12, 4])
    expect(saved.files.map(file => file.codes?.records.byteLength)).toEqual([
      12 * osqRecordBytes(DIMENSION, 8),
      4 * osqRecordBytes(DIMENSION, 8),
    ])
    expect(saved.graph.graphs).toHaveLength(1)
    expect([...saved.graph.graphs[0].levels].filter(level => level > 0)).toHaveLength(16)

    const reader = await createNarsil({ durability: { directory: root } })
    expect((await reader.query('papers', query)).hits.map(hit => hit.id)).toEqual(expected)
    await reader.shutdown()
  })

  it('saves the graph that the index already searches through, and builds no second one', async () => {
    const config: IndexConfig = { ...CONFIG, vectorPromotion: { threshold: 8 } }
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('papers', config)
    const papers = []
    for (let i = 0; i < 200; i += 1) papers.push({ id: `p${i}`, title: `Paper ${i}`, embedding: embeddingFor(i) })
    expect((await writer.insertBatch('papers', papers)).failed).toEqual([])
    await writer.optimizeVectors('papers', 'embedding')
    await writer.checkpoint('papers')
    const snapshot = decode(await unpackIndexSnapshotEnvelope(await writer.snapshot('papers'))) as {
      vectorIndexes: Record<string, unknown[]>
    }
    const searchedThrough = decodeVectorIndexPart(snapshot.vectorIndexes.embedding[0]).graphs[0]
    await writer.shutdown()

    const saved = await savedVectorField(createDurableDirectory(root), 'papers')
    const docIds = saved.files.flatMap(file => file.docIds)
    const graph = saved.graph.graphs[0]
    const neighbours = new DataView(graph.neighbours.buffer, graph.neighbours.byteOffset, graph.neighbours.byteLength)
    const nodes: Array<[string, number, Array<[number, string[]]>]> = []
    let cursor = 0
    for (let number = 0; number < graph.levels.length; number += 1) {
      const layers: Array<[number, string[]]> = []
      for (let layer = 0; layer < graph.levels[number]; layer += 1) {
        const count = neighbours.getUint32(cursor * 4, true)
        const names: string[] = []
        for (let i = 1; i <= count; i += 1) names.push(docIds[neighbours.getUint32((cursor + i) * 4, true)])
        cursor += count + 1
        if (names.length > 0) layers.push([layer, names])
      }
      if (graph.levels[number] > 0) nodes.push([docIds[number], graph.levels[number] - 1, layers])
    }

    const byDocId = (a: [string, ...unknown[]], b: [string, ...unknown[]]) => a[0].localeCompare(b[0])
    expect(nodes).toHaveLength(200)
    expect(nodes.sort(byDocId)).toEqual([...searchedThrough.nodes].sort(byDocId))
    expect(graph.entryPoint === null ? null : docIds[graph.entryPoint]).toEqual(searchedThrough.entryPoint)
  })

  it('writes each vector field once for an index of several partitions, and recovers its graph whole', async () => {
    const config: IndexConfig = { ...CONFIG, vectorPromotion: { threshold: 8 } }
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('papers', config)
    const papers = []
    for (let i = 0; i < 90; i += 1) papers.push({ id: `p${i}`, title: `Paper ${i}`, embedding: embeddingFor(i) })
    expect((await writer.insertBatch('papers', papers.slice(0, 60))).failed).toEqual([])
    await writer.rebalance('papers', 3)
    expect((await writer.insertBatch('papers', papers.slice(60))).failed).toEqual([])
    await writer.optimizeVectors('papers', 'embedding')
    await writer.checkpoint('papers')
    const query = { vector: { field: 'embedding', value: embeddingFor(77) }, limit: 5 }
    const expected = (await writer.query('papers', query)).hits.map(hit => hit.id)
    await writer.shutdown()

    const directory = createDurableDirectory(root)
    const vectorKeys = (await directory.list('papers/segments/')).filter(key => key.includes('/vec-')).sort()
    expect(vectorKeys).toHaveLength(3)
    expect(vectorKeys[0]).toMatch(/^papers\/segments\/vec-embedding-[a-z0-9]+-f0{16}$/)
    expect(vectorKeys[1]).toMatch(/^papers\/segments\/vec-embedding-[a-z0-9]+-f0{15}1$/)
    expect(vectorKeys[2]).toMatch(/^papers\/segments\/vec-embedding-[a-z0-9]+-graph-g\d+$/)
    const saved = await savedVectorField(directory, 'papers')
    expect(saved.files.map(file => file.docIds.length)).toEqual([60, 30])
    expect([...saved.graph.graphs[0].levels].filter(level => level > 0)).toHaveLength(90)

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
