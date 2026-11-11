import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes } from '../../errors'
import { createNarsil } from '../../narsil'
import type { Narsil } from '../../types/engine'
import { expectLayout, idsFrom } from './partition-layout-oracle'

const INDEX = 'items'
const DOCUMENTS = 300

describe('a rebalance target above the default of one partition', () => {
  let engine: Narsil | null = null

  afterEach(async () => {
    await engine?.shutdown()
    engine = null
  })

  async function indexWithoutMaxPartitions(): Promise<{ running: Narsil; titles: Map<string, string> }> {
    const running = await createNarsil({ workers: { enabled: false } })
    engine = running
    await running.createIndex(INDEX, { schema: { title: 'string' } })
    const ids = idsFrom('d', 0, DOCUMENTS)
    const inserted = await running.insertBatch(
      INDEX,
      ids.map(id => ({ id, title: `alpha ${id}` })),
    )
    expect(inserted.failed).toEqual([])
    return { running, titles: new Map(ids.map(id => [id, `alpha ${id}`])) }
  }

  it.each([
    2, 4, 65_536,
  ])('refuses %i partitions when maxPartitions is unset and keeps every document', async target => {
    const { running, titles } = await indexWithoutMaxPartitions()
    await expect(running.rebalance(INDEX, target)).rejects.toMatchObject({
      code: ErrorCodes.PARTITION_CAPACITY_EXCEEDED,
      details: { targetPartitionCount: target, maxPartitions: 1 },
    })
    await expectLayout(running, INDEX, titles, 1)
    await running.insert(INDEX, { title: 'alpha later' }, 'later')
    titles.set('later', 'alpha later')
    await expectLayout(running, INDEX, titles, 1)
  })

  it('accepts a target of one partition as a no-op, and a raised maxPartitions lets the same target through', async () => {
    const { running, titles } = await indexWithoutMaxPartitions()
    await running.rebalance(INDEX, 1)
    await expectLayout(running, INDEX, titles, 1)
    await running.updatePartitionConfig(INDEX, { maxPartitions: 4 })
    await running.rebalance(INDEX, 4)
    await expectLayout(running, INDEX, titles, 4)
  })
})
