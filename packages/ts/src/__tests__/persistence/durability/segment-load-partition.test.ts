import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isCompositePartition } from '../../../core/partition/composite'
import { getLanguage } from '../../../languages/registry'
import { createNarsil } from '../../../narsil'
import { createPartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { readSegmentManifest } from '../../../persistence/durability/segment'
import { loadPartitionSegmentBySegment } from '../../../persistence/durability/segment/load-partition'
import type { IndexConfig } from '../../../types/schema'

const CONFIG: IndexConfig = { schema: { title: 'string', year: 'number' }, language: 'english' }

describe('a partition that recovery loads one checkpoint segment at a time', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-load-partition-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeThreeCheckpoints(): Promise<void> {
    const engine = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    await engine.createIndex('docs', CONFIG)
    for (let i = 0; i < 6; i += 1) await engine.insert('docs', { title: `harbour light ${i}`, year: 1900 + i }, `d${i}`)
    await engine.checkpoint('docs')
    await engine.update('docs', 'd1', { title: 'mountain railway', year: 1950 })
    await engine.remove('docs', 'd2')
    await engine.checkpoint('docs')
    await engine.insert('docs', { title: 'harbour wall', year: 1999 }, 'd9')
    await engine.checkpoint('docs')
    await engine.shutdown()
  }

  it('keeps the newest copy of each document, drops what a later segment removed, and holds them frozen', async () => {
    await writeThreeCheckpoints()
    const directory = createDurableDirectory(root)
    const manifest = await readSegmentManifest(directory, 'docs')
    const partition = manifest?.partitions[0]
    if (partition === undefined) throw new Error('the manifest lists no partition')
    const manager = createPartitionManager('docs', CONFIG, getLanguage('english'), createPartitionRouter(), 1)

    await loadPartitionSegmentBySegment(directory, partition, manager)

    expect(partition.segments).toHaveLength(3)
    expect(manager.countDocuments()).toBe(6)
    expect(manager.has('d2')).toBe(false)
    expect(manager.get('d1')).toMatchObject({ title: 'mountain railway', year: 1950 })
    expect(manager.get('d9')).toMatchObject({ title: 'harbour wall' })
    const loaded = manager.getPartition(0)
    expect(isCompositePartition(loaded) && loaded.frozenSegmentCount() > 0).toBe(true)
    expect(isCompositePartition(loaded) && loaded.live.count()).toBe(0)
  })

  it('answers a recovered engine as the engine that wrote the checkpoints did', async () => {
    await writeThreeCheckpoints()

    const reader = await createNarsil({ durability: { directory: root }, workers: { enabled: false } })
    const harbour = await reader.query('docs', { term: 'harbour', limit: 10 })
    const railway = await reader.query('docs', { term: 'railway', limit: 10 })
    const recent = await reader.query('docs', {
      term: 'harbour railway',
      filters: { fields: { year: { gte: 1950 } } },
      limit: 10,
    })
    await reader.shutdown()

    expect(harbour.hits.map(hit => hit.id).sort()).toEqual(['d0', 'd3', 'd4', 'd5', 'd9'])
    expect(railway.hits.map(hit => hit.id)).toEqual(['d1'])
    expect(recent.hits.map(hit => hit.id).sort()).toEqual(['d1', 'd9'])
  })
})
