import { describe, expect, it } from 'vitest'
import { createHeapPressureNotifier } from '../../engine/heap-pressure'
import type { NarsilEventMap } from '../../types/events'

const HEAP_LIMIT_BYTES = 1_000
const INDEX_BYTES = 640

function notifierReading(readings: Array<number | null>) {
  const events: Array<NarsilEventMap['heapPressure']> = []
  const notifier = createHeapPressureNotifier({
    readHeap: () => {
      const usedBytes = readings.shift()
      return usedBytes === null || usedBytes === undefined ? null : { usedBytes, limitBytes: HEAP_LIMIT_BYTES }
    },
    estimateIndexBytes: () => INDEX_BYTES,
    emit: payload => events.push(payload),
  })
  return { notifier, events }
}

describe('heap pressure warning', () => {
  it('warns once when the heap crosses nine tenths of its limit, and again after it falls back', () => {
    const { notifier, events } = notifierReading([500, 950, 960, 850, 700, 950])

    for (let check = 0; check < 6; check++) notifier.check('docs')

    expect(events).toEqual([
      { indexName: 'docs', heapUsed: 950, heapLimit: HEAP_LIMIT_BYTES, estimatedMemoryBytes: INDEX_BYTES },
      { indexName: 'docs', heapUsed: 950, heapLimit: HEAP_LIMIT_BYTES, estimatedMemoryBytes: INDEX_BYTES },
    ])
  })

  it('stays quiet where the runtime reports no heap statistics', () => {
    const { notifier, events } = notifierReading([null, null])

    notifier.check('docs')
    notifier.check('docs')

    expect(events).toEqual([])
  })
})
