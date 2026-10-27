import { afterEach, describe, expect, it } from 'vitest'
import {
  createTestCluster,
  entryForDocument,
  INDEX,
  ofType,
  onceFor,
  outcomeOf,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitForCopies,
  waitUntil,
} from './harness'

describe('a failed replicated update rolls back before the next write to its partition starts', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('keeps the acknowledged second update when the first one rolls back', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start('node-a', { durable: false })
    await cluster.start('node-b', { durable: false })
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    const table = await waitUntil('both data nodes to hold the partition in sync', async () => {
      const current = await cluster.coordinator.getAllocation(INDEX)
      const assignment = partitionAssignment(current)
      return assignment?.state === 'ACTIVE' && assignment.inSyncSet.length === 1 ? current : null
    })
    const assignment = partitionAssignment(table)
    const primary = assignment?.primary ?? ''
    const replica = assignment?.inSyncSet[0] ?? ''

    await cluster.node(primary).insert(INDEX, { title: 'opening balance', amount: 0 }, 'account-7')
    await waitForCopies(cluster.coordinator, primary, [replica])

    const primaryTransport = cluster.transport(primary)
    primaryTransport.dropWhen(onceFor(entryForDocument('account-7')))
    primaryTransport.dropWhen(onceFor(ofType('replication.insync_remove')))

    const first = outcomeOf(cluster.node(primary).update(INDEX, 'account-7', { title: 'first deposit', amount: 100 }))
    const second = outcomeOf(cluster.node(primary).update(INDEX, 'account-7', { title: 'second deposit', amount: 250 }))
    const outcomes = [await first, await second]

    expect(outcomes[0].state).toBe('refused')
    expect(outcomes[1].state).toBe('acknowledged')
    const primaryCopy = await readCopy(cluster.probe, primary)
    expect(primaryCopy.get('account-7')).toEqual({ title: 'second deposit', amount: 250 })
    expect(await cluster.node(primary).get(INDEX, 'account-7')).toMatchObject({ title: 'second deposit', amount: 250 })
  })
})
