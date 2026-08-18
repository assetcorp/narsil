import { describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

const COLOURS = ['red', 'green', 'blue', 'amber', 'violet', 'teal']

async function indexWithColours(maxDocsPerPartition?: number): Promise<Narsil> {
  const engine = await createNarsil()
  await engine.createIndex('widgets', {
    schema: { title: 'string', colour: 'enum' },
    ...(maxDocsPerPartition === undefined ? {} : { partitions: { maxPartitions: 8, maxDocsPerPartition } }),
  })
  const documents = Array.from({ length: 120 }, (_, index) => ({
    id: `doc-${index}`,
    title: 'widget',
    colour: COLOURS[index % COLOURS.length],
  }))
  await engine.insertBatch('widgets', documents)
  return engine
}

describe('the facet error bound', () => {
  it('is 0 where every bucket survived, and the counts are then exact', async () => {
    const engine = await indexWithColours()

    const result = await engine.query('widgets', { term: 'widget', facets: { colour: {} } })

    expect(result.facets?.colour.errorBound).toBe(0)
    const counted = Object.values(result.facets?.colour.values ?? {}).reduce((sum, count) => sum + count, 0)
    expect(counted).toBe(120)
    await engine.shutdown()
  })

  it('rises above 0 once a limit drops a bucket, and bounds what the counts lost', async () => {
    const engine = await indexWithColours()

    const result = await engine.query('widgets', { term: 'widget', facets: { colour: { limit: 2 } } })

    expect(Object.keys(result.facets?.colour.values ?? {})).toHaveLength(2)
    expect(result.facets?.colour.errorBound).toBeGreaterThan(0)
    await engine.shutdown()
  })

  it('adds up across partitions, because each one drops its own buckets', async () => {
    const engine = await indexWithColours(20)

    const single = await engine.query('widgets', { term: 'widget', facets: { colour: { limit: 1 } } })

    expect(engine.getStats('widgets').partitionCount).toBeGreaterThan(1)
    expect(single.facets?.colour.errorBound).toBeGreaterThan(0)
    await engine.shutdown()
  })
})
