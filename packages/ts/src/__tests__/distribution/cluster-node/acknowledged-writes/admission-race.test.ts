import { afterEach, describe, expect, it } from 'vitest'
import {
  createTestCluster,
  entryForDocument,
  INDEX,
  outcomeOf,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
  withClusterState,
} from './harness'

const SETTLED_WRITES = 4
const ADMISSION_TIMEOUT_MS = 30_000

describe('a replica that the controller admits while a write waits in the partition queue', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('receives that write before the primary acknowledges it', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b']) await cluster.start(nodeId, { durable: false })
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    const settled = await waitUntil('the partition to hold one replica in sync', async () => {
      const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 1 ? current : null
    })
    const primary = settled.primary ?? ''
    const firstReplica = settled.inSyncSet[0] ?? ''

    const expected = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < SETTLED_WRITES; i++) {
      await cluster.node(primary).insert(INDEX, { title: `settled ${i}`, amount: i }, `settled-${i}`)
      expected.set(`settled-${i}`, { title: `settled ${i}`, amount: i })
    }

    const held = cluster.transport(primary).holdWhen(entryForDocument('queued-first'))
    const first = outcomeOf(cluster.node(primary).insert(INDEX, { title: 'queued first', amount: 10 }, 'queued-first'))
    await waitUntil('the first queued write to reach the replica link', async () => (held.count() > 0 ? true : null))
    const second = outcomeOf(
      cluster.node(primary).insert(INDEX, { title: 'queued second', amount: 20 }, 'queued-second'),
    )

    await cluster.start('node-c', { durable: false })
    await withClusterState(
      cluster,
      waitUntil(
        'node-c to join the in-sync set',
        async () => {
          const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
          return current?.inSyncSet.includes('node-c') === true ? current : null
        },
        ADMISSION_TIMEOUT_MS,
      ),
    )
    held.release()

    expect(await first).toEqual({ state: 'acknowledged' })
    expect(await second).toEqual({ state: 'acknowledged' })
    expected.set('queued-first', { title: 'queued first', amount: 10 })
    expected.set('queued-second', { title: 'queued second', amount: 20 })

    await cluster.stop(firstReplica)
    await cluster.stop(primary)
    const promoted = await withClusterState(
      cluster,
      waitUntil(
        'node-c to take over',
        async () => {
          const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
          return current?.state === 'ACTIVE' && current.primary === 'node-c' ? current : null
        },
        ADMISSION_TIMEOUT_MS,
      ),
    )

    expect(Object.fromEntries(await readCopy(cluster.probe, promoted.primary ?? ''))).toEqual(
      Object.fromEntries(expected),
    )
  }, 90_000)
})
