import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../narsil'
import { manifestOnDisk } from './manifest-on-disk'

describe('an import that outruns its checkpoints', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'narsil-write-stall-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('acknowledges every write and checkpoints every record', async () => {
    const engine = await createNarsil({
      durability: { directory: root, checkpointMutationThreshold: 10 },
      workers: { enabled: false },
    })
    await engine.createIndex('docs', { schema: { title: 'string' }, language: 'english' })
    const batches = []
    for (let batch = 0; batch < 12; batch += 1) {
      const documents = []
      for (let i = 0; i < 25; i += 1) documents.push({ id: `d${batch}-${i}`, title: `harbour light ${batch} ${i}` })
      batches.push(engine.insertBatch('docs', documents))
    }

    const results = await Promise.all(batches)
    await engine.checkpoint('docs')
    const manifest = await manifestOnDisk(root, 'docs')
    await engine.shutdown()

    expect(results.flatMap(result => result.failed)).toEqual([])
    expect(manifest?.checkpoint).toEqual([{ partitionId: 0, lastSeqNo: 300, primaryTerm: 1 }])
  })
})
