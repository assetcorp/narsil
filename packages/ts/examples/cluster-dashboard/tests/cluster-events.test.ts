import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../src/lib/cluster-events'
import type { ClusterSnapshot, PartitionRow } from '../src/lib/cluster-types'

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

function snapshot(overrides: Partial<ClusterSnapshot> = {}): ClusterSnapshot {
  return {
    updatedAt: '2026-08-24T10:00:00.000Z',
    indexName: 'forum-answers',
    indexExists: true,
    allocationVersion: 4,
    replicationFactor: 1,
    controllerNodeId: 'node-a',
    nodes: [
      { nodeId: 'node-a', address: 'a:9301', roles: ['data'], startedAt: null, version: null, registered: true },
      { nodeId: 'node-b', address: 'b:9302', roles: ['data'], startedAt: null, version: null, registered: true },
    ],
    partitions: [partition()],
    links: [{ nodeId: 'node-a', kind: 'coordinator', proxyName: 'etcd-node-a', enabled: true }],
    coordinatorError: null,
    faultInjectorError: null,
    ...overrides,
  }
}

function textsOf(previous: ClusterSnapshot, next: ClusterSnapshot): string[] {
  return diffSnapshots(previous, next).map(event => event.text)
}

describe('diffSnapshots', () => {
  it('reports nothing while the cluster holds still', () => {
    expect(diffSnapshots(snapshot(), snapshot())).toEqual([])
  })

  it('reports a node whose registration expired', () => {
    const next = snapshot({
      nodes: [
        { nodeId: 'node-a', address: null, roles: [], startedAt: null, version: null, registered: false },
        { nodeId: 'node-b', address: 'b:9302', roles: ['data'], startedAt: null, version: null, registered: true },
      ],
    })

    expect(textsOf(snapshot(), next)).toContain('node-a lost its registration, because its lease expired')
  })

  it('reports the promotion that follows, naming both nodes and the new term', () => {
    const next = snapshot({
      partitions: [partition({ primary: 'node-b', primaryTerm: 2, replicas: [], inSyncSet: [] })],
    })

    expect(textsOf(snapshot(), next)).toContain('p0 promotes node-b over node-a at term 2')
  })

  it('reports a replica leaving the in-sync set and rejoining it', () => {
    const narrowed = snapshot({ partitions: [partition({ inSyncSet: [] })] })

    expect(textsOf(snapshot(), narrowed)).toContain('p0 drops node-b from its in-sync set')
    expect(textsOf(narrowed, snapshot())).toContain('p0 admits node-b to its in-sync set')
  })

  it('reports a cut link and the restore that follows', () => {
    const cut = snapshot({
      links: [{ nodeId: 'node-a', kind: 'coordinator', proxyName: 'etcd-node-a', enabled: false }],
    })

    expect(textsOf(snapshot(), cut)).toContain('node-a lost its coordinator link to a cut')
    expect(textsOf(cut, snapshot())).toContain('node-a has its coordinator link back')
  })

  it('reports the node that took the controller lease', () => {
    const next = snapshot({ controllerNodeId: 'node-b' })

    expect(textsOf(snapshot(), next)).toContain('node-b holds the controller lease')
  })

  it('reports the lease expiring before any node takes it over', () => {
    const unheld = snapshot({ controllerNodeId: null })

    expect(textsOf(snapshot(), unheld)).toContain('node-a let the controller lease expire, so no node holds it')
  })

  it('reports the whole failover sequence, from the expiry to the node that took over', () => {
    const unheld = snapshot({ controllerNodeId: null })
    const takenOver = snapshot({ controllerNodeId: 'node-b' })

    expect(textsOf(snapshot(), unheld)).toHaveLength(1)
    expect(textsOf(unheld, takenOver)).toContain('node-b holds the controller lease')
  })

  it('reports nothing while the same node keeps the lease', () => {
    expect(textsOf(snapshot(), snapshot())).toHaveLength(0)
  })

  it('reports a partition losing every copy, and names the nodes that still hold one', () => {
    const unserved = snapshot({
      partitions: [
        partition({
          state: 'UNASSIGNED',
          primary: null,
          replicas: [],
          inSyncSet: [],
          lastHolders: ['node-a', 'node-b'],
        }),
      ],
    })

    expect(textsOf(snapshot(), unserved)).toContain(
      'p0 lost every copy that served it, and node-a and node-b still hold a copy',
    )
  })

  it('leaves the in-sync set alone in the log while a partition serves nothing', () => {
    const unserved = snapshot({
      partitions: [
        partition({ state: 'UNASSIGNED', primary: null, replicas: [], inSyncSet: [], lastHolders: ['node-a'] }),
      ],
    })

    expect(textsOf(snapshot(), unserved)).not.toContain('p0 drops node-b from its in-sync set')
  })

  it('reports the reason the controller records for a partition that stays unserved', () => {
    const waiting = snapshot({
      partitions: [
        partition({ state: 'UNASSIGNED', primary: null, replicas: [], inSyncSet: [], lastHolders: ['node-a'] }),
      ],
    })
    const refused = snapshot({
      partitions: [
        partition({
          state: 'UNASSIGNED',
          primary: null,
          replicas: [],
          inSyncSet: [],
          lastHolders: ['node-a'],
          unassignedReason: 'HOLDER_WITHOUT_DATA',
        }),
      ],
    })

    expect(textsOf(waiting, refused)).toContain(
      'p0 stays unserved, because every holder answered without the partition',
    )
  })

  it('reports the holder the controller gives an unserved partition back to', () => {
    const unserved = snapshot({
      partitions: [
        partition({ state: 'UNASSIGNED', primary: null, replicas: [], inSyncSet: [], lastHolders: ['node-a'] }),
      ],
    })
    const filling = snapshot({
      partitions: [
        partition({ state: 'INITIALISING', primary: 'node-a', primaryTerm: 2, replicas: [], inSyncSet: [] }),
      ],
    })

    expect(textsOf(unserved, filling)).toContain('p0 comes back on node-a, which is filling its copy')
    expect(textsOf(filling, snapshot())).toContain('p0 finished filling and serves from node-a')
  })

  it('gives every event of one update its own identifier', () => {
    const next = snapshot({
      controllerNodeId: 'node-b',
      partitions: [partition({ primary: 'node-b', primaryTerm: 2, replicas: [], inSyncSet: [] })],
    })

    const ids = diffSnapshots(snapshot(), next).map(event => event.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('gives an event its own identifier across two updates that share a timestamp', () => {
    const withoutController = snapshot({ controllerNodeId: null })
    const withController = snapshot({ controllerNodeId: 'node-c' })

    const first = diffSnapshots(snapshot(), withoutController)
    const second = diffSnapshots(withoutController, withController)

    const ids = [...first, ...second].map(entry => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
