import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { concatEnvelopeParts, packSnapshotEnvelopeParts, unpackEnvelopeBytes } from '../../../serialization/envelope'
import { HEADER_SIZE } from '../../../serialization/header'
import type { IndexConfig } from '../../../types/schema'
import { createVectorIndex, type VectorIndexPayload } from '../../../vector/vector-index'
import { decodeVectorIndexPart, vectorsToBytes } from '../../../vector/vector-index/payload'
import { createVectorStore } from '../../../vector/vector-store'
import { DIM, normalizedVector } from './fixtures'

async function writePart(
  directory: string,
  part: VectorIndexPayload,
): Promise<{ path: string; vectorsOffset: number }> {
  const envelope = await packSnapshotEnvelopeParts(encode(part))
  const path = join(directory, `part-${part.part}`)
  await writeFile(path, concatEnvelopeParts(envelope))
  return { path, vectorsOffset: HEADER_SIZE + envelope.payload.length - part.docIds.length * part.dimension * 4 }
}

async function overwriteVector(
  file: { path: string; vectorsOffset: number },
  part: VectorIndexPayload,
  docId: string,
  vector: Float32Array,
): Promise<void> {
  const handle = await open(file.path, 'r+')
  await handle.write(
    new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
    0,
    vector.byteLength,
    file.vectorsOffset + part.docIds.indexOf(docId) * DIM * 4,
  )
  await handle.close()
}

async function buildGraph(index: ReturnType<typeof createVectorIndex>): Promise<void> {
  index.scheduleBuild()
  await new Promise(resolve => setTimeout(resolve, 5))
  await index.awaitPendingBuild()
}

describe('a vector field kept on disk', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-disk-vectors-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('drops a block once every vector in it reads from a file holding the same bytes', async () => {
    const store = createVectorStore({ dimension: DIM, blockBytes: 16_384 })
    const capacity = store.handles.layout.capacity
    const vectors = new Float32Array(capacity * DIM)
    for (let i = 0; i < capacity; i++) {
      const vector = normalizedVector(DIM, i + 1)
      store.insert(`doc${i}`, vector)
      vectors.set(vector, i * DIM)
    }
    const path = join(directory, 'vectors.bin')
    await writeFile(path, vectorsToBytes(vectors))
    const before = store.memoryBytes()

    const fileIndex = store.addVectorFile(path)
    for (let i = 0; i < capacity; i++) {
      expect(store.releaseToFile(i, { fileIndex, offset: i * DIM * 4 })).toBe(true)
    }
    expect(store.releaseColdBlocks()).toBe(1)

    expect(store.handles.blocks[0]).toBeNull()
    expect(store.memoryBytes()).toBeLessThan(before)
    expect(store.isCold(3)).toBe(true)
    expect(Array.from(store.get('doc3')?.vector ?? [])).toEqual(Array.from(normalizedVector(DIM, 4)))
    expect(store.distanceByOrdinal(3, 5, 'cosine')).toBeCloseTo(
      1 - normalizedVector(DIM, 4).reduce((sum, value, i) => sum + value * normalizedVector(DIM, 6)[i], 0),
      5,
    )

    store.insert('doc3', normalizedVector(DIM, 99))
    expect(store.releaseToFile(capacity, { fileIndex, offset: 3 * DIM * 4 })).toBe(false)
    expect(store.isCold(capacity)).toBe(false)
  })

  it('reads a vector from the checkpoint file once the index adopts the file layout', async () => {
    const index = createVectorIndex(
      'embedding',
      DIM,
      { threshold: 4, quantization: 'none' },
      { enabled: false },
      'docs',
      'disk',
    )
    for (let i = 0; i < 12; i++) index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    await buildGraph(index)
    const query = normalizedVector(DIM, 7)
    const [part] = index.serialize()
    const file = await writePart(directory, part)
    index.insert('doc1', normalizedVector(DIM, 50))
    const before = index.search(query, 3, { metric: 'cosine', minSimilarity: 0 })
    await index.adoptDiskLayout({ ...file, docIds: part.docIds })

    expect(index.search(query, 3, { metric: 'cosine', minSimilarity: 0 }).map(hit => hit.docId)).toEqual(
      before.map(hit => hit.docId),
    )
    expect(Array.from(index.getVector('doc5') ?? [])).toEqual(Array.from(normalizedVector(DIM, 6)))

    const replaced = new Float32Array([0.5, 0.25, 0.125, 0.0625])
    await overwriteVector(file, part, 'doc5', replaced)
    expect(Array.from(index.getVector('doc5') ?? [])).toEqual(Array.from(replaced))
    expect(Array.from(index.getVector('doc1') ?? [])).toEqual(Array.from(normalizedVector(DIM, 50)))
    index.dispose()
  })

  it('holds a field below the promotion threshold in memory and releases it to the file once it builds a graph', async () => {
    const config = { threshold: 8, quantization: 'none' as const }
    const source = createVectorIndex('embedding', DIM, config, { enabled: false }, 'docs', 'memory')
    for (let i = 0; i < 4; i++) source.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    const [part] = source.serialize()
    const file = await writePart(directory, part)
    source.dispose()

    const index = createVectorIndex('embedding', DIM, config, { enabled: false }, 'docs', 'disk')
    index.deserialize([part], [file])
    await index.adoptDiskLayout({ ...file, docIds: part.docIds })
    const replaced = new Float32Array([0.5, 0.25, 0.125, 0.0625])
    await overwriteVector(file, part, 'doc1', replaced)
    expect(Array.from(index.getVector('doc1') ?? [])).toEqual(Array.from(normalizedVector(DIM, 2)))
    await overwriteVector(file, part, 'doc1', normalizedVector(DIM, 2))

    for (let i = 4; i < 12; i++) index.insert(`doc${i}`, normalizedVector(DIM, i + 1))
    await buildGraph(index)

    await overwriteVector(file, part, 'doc1', replaced)
    expect(Array.from(index.getVector('doc1') ?? [])).toEqual(Array.from(replaced))
    expect(Array.from(index.getVector('doc3') ?? [])).toEqual(Array.from(normalizedVector(DIM, 4)))
    index.dispose()
  })

  it('recovers a field due for a graph with its vectors read by position from the vector file', async () => {
    const config: IndexConfig = {
      schema: { title: 'string', embedding: `vector[${DIM}]` },
      language: 'english',
      vectorPromotion: { threshold: 8, quantization: 'none' },
    }
    const writer = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    await writer.createIndex('papers', config)
    for (let i = 0; i < 40; i++) {
      await writer.insert(
        'papers',
        { title: `Paper ${i}`, embedding: Array.from(normalizedVector(DIM, i + 1)) },
        `p${i}`,
      )
    }
    await writer.checkpoint('papers')
    const query = Array.from(normalizedVector(DIM, 21))
    const expected = (
      await writer.query('papers', { vector: { field: 'embedding', value: query }, limit: 5 })
    ).hits.map(hit => hit.id)
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    const recovered = await reader.query('papers', { vector: { field: 'embedding', value: query }, limit: 5 })
    expect(recovered.hits.map(hit => hit.id)).toEqual(expected)

    const durable = createDurableDirectory(directory)
    const [key] = (await durable.list('papers/segments/0/')).filter(name => name.includes('/vec-embedding-'))
    const bytes = await durable.read(key)
    if (bytes === null) throw new Error('vector part missing')
    const { header, payloadBytes } = await unpackEnvelopeBytes(bytes)
    const part = decodeVectorIndexPart(decode(payloadBytes))
    const position = part.docIds.indexOf('p9')
    const offset = HEADER_SIZE + header.payloadLength - (part.docIds.length - position) * DIM * 4
    const replaced = new Float32Array([0.5, 0.25, 0.125, 0.0625])
    const handle = await open(await durable.pathOf(key), 'r+')
    await handle.write(new Uint8Array(replaced.buffer), 0, replaced.byteLength, offset)
    await handle.close()

    const document = await reader.get('papers', 'p9')
    expect(Array.from(document?.embedding as Float32Array)).toEqual(Array.from(replaced))
    await reader.shutdown()
  })

  it('refuses a field kept on disk on an engine without filesystem durability', async () => {
    const engine = await createNarsil({ workers: { enabled: false } })
    await expect(
      engine.createIndex('papers', {
        schema: { embedding: `vector[${DIM}]` },
        vectorPromotion: { storage: 'disk' },
      }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' })

    const durable = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    await durable.createIndex('papers', {
      schema: { embedding: `vector[${DIM}]` },
      vectorPromotion: { storage: 'disk' },
    })
    const snapshot = await durable.snapshot('papers')
    await durable.shutdown()
    await expect(engine.restore('papers', snapshot)).rejects.toMatchObject({ code: 'CONFIG_INVALID' })
    await engine.shutdown()
  })
})
