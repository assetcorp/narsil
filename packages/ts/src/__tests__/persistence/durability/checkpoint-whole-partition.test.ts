import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { readSegmentManifest } from '../../../persistence/durability/segment'
import type { IndexConfig } from '../../../types/schema'

const SCHEMA: IndexConfig = {
  schema: { title: 'string', year: 'number' },
  language: 'english',
}

async function insertRange(engine: Narsil, from: number, to: number): Promise<void> {
  const documents = []
  for (let i = from; i < to; i += 1) documents.push({ id: `d${i}`, title: `harbour light number ${i}`, year: 1900 + i })
  const result = await engine.insertBatch('docs', documents)
  expect(result.failed).toEqual([])
}

async function segmentDocCounts(root: string): Promise<number[]> {
  const manifest = await readSegmentManifest(createDurableDirectory(root), 'docs')
  if (manifest === null) throw new Error('manifest missing')
  return manifest.partitions[0].segments.map(segment => segment.docCount)
}

describe('a checkpoint after most of a partition changed', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-whole-partition-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('saves the partition that the engine already holds as one segment, and a small change as its own segment', async () => {
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('docs', SCHEMA)
    await insertRange(writer, 0, 10)
    await writer.checkpoint('docs')
    expect(await segmentDocCounts(root)).toEqual([10])

    await insertRange(writer, 10, 40)
    await writer.remove('docs', 'd3')
    await writer.checkpoint('docs')
    expect(await segmentDocCounts(root)).toEqual([39])

    await insertRange(writer, 40, 42)
    await writer.checkpoint('docs')
    expect(await segmentDocCounts(root)).toEqual([39, 2])
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect(await reader.countDocuments('docs')).toBe(41)
    expect(await reader.get('docs', 'd3')).toBeUndefined()
    expect(await reader.get('docs', 'd41')).toMatchObject({ title: 'harbour light number 41' })
    const found = await reader.query('docs', { term: 'harbour', limit: 50 })
    expect(found.count).toBe(41)
    await reader.shutdown()
  })

  it('recovers an empty index after every document of a checkpointed partition was removed', async () => {
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('docs', SCHEMA)
    await insertRange(writer, 0, 6)
    await writer.checkpoint('docs')
    for (let i = 0; i < 6; i += 1) await writer.remove('docs', `d${i}`)
    await writer.checkpoint('docs')
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect(await reader.countDocuments('docs')).toBe(0)
    await insertRange(reader, 0, 2)
    expect(await reader.countDocuments('docs')).toBe(2)
    await reader.shutdown()
  })

  it('recovers a document that arrived while the checkpoint was writing', async () => {
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('docs', SCHEMA)
    await insertRange(writer, 0, 30)
    const checkpointing = writer.checkpoint('docs')
    await insertRange(writer, 30, 33)
    await checkpointing
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect(await reader.countDocuments('docs')).toBe(33)
    expect(await reader.get('docs', 'd32')).toMatchObject({ year: 1932 })
    await reader.shutdown()
  })
})
