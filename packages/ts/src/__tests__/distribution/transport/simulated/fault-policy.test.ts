import { describe, expect, it } from 'vitest'
import { createFaultPolicy } from '../../../../distribution/transport/simulated/fault-policy'
import { createSeededPrng } from '../../../../distribution/transport/simulated/prng'

describe('seeded prng', () => {
  it('produces the same sequence for the same seed', () => {
    const first = createSeededPrng(42)
    const second = createSeededPrng(42)
    const firstValues = [first.next(), first.next(), first.next()]
    const secondValues = [second.next(), second.next(), second.next()]
    expect(firstValues).toEqual(secondValues)
  })

  it('produces a different sequence for a different seed', () => {
    const first = createSeededPrng(1)
    const second = createSeededPrng(2)
    expect(first.next()).not.toBe(second.next())
  })

  it('keeps every value in the unit interval', () => {
    const prng = createSeededPrng(7)
    for (let i = 0; i < 1_000; i++) {
      const value = prng.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('keeps nextInt inside the requested range', () => {
    const prng = createSeededPrng(11)
    for (let i = 0; i < 1_000; i++) {
      const value = prng.nextInt(3, 9)
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThan(9)
    }
  })

  it('returns the lower bound when the range is empty', () => {
    const prng = createSeededPrng(11)
    expect(prng.nextInt(5, 5)).toBe(5)
  })
})

describe('fault policy', () => {
  it('drops nothing by default', () => {
    const policy = createFaultPolicy({}, 1)
    for (let i = 0; i < 100; i++) {
      expect(policy.shouldDrop('node-a', 'node-b', 'query.search')).toBe(false)
    }
  })

  it('drops every message across a partitioned pair, in both directions', () => {
    const policy = createFaultPolicy({ partitions: [['node-a', 'node-b']] }, 1)
    expect(policy.shouldDrop('node-a', 'node-b', 'replication.entry')).toBe(true)
    expect(policy.shouldDrop('node-b', 'node-a', 'replication.ack')).toBe(true)
    expect(policy.shouldDrop('node-a', 'node-c', 'replication.entry')).toBe(false)
  })

  it('heals a partition when it is removed', () => {
    const policy = createFaultPolicy({}, 1)
    policy.addPartition('node-a', 'node-b')
    expect(policy.isPartitioned('node-b', 'node-a')).toBe(true)
    policy.removePartition('node-b', 'node-a')
    expect(policy.isPartitioned('node-a', 'node-b')).toBe(false)
    expect(policy.shouldDrop('node-a', 'node-b', 'replication.entry')).toBe(false)
  })

  it('drops at the configured rate under the same seed', () => {
    const countDrops = () => {
      const policy = createFaultPolicy({ dropRate: 0.5 }, 42)
      let drops = 0
      for (let i = 0; i < 1_000; i++) {
        if (policy.shouldDrop('node-a', 'node-b', 'replication.entry')) {
          drops++
        }
      }
      return drops
    }
    const first = countDrops()
    expect(first).toBeGreaterThan(350)
    expect(first).toBeLessThan(650)
    expect(countDrops()).toBe(first)
  })

  it('drops everything at rate one and nothing at rate zero', () => {
    const policy = createFaultPolicy({ dropRate: 1 }, 3)
    expect(policy.shouldDrop('node-a', 'node-b', 'replication.entry')).toBe(true)
    policy.setDropRate(0)
    expect(policy.shouldDrop('node-a', 'node-b', 'replication.entry')).toBe(false)
  })

  it('drops only the named message types when a drop filter is set', () => {
    const policy = createFaultPolicy(
      { dropRate: 1, dropMessageTypes: ['replication.entry', 'replication.entry_batch'] },
      3,
    )
    expect(policy.shouldDrop('node-a', 'node-b', 'replication.entry')).toBe(true)
    expect(policy.shouldDrop('node-a', 'node-b', 'replication.entry_batch')).toBe(true)
    expect(policy.shouldDrop('node-a', 'node-b', 'replication.ack')).toBe(false)
    expect(policy.shouldDrop('node-a', 'node-b', 'query.search')).toBe(false)
  })

  it('applies an updated drop filter and clears it with null', () => {
    const policy = createFaultPolicy({ dropRate: 1 }, 3)
    policy.setDropMessageTypes(['replication.entry'])
    expect(policy.shouldDrop('node-a', 'node-b', 'replication.ack')).toBe(false)
    expect(policy.shouldDrop('node-a', 'node-b', 'replication.entry')).toBe(true)
    policy.setDropMessageTypes(null)
    expect(policy.shouldDrop('node-a', 'node-b', 'replication.ack')).toBe(true)
  })

  it('drops every message type across a partition whatever the drop filter says', () => {
    const policy = createFaultPolicy({ dropMessageTypes: ['replication.entry'], partitions: [['node-a', 'node-b']] }, 3)
    expect(policy.shouldDrop('node-a', 'node-b', 'query.search')).toBe(true)
  })

  it('samples latency inside the configured range', () => {
    const policy = createFaultPolicy({ latencyMinMs: 2, latencyMaxMs: 8 }, 9)
    for (let i = 0; i < 500; i++) {
      const latency = policy.sampleLatency('node-a', 'node-b', 'query.search')
      expect(latency).toBeGreaterThanOrEqual(2)
      expect(latency).toBeLessThan(8)
    }
  })

  it('returns the minimum when the latency range collapses', () => {
    const policy = createFaultPolicy({ latencyMinMs: 4, latencyMaxMs: 4 }, 9)
    expect(policy.sampleLatency('node-a', 'node-b', 'query.search')).toBe(4)
  })

  it('applies an updated latency range', () => {
    const policy = createFaultPolicy({}, 5)
    policy.setLatencyRange(10, 20)
    for (let i = 0; i < 100; i++) {
      const latency = policy.sampleLatency('node-a', 'node-b', 'query.search')
      expect(latency).toBeGreaterThanOrEqual(10)
      expect(latency).toBeLessThan(20)
    }
  })

  it('samples latency from a stream the drop rate cannot disturb', () => {
    const sampleLatencies = (raiseDropRate: boolean): number[] => {
      const policy = createFaultPolicy({ latencyMinMs: 1, latencyMaxMs: 50 }, 42)
      const latencies: number[] = []
      for (let i = 0; i < 20; i++) {
        if (raiseDropRate && i === 5) {
          policy.setDropRate(0.5)
        }
        policy.shouldDrop('node-a', 'node-b', 'replication.entry')
        latencies.push(policy.sampleLatency('node-a', 'node-b', 'replication.entry'))
      }
      return latencies
    }

    expect(sampleLatencies(true)).toEqual(sampleLatencies(false))
  })

  it('samples latency from a stream that extra drop decisions cannot disturb', () => {
    const sampleLatencies = (extraDropChecks: number): number[] => {
      const policy = createFaultPolicy({ dropRate: 0.5, latencyMinMs: 1, latencyMaxMs: 50 }, 42)
      for (let i = 0; i < extraDropChecks; i++) {
        policy.shouldDrop('node-a', 'node-b', 'replication.entry')
      }
      return Array.from({ length: 10 }, () => policy.sampleLatency('node-a', 'node-b', 'replication.entry'))
    }

    expect(sampleLatencies(5)).toEqual(sampleLatencies(0))
  })

  it('draws drop decisions from a stream that extra latency samples cannot disturb', () => {
    const sampleDrops = (extraLatencySamples: number): boolean[] => {
      const policy = createFaultPolicy({ dropRate: 0.5, latencyMinMs: 1, latencyMaxMs: 50 }, 42)
      for (let i = 0; i < extraLatencySamples; i++) {
        policy.sampleLatency('node-a', 'node-b', 'replication.entry')
      }
      return Array.from({ length: 10 }, () => policy.shouldDrop('node-a', 'node-b', 'replication.entry'))
    }

    expect(sampleDrops(5)).toEqual(sampleDrops(0))
  })

  it('draws the same drop decisions whatever the latency range becomes', () => {
    const sampleDrops = (widenLatency: boolean): boolean[] => {
      const policy = createFaultPolicy({ dropRate: 0.5 }, 7)
      const drops: boolean[] = []
      for (let i = 0; i < 20; i++) {
        if (widenLatency && i === 5) {
          policy.setLatencyRange(100, 400)
        }
        policy.sampleLatency('node-a', 'node-b', 'replication.entry')
        drops.push(policy.shouldDrop('node-a', 'node-b', 'replication.entry'))
      }
      return drops
    }

    expect(sampleDrops(true)).toEqual(sampleDrops(false))
  })
})
