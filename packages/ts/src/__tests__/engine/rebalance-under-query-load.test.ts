import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

const DOCUMENT_COUNT = 85_000
const QUERY_LOOP_LIMIT_MS = 20_000

describe('a rebalance while queries arrive back to back', () => {
  let narsil: Narsil

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('finishes while a caller sends one query after another with no gap', { timeout: 60_000 }, async () => {
    narsil = await createNarsil()
    await narsil.createIndex('tickets', { schema: { subject: 'string' }, partitions: { maxPartitions: 8 } })
    await narsil.rebalance('tickets', 4)
    await narsil.insertBatch(
      'tickets',
      Array.from({ length: DOCUMENT_COUNT }, (_, i) => ({
        id: `t${i}`,
        subject: i % 4 === 0 ? 'gateway outage' : 'billing',
      })),
      { wait: true },
    )
    expect(narsil.getStats('tickets').partitionCount).toBe(4)

    let finished = false
    const rebalance = narsil.rebalance('tickets', 8).then(() => {
      finished = true
    })
    const started = Date.now()
    let queries = 0
    while (!finished && Date.now() - started < QUERY_LOOP_LIMIT_MS) {
      const result = await narsil.query('tickets', { term: 'gateway', limit: 1 })
      expect(result.count).toBe(DOCUMENT_COUNT / 4)
      queries++
    }
    const elapsed = Date.now() - started
    await rebalance

    expect({ finished, underLimit: elapsed < QUERY_LOOP_LIMIT_MS, queries, elapsed }).toMatchObject({
      finished: true,
      underLimit: true,
    })
    expect(narsil.getStats('tickets').partitionCount).toBe(8)
  })
})
