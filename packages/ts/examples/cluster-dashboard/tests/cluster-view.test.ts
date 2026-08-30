import { describe, expect, it } from 'vitest'
import {
  copyCountOf,
  type PartitionRow,
  partitionIdsOf,
  partitionRoleOf,
  recoveryTextOf,
} from '../src/lib/cluster-types'
import { topicOf } from '../src/lib/corpus'

function partition(overrides: Partial<PartitionRow> = {}): PartitionRow {
  return {
    partitionId: 0,
    state: 'ACTIVE',
    primary: 'node-a',
    primaryTerm: 1,
    commitPoint: 12,
    replicas: ['node-b'],
    inSyncSet: ['node-b'],
    lastHolders: [],
    unassignedReason: null,
    ...overrides,
  }
}

describe('partitionRoleOf', () => {
  it('names the primary of the partition', () => {
    expect(partitionRoleOf(partition(), 'node-a')).toBe('primary')
  })

  it('names a replica the in-sync set still holds', () => {
    expect(partitionRoleOf(partition(), 'node-b')).toBe('in-sync-replica')
  })

  it('names a replica the primary has dropped from the in-sync set', () => {
    expect(partitionRoleOf(partition({ inSyncSet: [] }), 'node-b')).toBe('lagging-replica')
  })

  it('names a node that holds no copy of the partition', () => {
    expect(partitionRoleOf(partition(), 'node-c')).toBe('absent')
  })

  it('names a node that still holds the data of a partition no node serves', () => {
    const unserved = partition({
      state: 'UNASSIGNED',
      primary: null,
      replicas: [],
      inSyncSet: [],
      lastHolders: ['node-b'],
    })

    expect(partitionRoleOf(unserved, 'node-b')).toBe('last-holder')
    expect(partitionRoleOf(unserved, 'node-c')).toBe('absent')
  })

  it('names a holder of a partition another node is filling', () => {
    const filling = partition({ state: 'INITIALISING', primary: 'node-a', replicas: [], lastHolders: ['node-b'] })

    expect(partitionRoleOf(filling, 'node-b')).toBe('last-holder')
  })
})

describe('recoveryTextOf', () => {
  it('says nothing about a partition a node serves', () => {
    expect(recoveryTextOf(partition())).toBeNull()
  })

  it('reads the reason the controller recorded', () => {
    const unserved = partition({ state: 'UNASSIGNED', primary: null, unassignedReason: 'HOLDER_WITHOUT_DATA' })

    expect(recoveryTextOf(unserved)).toBe('every holder answered without the partition')
  })

  it('says the controller is still asking while it has recorded no reason', () => {
    const unserved = partition({ state: 'UNASSIGNED', primary: null, lastHolders: ['node-b'] })

    expect(recoveryTextOf(unserved)).toBe('the controller is asking the holders')
  })

  it('says no node ever held a partition that reaches the unserved state empty', () => {
    const unserved = partition({ state: 'UNASSIGNED', primary: null, lastHolders: [] })

    expect(recoveryTextOf(unserved)).toBe('no node ever held this partition')
  })
})

describe('copyCountOf', () => {
  it('counts the primary alongside its replicas', () => {
    expect(copyCountOf(partition())).toBe(2)
  })

  it('counts the replicas alone while the partition has no primary', () => {
    expect(copyCountOf(partition({ primary: null }))).toBe(1)
  })
})

describe('partitionIdsOf', () => {
  const partitions = [
    partition({ partitionId: 0, primary: 'node-a', replicas: ['node-b'], inSyncSet: ['node-b'] }),
    partition({ partitionId: 1, primary: 'node-b', replicas: ['node-a'], inSyncSet: [] }),
    partition({ partitionId: 2, primary: 'node-c', replicas: ['node-a'], inSyncSet: ['node-a'] }),
  ]

  it('names the partitions one node leads', () => {
    expect(partitionIdsOf(partitions, 'node-a', 'primary')).toEqual([0])
  })

  it('separates the copies that keep up from the copies that are catching up', () => {
    expect(partitionIdsOf(partitions, 'node-a', 'in-sync-replica')).toEqual([2])
    expect(partitionIdsOf(partitions, 'node-a', 'lagging-replica')).toEqual([1])
  })

  it('names nothing for a node that holds no copy', () => {
    expect(partitionIdsOf(partitions, 'node-d', 'primary')).toEqual([])
  })
})

describe('topicOf', () => {
  it('reads the topic from the first keyword the answer uses', () => {
    expect(topicOf('How do I file my tax return?')).toBe('tax')
  })

  it('falls back to the general topic where no keyword appears', () => {
    expect(topicOf('Nothing here matches the keyword table')).toBe('general')
  })
})
