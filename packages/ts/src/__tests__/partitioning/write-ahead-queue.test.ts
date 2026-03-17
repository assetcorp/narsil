import { describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createWriteAheadQueue } from '../../partitioning/write-ahead-queue'

describe('WriteAheadQueue', () => {
  it('buffers entries and drains in sequence order', () => {
    const waq = createWriteAheadQueue(100)

    waq.push({ action: 'insert', docId: 'doc-1', indexName: 'test', document: { title: 'A' } })
    waq.push({ action: 'insert', docId: 'doc-2', indexName: 'test', document: { title: 'B' } })
    waq.push({ action: 'remove', docId: 'doc-1', indexName: 'test' })

    expect(waq.size).toBe(3)

    const entries = waq.drain()
    expect(entries).toHaveLength(3)
    expect(entries[0].sequenceNumber).toBeLessThan(entries[1].sequenceNumber)
    expect(entries[1].sequenceNumber).toBeLessThan(entries[2].sequenceNumber)
    expect(entries[0].action).toBe('insert')
    expect(entries[2].action).toBe('remove')
    expect(waq.size).toBe(0)
  })

  it('throws PARTITION_REBALANCING_BACKPRESSURE when full', () => {
    const waq = createWriteAheadQueue(3)

    waq.push({ action: 'insert', docId: 'a', indexName: 'test' })
    waq.push({ action: 'insert', docId: 'b', indexName: 'test' })
    waq.push({ action: 'insert', docId: 'c', indexName: 'test' })

    expect(waq.isFull).toBe(true)

    try {
      waq.push({ action: 'insert', docId: 'd', indexName: 'test' })
      expect.fail('Expected backpressure error')
    } catch (err) {
      expect(err).toBeInstanceOf(NarsilError)
      expect((err as NarsilError).code).toBe(ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE)
    }
  })

  it('clears all entries', () => {
    const waq = createWriteAheadQueue(100)
    waq.push({ action: 'insert', docId: 'a', indexName: 'test' })
    waq.push({ action: 'insert', docId: 'b', indexName: 'test' })

    waq.clear()
    expect(waq.size).toBe(0)
  })

  it('reports isFull correctly', () => {
    const waq = createWriteAheadQueue(2)
    expect(waq.isFull).toBe(false)

    waq.push({ action: 'insert', docId: 'a', indexName: 'test' })
    expect(waq.isFull).toBe(false)

    waq.push({ action: 'insert', docId: 'b', indexName: 'test' })
    expect(waq.isFull).toBe(true)
  })

  it('drain returns empty array when queue is empty', () => {
    const waq = createWriteAheadQueue(100)
    const entries = waq.drain()
    expect(entries).toHaveLength(0)
  })
})
