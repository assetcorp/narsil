import { describe, expect, it } from 'vitest'
import { copyCountOf, type PartitionRow, partitionRoleOf, tallyOf } from '../src/lib/cluster-types'
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
})

describe('copyCountOf', () => {
  it('counts the primary alongside its replicas', () => {
    expect(copyCountOf(partition())).toBe(2)
  })

  it('counts the replicas alone while the partition has no primary', () => {
    expect(copyCountOf(partition({ primary: null }))).toBe(1)
  })
})

describe('tallyOf', () => {
  const partitions = [
    partition({ partitionId: 0, primary: 'node-a', replicas: ['node-b'], inSyncSet: ['node-b'] }),
    partition({ partitionId: 1, primary: 'node-b', replicas: ['node-a'], inSyncSet: [] }),
    partition({ partitionId: 2, primary: 'node-c', replicas: ['node-a'], inSyncSet: ['node-a'] }),
  ]

  it('counts what one node leads, follows, and is catching up on', () => {
    expect(tallyOf(partitions, 'node-a')).toEqual({ leads: 1, inSync: 1, lagging: 1 })
  })

  it('counts nothing for a node that holds no copy', () => {
    expect(tallyOf(partitions, 'node-d')).toEqual({ leads: 0, inSync: 0, lagging: 0 })
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
