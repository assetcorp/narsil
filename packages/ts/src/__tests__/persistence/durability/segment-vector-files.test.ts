import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { readSegmentManifest } from '../../../persistence/durability/segment'
import type { VectorFieldRef } from '../../../persistence/durability/segment/manifest'
import type { IndexConfig } from '../../../types/schema'

const DIMENSION = 8

const CONFIG: IndexConfig = {
  schema: { title: 'string', embedding: `vector[${DIMENSION}]` },
  language: 'english',
  vectorPromotion: { threshold: 8, quantization: 'none' },
}

function embeddingFor(seed: number): number[] {
  const values: number[] = []
  for (let i = 0; i < DIMENSION; i += 1) values.push(((seed * 31 + i * 7) % 100) / 100 + 0.01)
  return values
}

describe('the vector files of a segmented checkpoint', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-vector-files-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function open(): Promise<Narsil> {
    return createNarsil({ durability: { directory: root }, workers: { enabled: false } })
  }

  async function insertPapers(engine: Narsil, from: number, to: number): Promise<void> {
    for (let i = from; i < to; i += 1) {
      await engine.insert('papers', { title: `Paper ${i}`, embedding: embeddingFor(i) }, `p${i}`)
    }
  }

  async function listedField(): Promise<VectorFieldRef> {
    const manifest = await readSegmentManifest(createDurableDirectory(root), 'papers')
    const field = manifest?.vectors[0]
    if (field === undefined) throw new Error('the manifest lists no vector field')
    return field
  }

  async function modifiedAt(key: string): Promise<number> {
    return (await stat(await createDurableDirectory(root).pathOf(key))).mtimeMs
  }

  it('leaves a written vector file as it is and writes the later vectors into a new file', async () => {
    const engine = await open()
    await engine.createIndex('papers', CONFIG)
    await insertPapers(engine, 0, 30)
    await engine.checkpoint('papers')
    const first = await listedField()
    const writtenAt = await modifiedAt(first.files[0].key)

    await insertPapers(engine, 30, 40)
    await engine.checkpoint('papers')
    const second = await listedField()
    await engine.shutdown()

    expect(first.files.map(file => file.count)).toEqual([30])
    expect(second.files.map(file => file.count)).toEqual([30, 10])
    expect(second.files[0]).toEqual(first.files[0])
    expect(await modifiedAt(first.files[0].key)).toBe(writtenAt)
    expect(second.graphGeneration).toBe(first.graphGeneration + 1)
    expect(second.nextFileId).toBe(2)
  })

  it('marks a removed vector dead, keeps its file, and recovers without it', async () => {
    const engine = await open()
    await engine.createIndex('papers', CONFIG)
    await insertPapers(engine, 0, 30)
    await engine.checkpoint('papers')
    await engine.remove('papers', 'p4')
    await engine.checkpoint('papers')
    const field = await listedField()
    await engine.shutdown()

    expect(field.files).toHaveLength(1)
    expect([...(field.files[0].dead ?? [])]).toEqual([0b0001_0000, 0, 0, 0])

    const reader = await open()
    const hits = await reader.query('papers', { vector: { field: 'embedding', value: embeddingFor(4) }, limit: 30 })
    expect(hits.hits.map(hit => hit.id)).not.toContain('p4')
    expect(hits.hits).toHaveLength(29)
    await reader.shutdown()
  })

  it('keeps a replaced file while a removed vector still reads from it, and deletes it afterwards', async () => {
    const engine = await open()
    await engine.createIndex('papers', CONFIG)
    await insertPapers(engine, 0, 30)
    await engine.checkpoint('papers')
    const first = await listedField()
    for (let i = 0; i < 10; i += 1) await engine.remove('papers', `p${i}`)
    await engine.checkpoint('papers')
    const second = await listedField()
    const directory = createDurableDirectory(root)

    expect(second.files.map(file => file.count)).toEqual([20])
    expect(await directory.list('papers/segments/')).toContain(first.files[0].key)
    expect(await directory.list('papers/segments/')).not.toContain(first.graphKey)

    await engine.compactVectors('papers', 'embedding')
    await insertPapers(engine, 30, 31)
    await engine.checkpoint('papers')

    expect(await directory.list('papers/segments/')).not.toContain(first.files[0].key)
    const document = await engine.get('papers', 'p17')
    expect(Array.from(document?.embedding as Float32Array)).toEqual(Array.from(new Float32Array(embeddingFor(17))))
    await engine.shutdown()
  })

  it('writes no vector again at the first checkpoint after a restart', async () => {
    const writer = await open()
    await writer.createIndex('papers', CONFIG)
    await insertPapers(writer, 0, 30)
    await writer.checkpoint('papers')
    const before = await listedField()
    await writer.shutdown()

    const reader = await open()
    await insertPapers(reader, 30, 35)
    await reader.checkpoint('papers')
    const after = await listedField()
    const query = { vector: { field: 'embedding', value: embeddingFor(33) }, limit: 3 }
    const expected = (await reader.query('papers', query)).hits.map(hit => hit.id)
    await reader.shutdown()

    expect(after.files[0]).toEqual(before.files[0])
    expect(after.files.map(file => file.count)).toEqual([30, 5])

    const again = await open()
    expect((await again.query('papers', query)).hits.map(hit => hit.id)).toEqual(expected)
    expect((await again.vectorMaintenanceStatus('papers'))[0]).toMatchObject({ graphCount: 1, bufferSize: 0 })
    await again.shutdown()
  })

  it('refuses to recover a field whose vector file is gone', async () => {
    const writer = await open()
    await writer.createIndex('papers', CONFIG)
    await insertPapers(writer, 0, 30)
    await writer.checkpoint('papers')
    const field = await listedField()
    await writer.shutdown()
    await createDurableDirectory(root).remove(field.files[0].key)

    await expect(open()).rejects.toThrow(/vector file .* is missing/)
  })
})
