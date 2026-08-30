import { describe, expect, it } from 'vitest'
import { rebalanceLeadership } from '../../../../distribution/cluster/allocator'
import type { PartitionAssignment, PartitionState } from '../../../../distribution/coordinator/types'

function assignment(
  primary: string,
  replicas: string[],
  inSyncSet: string[],
  state: PartitionState = 'ACTIVE',
): PartitionAssignment {
  return { primary, replicas, inSyncSet, state, primaryTerm: 1, commitPoint: 0 }
}

function equalShares(nodeIds: string[]): Map<string, number> {
  return new Map(nodeIds.map(nodeId => [nodeId, 1]))
}

describe('handing leadership from a busy node to a quieter one', () => {
  it('keeps the node it demoted in the in-sync set', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [0, assignment('node-a', ['node-b'], ['node-b'])],
      [1, assignment('node-a', ['node-b'], ['node-b'])],
      [2, assignment('node-a', ['node-b'], ['node-b'])],
    ])

    rebalanceLeadership(assignments, equalShares(['node-a', 'node-b']))

    const handedOver = [...assignments.values()].filter(entry => entry.primary === 'node-b')
    expect(handedOver.length).toBeGreaterThan(0)
    for (const entry of handedOver) {
      expect(entry.replicas).toContain('node-a')
      expect(entry.inSyncSet).toContain('node-a')
    }
  })

  it('moves leadership off the next-busiest node when the busiest one offers no handover', () => {
    const assignments = new Map<number, PartitionAssignment>([
      [0, assignment('node-a', ['node-b'], ['node-b'], 'MIGRATING')],
      [1, assignment('node-a', ['node-b'], ['node-b'], 'MIGRATING')],
      [2, assignment('node-a', ['node-b'], ['node-b'], 'MIGRATING')],
      [3, assignment('node-a', ['node-b'], ['node-b'], 'MIGRATING')],
      [4, assignment('node-a', ['node-b'], ['node-b'], 'MIGRATING')],
      [5, assignment('node-b', ['node-c'], ['node-c'])],
      [6, assignment('node-b', ['node-c'], ['node-c'])],
      [7, assignment('node-b', ['node-c'], ['node-c'])],
    ])

    rebalanceLeadership(assignments, equalShares(['node-a', 'node-b', 'node-c']))

    const ledByC = [...assignments.values()].filter(entry => entry.primary === 'node-c')
    expect(ledByC.length).toBeGreaterThan(0)
  })
})
