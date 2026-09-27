import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

describe('the reason that a worker promotion reports', () => {
  let narsil: Narsil

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('counts the batch that crosses the copy threshold', { timeout: 30_000 }, async () => {
    narsil = await createNarsil({ workers: { count: 1 } })
    await narsil.createIndex('tickets', { schema: { subject: 'string' } })
    const promoted = new Promise<string>(resolve => {
      narsil.on('workerPromote', payload => resolve(payload.reason))
    })

    await narsil.insertBatch(
      'tickets',
      Array.from({ length: 2_500 }, (_, i) => ({ id: `t${i}`, subject: 'gateway outage' })),
    )

    expect(await promoted).toBe(
      'Index "tickets" holds 0 documents, and the batch that the engine is writing adds 2500, for 2500 against the copy threshold of 1000',
    )
  })
})
