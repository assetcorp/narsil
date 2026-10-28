import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { SchemaDefinition } from '../../../types/schema'
import { bytesOf, readTar, resealed, rewriteFiles, withEntry, writeTar } from './archive-oracle'
import { ENGINE_KINDS, temporaryRoots } from './harness'

vi.setConfig({ testTimeout: 20_000 })

const roots = temporaryRoots()
const engines: Narsil[] = []
const SIXTEEN_MIB = 16 * 1024 * 1024

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown().catch(() => undefined)
  await roots.removeAll()
})

function track(engine: Narsil): Narsil {
  engines.push(engine)
  return engine
}

function plainEngine(): Promise<Narsil> {
  return createNarsil({ workers: { enabled: false } }).then(track)
}

function textFields(count: number): SchemaDefinition {
  const schema: SchemaDefinition = {}
  for (let at = 0; at < count; at++) schema[`f${at}`] = 'string'
  return schema
}

describe('the limits on a new index', () => {
  it('takes a vector field of up to 4,096 dimensions and refuses a wider one', async () => {
    const engine = await plainEngine()

    await engine.createIndex('wide', { schema: { embedding: 'vector[4096]' } })
    await expect(engine.createIndex('wider', { schema: { embedding: 'vector[4097]' } })).rejects.toMatchObject({
      code: ErrorCodes.SCHEMA_INVALID_VECTOR_DIMENSION,
    })
    expect(engine.listIndexes().map(index => index.name)).toEqual(['wide'])
  })

  it('takes 65,536 text fields and refuses one more', async () => {
    const engine = await plainEngine()

    await engine.createIndex('many', { schema: textFields(65_536) })
    await expect(engine.createIndex('too-many', { schema: textFields(65_537) })).rejects.toMatchObject({
      code: ErrorCodes.SCHEMA_INVALID_TYPE,
    })
  })

  it('takes an HNSW m from 2 to 512 and refuses 1 and 513', async () => {
    const engine = await plainEngine()
    const withM = (m: number) => ({
      schema: { embedding: 'vector[4]' as const },
      vectorPromotion: { hnswConfig: { m } },
    })

    await engine.createIndex('m-2', withM(2))
    await engine.createIndex('m-512', withM(512))
    for (const m of [1, 513, 0, 2.5]) {
      await expect(engine.createIndex(`m-${m}`, withM(m))).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
    }
  })

  it('takes a configuration under 16 MiB as MessagePack through an export and refuses a larger one', async () => {
    const engine = await plainEngine()
    const STOP_WORD_BYTES = 66
    const stopWords = (count: number) =>
      new Set(Array.from({ length: count }, (_, at) => `w${String(at).padStart(63, '0')}`))
    const under = Math.floor((SIXTEEN_MIB - 4_096) / STOP_WORD_BYTES)
    const over = Math.ceil(SIXTEEN_MIB / STOP_WORD_BYTES) + 1

    await engine.createIndex('large', { schema: { title: 'string' }, stopWords: stopWords(under) })
    await engine.insert('large', { title: 'lantern' }, 'only')
    await expect(
      engine.createIndex('too-large', { schema: { title: 'string' }, stopWords: stopWords(over) }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID, details: { maximum: SIXTEEN_MIB } })
    expect(engine.listIndexes().map(index => index.name)).toEqual(['large'])

    const exported = await bytesOf(await engine.exportDocuments('large'))
    const target = await plainEngine()
    expect(await target.importDocumentExport('copy', exported)).toEqual({ imported: 1, refusedCount: 0, refused: [] })
    expect(await target.get('copy', 'only')).toEqual({ id: 'only', title: 'lantern' })
  })

  it('refuses a write-ahead log segment limit above 2,147,483,647 bytes', async () => {
    const directory = await roots.make('narsil-segment-limit-')

    await expect(
      createNarsil({ workers: { enabled: false }, durability: { directory, segmentMaxBytes: 2_147_483_648 } }),
    ).rejects.toMatchObject({ code: ErrorCodes.CONFIG_INVALID })
    track(
      await createNarsil({ workers: { enabled: false }, durability: { directory, segmentMaxBytes: 2_147_483_647 } }),
    )
  })
})

describe('the 16 MiB limit on a document', () => {
  it('refuses a new document, an update, and a batch member above the limit, and keeps the rest', async () => {
    const engine = await plainEngine()
    await engine.createIndex('notes', { schema: { title: 'string', body: 'string' } })
    const huge = { title: 'huge', body: 'x'.repeat(SIXTEEN_MIB) }
    const fits = { title: 'fits', body: 'x'.repeat(SIXTEEN_MIB - 64) }

    await expect(engine.insert('notes', huge, 'huge')).rejects.toMatchObject({ code: ErrorCodes.DOC_VALIDATION_FAILED })
    await engine.insert('notes', fits, 'fits')
    await expect(engine.update('notes', 'fits', huge)).rejects.toMatchObject({ code: ErrorCodes.DOC_VALIDATION_FAILED })
    const batch = await engine.insertBatch('notes', [
      { id: 'small', title: 'small' },
      { id: 'huge-in-batch', ...huge },
    ])

    expect(batch.succeeded).toEqual(['small'])
    expect(batch.failed.map(failure => [failure.docId, failure.error.code])).toEqual([
      ['huge-in-batch', ErrorCodes.DOC_VALIDATION_FAILED],
    ])
    expect((await engine.get('notes', 'fits'))?.title).toBe('fits')
    expect(await engine.countDocuments('notes')).toBe(2)
  })

  it('counts the vectors of a document toward the limit', async () => {
    const engine = await plainEngine()
    await engine.createIndex('vectors', { schema: { title: 'string', embedding: 'vector[4096]' } })
    const text = 'y'.repeat(SIXTEEN_MIB - 4096 * 4)

    await expect(
      engine.insert('vectors', { title: text, embedding: new Array(4096).fill(0.5) }, 'over'),
    ).rejects.toMatchObject({ code: ErrorCodes.DOC_VALIDATION_FAILED })
  })
})

describe.each(ENGINE_KINDS)('an index of more than 256 text fields on $name', kind => {
  it('keeps every field apart, through a checkpoint and a reopen', async () => {
    const opened = await kind.open(roots)
    let engine = track(opened.engine)
    await engine.createIndex('wide', { schema: textFields(300) })
    await engine.insert('wide', { f299: 'harbour', f43: 'lantern' }, 'one')
    await engine.insert('wide', { f43: 'harbour' }, 'two')
    await engine.checkpoint('wide')
    if (kind.name.includes('write-ahead')) {
      await engine.shutdown()
      engine = track(await opened.reopen())
    }

    const inLast = await engine.query('wide', { term: 'harbour', fields: ['f299'] })
    const inWrapped = await engine.query('wide', { term: 'harbour', fields: ['f43'] })
    expect(inLast.hits.map(hit => hit.id)).toEqual(['one'])
    expect(inWrapped.hits.map(hit => hit.id)).toEqual(['two'])
  })
})

describe('an archive whose index has a vector field wider than a new index takes', () => {
  it('restores, because readers accept the width that an earlier release allowed', async () => {
    const engine = await plainEngine()
    await engine.createIndex('narrow', { schema: { title: 'string', embedding: 'vector[8]' } })
    await engine.insert('narrow', { title: 'only text' }, 'a')
    const entries = readTar(await bytesOf(await engine.snapshot('narrow')))
    const widen = (raw: Record<string, unknown>) => ({
      ...raw,
      schema: { ...(raw.schema as Record<string, unknown>), embedding: 'vector[5000]' },
    })
    const configWidened = withEntry(entries, 'config', resealed(entries[0].data, widen))
    const mismatched = writeTar(withEntry(configWidened, 'manifest', resealed(entries[1].data, widen)))
    const widened = writeTar(
      rewriteFiles(withEntry(configWidened, 'manifest', resealed(entries[1].data, widen)), (payload, name) => {
        if (!name.startsWith('segments/')) return false
        payload.schema = widen(payload).schema
        return true
      }),
    )

    await expect(engine.restore('wide', mismatched)).rejects.toMatchObject({
      code: ErrorCodes.PERSISTENCE_LOAD_FAILED,
    })
    expect(engine.listIndexes().map(index => index.name)).toEqual(['narrow'])
    await engine.restore('wide', widened)

    expect(engine.getStats('wide').schema).toMatchObject({ embedding: 'vector[5000]' })
    expect((await engine.get('wide', 'a'))?.title).toBe('only text')
    await expect(engine.createIndex('new-wide', { schema: { embedding: 'vector[5000]' } })).rejects.toMatchObject({
      code: ErrorCodes.SCHEMA_INVALID_VECTOR_DIMENSION,
    })
  })
})
