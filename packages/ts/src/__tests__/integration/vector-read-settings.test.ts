import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { AnyDocument, IndexConfig } from '../../types/schema'
import type { DocumentProjection } from '../../types/search'
import { bytesOf } from '../e2e/portability/archive-oracle'

const SCHEMA = { title: 'string', embedding: 'vector[3]', meta: { sketch: 'vector[2]' } } as const

interface Trail {
  id: string
  title: string
  embedding: number[]
  sketch: number[]
}

const TRAILS: Trail[] = Array.from({ length: 6 }, (_, at) => ({
  id: `trail-${at}`,
  title: `ridge trail ${at}`,
  embedding: [0.1 + at / 10, -0.2 * at, 0.3],
  sketch: [at / 3, 1 - at / 7],
}))

const engines: Narsil[] = []
let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'narsil-vector-reads-'))
})

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
  await rm(directory, { recursive: true, force: true })
})

async function open(durable: boolean): Promise<Narsil> {
  const engine = await createNarsil({ workers: { enabled: false }, ...(durable ? { durability: { directory } } : {}) })
  engines.push(engine)
  return engine
}

async function fill(engine: Narsil, indexName: string, config: Omit<IndexConfig, 'schema'>): Promise<void> {
  await engine.createIndex(indexName, { schema: SCHEMA, ...config })
  const inserted = await engine.insertBatch(
    indexName,
    TRAILS.map(trail => ({
      id: trail.id,
      title: trail.title,
      embedding: trail.embedding,
      meta: { sketch: trail.sketch },
    })),
  )
  expect(inserted.failed).toEqual([])
}

function plainVector(value: unknown): number[] | undefined {
  return value instanceof Float32Array ? Array.from(value) : undefined
}

function expectTrail(document: AnyDocument | undefined, id: string, withVectors: boolean, label: string): void {
  const trail = TRAILS.find(candidate => candidate.id === id)
  if (trail === undefined) throw new Error(`${label}: ${id} is no trail the test inserted`)
  expect(document?.title, label).toBe(trail.title)
  const sketch = (document?.meta as Record<string, unknown> | undefined)?.sketch
  expect(plainVector(document?.embedding), label).toEqual(withVectors ? trail.embedding.map(Math.fround) : undefined)
  expect(plainVector(sketch), label).toEqual(withVectors ? trail.sketch.map(Math.fround) : undefined)
  if (!withVectors) {
    expect(document?.embedding, label).toBeUndefined()
    expect(sketch, label).toBeUndefined()
  }
}

async function expectEveryRead(
  engine: Narsil,
  indexName: string,
  projection: DocumentProjection | undefined,
  withVectors: boolean,
  label: string,
): Promise<void> {
  const shaped = projection === undefined ? {} : { document: projection }
  const ids = TRAILS.map(trail => trail.id)
  const searched = await engine.query(indexName, { term: 'ridge', limit: TRAILS.length, ...shaped })
  expect(searched.hits, label).toHaveLength(TRAILS.length)
  for (const hit of searched.hits) expectTrail(hit.document, hit.id, withVectors, `${label} search`)
  const nearest = await engine.query(indexName, {
    vector: { field: 'embedding', value: TRAILS[2].embedding },
    limit: 1,
    ...shaped,
  })
  expect(
    nearest.hits.map(hit => hit.id),
    label,
  ).toEqual([TRAILS[2].id])
  expectTrail(nearest.hits[0]?.document, TRAILS[2].id, withVectors, `${label} vector search`)
  for (const [id, document] of await engine.getMultiple(indexName, ids, shaped)) {
    expectTrail(document, id, withVectors, `${label} getMultiple`)
  }
  expectTrail(await engine.get(indexName, ids[4], shaped), ids[4], withVectors, `${label} get`)
  const listed = await engine.listDocuments(indexName, { limit: TRAILS.length, ...shaped })
  expect(listed.documents, label).toHaveLength(TRAILS.length)
  for (const entry of listed.documents) expectTrail(entry.document, entry.id, withVectors, `${label} list`)
}

async function expectIndexSettings(engine: Narsil, label: string): Promise<void> {
  await expectEveryRead(engine, 'kept', undefined, true, `${label} kept`)
  await expectEveryRead(engine, 'kept', true, true, `${label} kept with true`)
  await expectEveryRead(engine, 'kept', { vectors: false }, false, `${label} kept with vectors off`)
  await expectEveryRead(engine, 'plain', undefined, false, `${label} plain`)
  await expectEveryRead(engine, 'plain', true, false, `${label} plain with true`)
  await expectEveryRead(engine, 'plain', { vectors: true }, true, `${label} plain with vectors on`)
}

describe('vector fields in read results', () => {
  it('follows the returnVectors setting of each index through a restart, a snapshot restore, and a document import', async () => {
    const writer = await open(true)
    await fill(writer, 'kept', { returnVectors: true })
    await fill(writer, 'plain', {})
    await expectIndexSettings(writer, 'written')
    const keptSnapshot = await bytesOf(await writer.snapshot('kept'))
    const plainSnapshot = await bytesOf(await writer.snapshot('plain'))
    const keptExport = await bytesOf(await writer.exportDocuments('kept'))
    await writer.shutdown()
    engines.splice(engines.indexOf(writer), 1)

    const reopened = await open(true)
    await expectIndexSettings(reopened, 'reopened')

    const restored = await open(false)
    await restored.restore('kept', keptSnapshot)
    await restored.restore('plain', plainSnapshot)
    await expectIndexSettings(restored, 'restored')

    const imported = await open(false)
    expect((await imported.importDocumentExport('kept', keptExport)).refusedCount).toBe(0)
    await expectEveryRead(imported, 'kept', undefined, true, 'imported kept')
    await expectEveryRead(imported, 'kept', { vectors: false }, false, 'imported kept with vectors off')
  }, 60_000)

  it('returns a vector field that an include path names, and leaves out one that an include path only passes through', async () => {
    const engine = await open(false)
    await fill(engine, 'plain', {})
    const read = (document: DocumentProjection) => engine.get('plain', TRAILS[1].id, { document })
    const sketch = TRAILS[1].sketch.map(Math.fround)
    const embedding = TRAILS[1].embedding.map(Math.fround)

    const named = await read({ include: ['meta.sketch'] })
    expect(Object.keys(named ?? {})).toEqual(['meta'])
    expect(plainVector((named?.meta as Record<string, unknown>).sketch)).toEqual(sketch)
    expect((await read({ include: ['meta'] }))?.meta).toEqual({})
    expect(await read({ include: ['embedding.inner'] })).toEqual({})
    expect(await read({ include: ['embedding', 'title'], exclude: ['embedding'] })).toEqual({ title: TRAILS[1].title })
    expect(await read({ include: ['embedding'], vectors: false })).toEqual({})
    const keptOne = await read({ exclude: ['meta.sketch'], vectors: true })
    expect(plainVector(keptOne?.embedding)).toEqual(embedding)
    expect((keptOne?.meta as Record<string, unknown>).sketch).toBeUndefined()
  })

  it('refuses a vectors switch or a returnVectors setting that is not true or false', async () => {
    const engine = await open(false)
    await fill(engine, 'plain', {})
    for (const returnVectors of ['true', 1, null, {}]) {
      await expect(
        engine.createIndex('refused', { schema: SCHEMA, returnVectors: returnVectors as unknown as boolean }),
        String(returnVectors),
      ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
      expect(engine.listIndexes().map(index => index.name)).toEqual(['plain'])
    }
    for (const vectors of ['true', 1, null, [true]]) {
      const document = { vectors } as unknown as DocumentProjection
      const refused = { code: ErrorCodes.SEARCH_INVALID_FIELD }
      await expect(engine.query('plain', { term: 'ridge', document }), String(vectors)).rejects.toMatchObject(refused)
      await expect(engine.get('plain', TRAILS[0].id, { document }), String(vectors)).rejects.toMatchObject(refused)
      await expect(engine.getMultiple('plain', [TRAILS[0].id], { document })).rejects.toMatchObject(refused)
      await expect(engine.listDocuments('plain', { document })).rejects.toMatchObject(refused)
    }
  })
})
