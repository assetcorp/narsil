import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'

const HEAP_LIMIT_BYTES = 1_000_000

const heapReadings = vi.hoisted(() => ({ calls: 0, pressuredCall: 2 }))

vi.mock('../../runtime/heap-statistics', () => ({
  readHeapStatistics: () => {
    heapReadings.calls++
    const usedBytes = heapReadings.calls === heapReadings.pressuredCall ? 950_000 : 500_000
    return { usedBytes, limitBytes: HEAP_LIMIT_BYTES, availableBytes: null, configuredLimitBytes: HEAP_LIMIT_BYTES }
  },
}))

describe('the heap pressure check inside one large batch', () => {
  let narsil: Narsil

  afterEach(async () => {
    await narsil.shutdown()
  })

  it('warns when the heap passes nine tenths between two chunks of the same batch', async () => {
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('tickets', { schema: { subject: 'string' } })
    const warnings: number[] = []
    narsil.on('heapPressure', payload => warnings.push(payload.heapUsed))
    heapReadings.calls = 0

    await narsil.insertBatch(
      'tickets',
      Array.from({ length: 3_500 }, (_, i) => ({ id: `t${i}`, subject: 'gateway outage' })),
    )

    expect(heapReadings.calls).toBeGreaterThan(1)
    expect(warnings).toEqual([950_000])
  })
})
