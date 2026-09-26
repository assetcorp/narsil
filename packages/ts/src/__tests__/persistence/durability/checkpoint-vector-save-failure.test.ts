import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { readSegmentManifest } from '../../../persistence/durability/segment'
import type { IndexConfig } from '../../../types/schema'

const vectorSave = vi.hoisted(() => ({ failing: false }))

vi.mock('../../../persistence/durability/segment/vector', async importOriginal => {
  const original = await importOriginal<typeof import('../../../persistence/durability/segment/vector')>()
  return {
    ...original,
    writeLiveVectors: async (input: Parameters<typeof original.writeLiveVectors>[0]) => {
      if (vectorSave.failing) throw new Error('simulated crash writing the vectors')
      return original.writeLiveVectors(input)
    },
  }
})

const DIMENSION = 8

const CONFIG: IndexConfig = {
  schema: { title: 'string', embedding: `vector[${DIMENSION}]` },
  language: 'english',
}

function embeddingFor(seed: number): number[] {
  const values: number[] = []
  for (let i = 0; i < DIMENSION; i += 1) values.push(((seed * 31 + i * 7) % 100) / 100)
  return values
}

describe('a checkpoint whose vector save fails', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-vector-save-failure-'))
    vectorSave.failing = false
  })

  afterEach(async () => {
    vectorSave.failing = false
    await rm(root, { recursive: true, force: true })
  })

  it('keeps the previous checkpoint in force and recovers every document from the log', async () => {
    const writer = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await writer.createIndex('papers', CONFIG)
    for (let i = 0; i < 40; i += 1) {
      await writer.insert('papers', { title: `harbour paper ${i}`, embedding: embeddingFor(i) }, `p${i}`)
    }
    await writer.checkpoint('papers')
    const before = await readSegmentManifest(createDurableDirectory(root), 'papers')

    for (let i = 40; i < 45; i += 1) {
      await writer.insert('papers', { title: `harbour paper ${i}`, embedding: embeddingFor(i) }, `p${i}`)
    }
    vectorSave.failing = true
    await expect(writer.checkpoint('papers')).rejects.toMatchObject({
      code: 'PERSISTENCE_SAVE_FAILED',
      details: { cause: 'simulated crash writing the vectors' },
    })
    vectorSave.failing = false

    expect(await readSegmentManifest(createDurableDirectory(root), 'papers')).toEqual(before)
    await writer.shutdown()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    expect(await reader.countDocuments('papers')).toBe(45)
    const found = await reader.query('papers', { term: 'harbour', limit: 50 })
    expect(found.count).toBe(45)
    const nearest = await reader.query('papers', { vector: { field: 'embedding', value: embeddingFor(44) }, limit: 1 })
    expect(nearest.hits[0]?.id).toBe('p44')
    await reader.shutdown()
  })
})
