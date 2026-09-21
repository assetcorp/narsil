import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../persistence/durability/constants', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../persistence/durability/constants')>()),
  COMPACTION_LARGEST_MERGED_DOCUMENT_COUNT: 25,
}))

import { getLanguage } from '../../../languages/registry'
import { createNarsil } from '../../../narsil'
import { createDurableDirectory } from '../../../persistence/durability/durable-filesystem'
import { readSegmentManifest } from '../../../persistence/durability/segment'
import { compactPartitionSegments } from '../../../persistence/durability/segment/compaction'
import type { IndexConfig } from '../../../types/schema'

const CONFIG: IndexConfig = { schema: { title: 'string' }, language: 'english' }

describe('compaction of checkpoint segments under the merged-segment limit', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-compaction-limit-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function compactAfterCheckpointsOf(sizes: number[]): Promise<number[]> {
    const engine = await createNarsil({
      durability: { directory: root, compactionThreshold: 100 },
      workers: { enabled: false },
    })
    await engine.createIndex('docs', CONFIG)
    let next = 0
    for (const size of sizes) {
      const documents = []
      for (let i = 0; i < size; i += 1, next += 1) documents.push({ id: `d${next}`, title: `harbour light ${next}` })
      expect((await engine.insertBatch('docs', documents)).failed).toEqual([])
      await engine.checkpoint('docs')
    }
    await engine.shutdown()

    const directory = createDurableDirectory(root)
    const partition = (await readSegmentManifest(directory, 'docs'))?.partitions[0]
    if (partition === undefined) throw new Error('the manifest lists no partition')
    expect(partition.segments.map(segment => segment.docCount)).toEqual(sizes)
    const compacted = await compactPartitionSegments({
      directory,
      indexName: 'docs',
      partitionId: 0,
      config: CONFIG,
      language: getLanguage('english'),
      segments: partition.segments,
      nextSegmentId: partition.nextSegmentId,
      compactionThreshold: 2,
    })
    return compacted.segments.map(segment => segment.docCount)
  }

  it('merges as many of the cheapest segments as the limit allows', async () => {
    expect(await compactAfterCheckpointsOf([40, 12, 10])).toEqual([40, 22])
  })

  it('leaves every segment unmerged once each merge would exceed the limit', async () => {
    expect(await compactAfterCheckpointsOf([40, 14, 14])).toEqual([40, 14, 14])
  })
})
