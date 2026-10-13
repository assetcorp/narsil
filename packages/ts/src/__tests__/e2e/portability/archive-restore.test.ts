import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import { bytesOf, resealed, sealEnvelope } from './archive-oracle'
import {
  CATALOG_CONFIG,
  catalogOf,
  documentsOf,
  ENGINE_KINDS,
  insertCatalog,
  storedForm,
  temporaryRoots,
} from './harness'

const roots = temporaryRoots()
const engines: Narsil[] = []
const FIXTURE = new URL('../../persistence/fixtures/0.3.0/', import.meta.url)
const DIMENSION = 8

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

function track(engine: Narsil): Narsil {
  engines.push(engine)
  return engine
}

function vectorOf(seed: number): number[] {
  return Array.from({ length: DIMENSION }, (_, d) => Math.round(Math.sin(seed * 7 + d * 3) * 1000) / 1000)
}

function asPlainVector(value: unknown): number[] {
  if (value instanceof Float32Array) return Array.from(value)
  if (Array.isArray(value)) return value.map(Number)
  throw new Error('the document holds no vector')
}

describe.each(ENGINE_KINDS)('restoring into $name', target => {
  it('restores every document of a source in memory, under a new name, and serves searches', async () => {
    const source = track(await ENGINE_KINDS[0].open(roots).then(opened => opened.engine))
    await source.createIndex('catalog', CATALOG_CONFIG)
    const documents = catalogOf(150)
    await insertCatalog(source, 'catalog', documents)
    await source.remove('catalog', 'doc-0007')
    documents.delete('doc-0007')
    const archive = await bytesOf(await source.snapshot('catalog'))

    const opened = await target.open(roots)
    const engine = track(opened.engine)
    await engine.restore('copy', archive)

    expect(await engine.countDocuments('copy')).toBe(documents.size)
    expect(await documentsOf(engine, 'copy', documents.keys())).toEqual(storedForm(documents))
    expect(await engine.get('copy', 'doc-0007')).toBeUndefined()
    const expected = [...documents].filter(([, document]) =>
      [document.title, document.body, ...(document.tags as string[])].join(' ').split(/\s+/).includes('harbour'),
    ).length
    expect((await engine.query('copy', { term: 'harbour', limit: 500 })).count).toBe(expected)
  })

  it('continues writes after the restore and keeps them across a restart', async () => {
    const source = track(await createNarsil({ workers: { enabled: false } }))
    await source.createIndex('catalog', CATALOG_CONFIG)
    const documents = catalogOf(60)
    await insertCatalog(source, 'catalog', documents)
    const archive = await bytesOf(await source.snapshot('catalog'))

    const opened = await target.open(roots)
    let engine = track(opened.engine)
    await engine.restore('catalog', archive)
    const later = catalogOf(5, 900)
    await insertCatalog(engine, 'catalog', later)
    await engine.remove('catalog', 'doc-0001')
    documents.delete('doc-0001')
    for (const [id, document] of later) documents.set(id, document)

    if (target.name.includes('write-ahead')) {
      await engine.shutdown()
      engine = track(await opened.reopen())
    }

    expect(await engine.countDocuments('catalog')).toBe(documents.size)
    expect(await documentsOf(engine, 'catalog', documents.keys())).toEqual(storedForm(documents))
    expect(await engine.get('catalog', 'doc-0001')).toBeUndefined()
  })

  it('round-trips vectors and answers the same nearest neighbours', async () => {
    const config = {
      schema: { title: 'string' as const, embedding: `vector[${DIMENSION}]` as const },
      vectorPromotion: { threshold: 16, hnswConfig: { m: 8, efConstruction: 64 } },
    }
    const source = track(await createNarsil({ workers: { enabled: false } }))
    await source.createIndex('papers', config)
    const papers = new Map<string, number[]>()
    for (let n = 0; n < 80; n++) papers.set(`p${n}`, vectorOf(n))
    await source.insertBatch(
      'papers',
      [...papers].map(([id, embedding]) => ({ id, title: `paper ${id}`, embedding })),
    )
    const archive = await bytesOf(await source.snapshot('papers'))

    const engine = track((await target.open(roots)).engine)
    await engine.restore('papers', archive)

    for (const [id, embedding] of papers) {
      const stored = await engine.get('papers', id)
      expect(asPlainVector(stored?.embedding)).toEqual(embedding.map(Math.fround))
    }
    const query = { vector: { field: 'embedding', value: vectorOf(41) }, limit: 5 }
    expect((await engine.query('papers', query)).hits.map(hit => hit.id)).toEqual(
      (await source.query('papers', query)).hits.map(hit => hit.id),
    )
  })

  it('restores the snapshot file that release 0.3 wrote, as new writes', async () => {
    const expected = JSON.parse(await readFile(new URL('snapshot-tier-expected.json', FIXTURE), 'utf8')) as Record<
      string,
      AnyDocument
    >
    const opened = await target.open(roots)
    let engine = track(opened.engine)

    await engine.restore('products', new Uint8Array(await readFile(new URL('products-0.3.0.nrsl', FIXTURE))))
    if (target.name.includes('write-ahead')) {
      await engine.shutdown()
      engine = track(await opened.reopen())
    }

    expect(await engine.countDocuments('products')).toBe(Object.keys(expected).length)
    for (const [id, document] of Object.entries(expected)) {
      const stored = await engine.get('products', id)
      const { embedding, ...rest } = document as AnyDocument & { embedding: number[] }
      if (stored?.id !== undefined) expect(stored.id).toBe(id)
      expect({ ...stored, id: undefined, embedding: undefined }).toEqual({
        ...rest,
        id: undefined,
        embedding: undefined,
      })
      const unsignedZero = (value: number): number => (value === 0 ? 0 : value)
      expect(asPlainVector(stored?.embedding).map(unsignedZero)).toEqual(embedding.map(Math.fround).map(unsignedZero))
    }
    const documents = Object.values(expected)
    const holdingHarbour = documents.filter(document =>
      [document.title, document.body, ...(document.tags as string[])]
        .join(' ')
        .toLowerCase()
        .split(/\s+/)
        .includes('harbour'),
    )
    expect((await engine.query('products', { term: 'harbour', limit: 500 })).count).toBe(holdingHarbour.length)
    const ids = Object.keys(expected)
    for (const id of [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]]) {
      const target = (expected[id] as AnyDocument & { embedding: number[] }).embedding
      const hits = (await engine.query('products', { vector: { field: 'embedding', value: target }, limit: 1 })).hits
      const nearest = await engine.get('products', hits[0]?.id ?? '')
      expect(asPlainVector(nearest?.embedding)).toEqual(target.map(Math.fround))
    }
  })
})

describe('a release 0.3 snapshot file whose graph keeps one neighbour per node', () => {
  it('restores every document with a graph setting that this release accepts', async () => {
    const expected = JSON.parse(await readFile(new URL('snapshot-tier-expected.json', FIXTURE), 'utf8')) as Record<
      string,
      AnyDocument
    >
    const original = new Uint8Array(await readFile(new URL('products-0.3.0.nrsl', FIXTURE)))
    const singleNeighbour = resealed(original, raw => {
      const promotion = (raw.vectorPromotion ?? {}) as Record<string, unknown>
      const hnsw = (promotion.hnswConfig ?? {}) as Record<string, unknown>
      return { ...raw, vectorPromotion: { ...promotion, hnswConfig: { ...hnsw, m: 1 } } }
    })
    const engine = track(await createNarsil({ workers: { enabled: false } }))

    await engine.restore('products', singleNeighbour)

    expect(await engine.countDocuments('products')).toBe(Object.keys(expected).length)
    const [id, document] = Object.entries(expected)[0]
    const target = (document as AnyDocument & { embedding: number[] }).embedding
    const hits = (await engine.query('products', { vector: { field: 'embedding', value: target }, limit: 1 })).hits
    expect(asPlainVector((await engine.get('products', hits[0]?.id ?? ''))?.embedding)).toEqual(
      asPlainVector((await engine.get('products', id))?.embedding),
    )
  })
})

describe('an old-format snapshot upload', () => {
  it('refuses a header that declares more than the file size limit and a payload cut short', async () => {
    const engine = track(await createNarsil({ workers: { enabled: false } }))
    const oversized = sealEnvelope(3, new Uint8Array(16))
    new DataView(oversized.buffer).setUint32(8, 0xffff_ffff, false)
    const cut = sealEnvelope(3, new Uint8Array(64)).subarray(0, 50)
    const trailing = new Uint8Array([...sealEnvelope(3, new Uint8Array(8)), 1, 2, 3])

    for (const data of [oversized, cut, trailing]) {
      await expect(engine.restore('products', data)).rejects.toMatchObject({
        code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
      })
    }
    expect(engine.listIndexes()).toEqual([])
  })
})

describe('a snapshot that a node with a write-ahead log streams', () => {
  it('keeps every file of its checkpoint until the stream ends, while later checkpoints move on', async () => {
    const directory = await roots.make('narsil-held-snapshot-')
    const engine = track(await createNarsil({ workers: { enabled: false }, durability: { directory } }))
    await engine.createIndex('catalog', CATALOG_CONFIG)
    const documents = catalogOf(80)
    await insertCatalog(engine, 'catalog', documents)
    const stream = await engine.snapshot('catalog')

    for (const id of [...documents.keys()].slice(0, 70)) await engine.remove('catalog', id)
    await insertCatalog(engine, 'catalog', catalogOf(40, 500))
    await engine.checkpoint('catalog')
    await engine.checkpoint('catalog')

    const copy = track(await createNarsil({ workers: { enabled: false } }))
    await copy.restore('catalog', await bytesOf(stream))
    expect(await documentsOf(copy, 'catalog', documents.keys())).toEqual(storedForm(documents))

    await engine.checkpoint('catalog')
    const leftovers = (await readdir(join(directory), { recursive: true })).filter(name => name.startsWith('.restore-'))
    expect(leftovers).toEqual([])
  })

  it('keeps every file of its checkpoint while the index closes and reopens during the stream', async () => {
    const directory = await roots.make('narsil-held-reopen-')
    const engine = track(await createNarsil({ workers: { enabled: false }, durability: { directory }, lifecycle: {} }))
    await engine.createIndex('catalog', CATALOG_CONFIG)
    const documents = catalogOf(80)
    await insertCatalog(engine, 'catalog', documents)
    await engine.checkpoint('catalog')
    const exported = await engine.exportDocuments('catalog')
    const stream = await engine.snapshot('catalog')

    for (const id of [...documents.keys()].slice(0, 70)) await engine.remove('catalog', id)
    await insertCatalog(engine, 'catalog', catalogOf(40, 500))
    await engine.close('catalog')
    await engine.open('catalog')
    await engine.checkpoint('catalog')

    const copy = track(await createNarsil({ workers: { enabled: false } }))
    await copy.restore('catalog', await bytesOf(stream))
    expect(await documentsOf(copy, 'catalog', documents.keys())).toEqual(storedForm(documents))
    const lines = new TextDecoder()
      .decode(await bytesOf(exported))
      .trim()
      .split('\n')
    expect(lines).toHaveLength(documents.size + 1)
  })
})
