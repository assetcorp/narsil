import { describe, expect, it } from 'vitest'
import { createHeapPressureNotifier } from '../../engine/heap-pressure'
import type { NarsilEventMap } from '../../types/events'

const HEAP_LIMIT_BYTES = 1_000
const INDEX_BYTES = 640
const USED_BYTES = 400

function notifierReadingHeadroom(readings: Array<number | null>) {
  const events: Array<NarsilEventMap['heapPressure']> = []
  const notifier = createHeapPressureNotifier({
    readHeap: () => {
      const availableBytes = readings.shift()
      if (availableBytes === null || availableBytes === undefined) return null
      return { usedBytes: USED_BYTES, limitBytes: HEAP_LIMIT_BYTES, availableBytes }
    },
    estimateIndexBytes: () => INDEX_BYTES,
    emit: payload => events.push(payload),
  })
  return { notifier, events }
}

function notifierReadingUsedAlone(readings: number[]) {
  const events: Array<NarsilEventMap['heapPressure']> = []
  const notifier = createHeapPressureNotifier({
    readHeap: () => {
      const usedBytes = readings.shift()
      if (usedBytes === undefined) return null
      return { usedBytes, limitBytes: HEAP_LIMIT_BYTES, availableBytes: null }
    },
    estimateIndexBytes: () => INDEX_BYTES,
    emit: payload => events.push(payload),
  })
  return { notifier, events }
}

describe('heap pressure warning', () => {
  it('warns once when the headroom falls to a tenth of the limit, and again after it recovers', () => {
    const { notifier, events } = notifierReadingHeadroom([500, 50, 40, 150, 300, 50])

    for (let check = 0; check < 6; check++) notifier.check('docs')

    expect(events).toEqual([
      { indexName: 'docs', heapUsed: USED_BYTES, heapLimit: HEAP_LIMIT_BYTES, estimatedMemoryBytes: INDEX_BYTES },
      { indexName: 'docs', heapUsed: USED_BYTES, heapLimit: HEAP_LIMIT_BYTES, estimatedMemoryBytes: INDEX_BYTES },
    ])
  })

  it('reads the used bytes where the runtime reports no headroom', () => {
    const { notifier, events } = notifierReadingUsedAlone([500, 950, 960, 850, 700, 950])

    for (let check = 0; check < 6; check++) notifier.check('docs')

    expect(events).toEqual([
      { indexName: 'docs', heapUsed: 950, heapLimit: HEAP_LIMIT_BYTES, estimatedMemoryBytes: INDEX_BYTES },
      { indexName: 'docs', heapUsed: 950, heapLimit: HEAP_LIMIT_BYTES, estimatedMemoryBytes: INDEX_BYTES },
    ])
  })

  it('stays quiet where the runtime reports no heap statistics', () => {
    const { notifier, events } = notifierReadingHeadroom([null, null])

    notifier.check('docs')
    notifier.check('docs')

    expect(events).toEqual([])
  })
})
