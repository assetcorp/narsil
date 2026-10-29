import { afterEach, describe, expect, it } from 'vitest'
import { createTestCluster, INDEX, outcomeOf, readCopy, SCHEMA, type TestCluster, waitUntil } from './harness'

const PARTITIONS = 2
const SETTLED_WRITES = 20

describe('a cluster whose coordinator stops answering', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('routes searches and writes by the allocation table it last watched', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b', 'node-c']) await cluster.start(nodeId)
    await cluster
      .node('controller')
      .createIndex(INDEX, { schema: SCHEMA }, { partitionCount: PARTITIONS, replicationFactor: 1 })
    const settled = await waitUntil('every partition to hold two copies in sync', async () => {
      const table = await cluster.coordinator.getAllocation(INDEX)
      if (table === null || table.assignments.size !== PARTITIONS) return null
      for (const assignment of table.assignments.values()) {
        if (assignment.state !== 'ACTIVE' || assignment.inSyncSet.length !== 1) return null
      }
      return table
    })

    const expected = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < SETTLED_WRITES; i++) {
      await cluster.node('node-a').insert(INDEX, { title: `deposit ${i}`, amount: i }, `account-${i}`)
      expected.set(`account-${i}`, { title: `deposit ${i}`, amount: i })
    }

    const restore = cluster.coordinator.cutOff()
    try {
      for (const nodeId of ['node-a', 'node-b', 'node-c']) {
        const found = await cluster.node(nodeId).query(INDEX, { term: 'deposit', limit: SETTLED_WRITES + 5 })
        expect(found.hits.map(hit => hit.id).sort(), nodeId).toEqual([...expected.keys()].sort())
      }

      const outcome = await outcomeOf(
        cluster.node('node-b').insert(INDEX, { title: 'deposit during the outage', amount: 99 }, 'account-outage'),
      )
      expect(outcome).toEqual({ state: 'acknowledged' })
      expected.set('account-outage', { title: 'deposit during the outage', amount: 99 })
    } finally {
      restore()
    }

    const held = new Map<string, Record<string, unknown>>()
    for (const [partitionId, assignment] of settled.assignments) {
      const primaryCopy = await readCopy(cluster.probe, assignment.primary ?? '', partitionId)
      for (const replica of assignment.inSyncSet) {
        const replicaCopy = await readCopy(cluster.probe, replica, partitionId)
        expect(Object.fromEntries(replicaCopy), `${replica} partition ${partitionId}`).toEqual(
          Object.fromEntries(primaryCopy),
        )
      }
      for (const [docId, document] of primaryCopy) held.set(docId, document)
    }
    expect(Object.fromEntries(held)).toEqual(Object.fromEntries(expected))
  }, 60_000)
})
