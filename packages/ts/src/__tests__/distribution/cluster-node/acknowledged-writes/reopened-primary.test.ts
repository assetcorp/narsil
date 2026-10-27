import { afterEach, describe, expect, it } from 'vitest'
import {
  createTestCluster,
  INDEX,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
  withClusterState,
} from './harness'

const WRITES_BEFORE_FAILOVER = 12
const WRITES_AFTER_FAILOVER = 3
const CONVERGENCE_TIMEOUT_MS = 30_000

describe('a primary that reopens an index numbers its next entry above every entry it wrote', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('keeps every copy equal when a promoted replica closes and reopens the index', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b', 'node-c']) await cluster.start(nodeId)
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    const first = await waitUntil('every data node to hold the partition in sync', async () => {
      const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 2 ? current : null
    })
    const firstPrimary = first.primary ?? ''

    const expected = new Map<string, Record<string, unknown>>()
    async function write(nodeId: string, id: string, amount: number): Promise<void> {
      await cluster.node(nodeId).insert(INDEX, { title: id, amount }, id)
      expected.set(id, { title: id, amount })
    }
    for (let i = 0; i < WRITES_BEFORE_FAILOVER; i++) await write(firstPrimary, `before-${i}`, i)

    await cluster.stop(firstPrimary)
    const promoted = await waitUntil('a replica to take over', async () => {
      const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.primary !== null && current.primary !== firstPrimary
        ? current
        : null
    })
    const secondPrimary = promoted.primary ?? ''
    for (let i = 0; i < WRITES_AFTER_FAILOVER; i++) await write(secondPrimary, `after-${i}`, 100 + i)

    await cluster.node(secondPrimary).close(INDEX)
    await cluster.node(secondPrimary).open(INDEX)
    await write(secondPrimary, 'after-reopen', 500)

    const converged = await withClusterState(
      cluster,
      waitUntil(
        'every remaining copy to hold the same documents',
        async () => {
          const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
          if (current?.state !== 'ACTIVE' || current.primary !== secondPrimary || current.inSyncSet.length !== 1) {
            return null
          }
          const replica = await readCopy(cluster.probe, current.inSyncSet[0])
          return replica.has('after-reopen') || replica.size >= expected.size ? current : null
        },
        CONVERGENCE_TIMEOUT_MS,
      ),
    )

    for (const holder of [converged.primary ?? '', ...converged.inSyncSet]) {
      expect(Object.fromEntries(await readCopy(cluster.probe, holder)), holder).toEqual(Object.fromEntries(expected))
    }
  }, 60_000)
})
