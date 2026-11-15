import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { CATCH_UP_TICK_MS } from '../../../../distribution/cluster-node/constants'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import {
  createTestCluster,
  entryForDocument,
  INDEX,
  ofType,
  outcomeOf,
  partitionAssignment,
  SCHEMA,
  type TestCluster,
  waitUntil,
} from './harness'

const IDLE_WINDOW_MS = 6_000
const SHUTDOWN_WINDOW_MS = 3_000
const REPLICATION_TIMEOUT_MS = 200

function countAllocationReads(inner: ClusterCoordinator) {
  let reads = 0
  const coordinator = new Proxy(inner, {
    get(target, property, receiver) {
      if (property !== 'getAllocation') return Reflect.get(target, property, receiver)
      return (indexName: string) => {
        reads += 1
        return target.getAllocation(indexName)
      }
    },
  })
  return { coordinator, count: () => reads }
}

describe('settling an admitted replica behind a partition write', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('reads the live allocation once after admission during six idle seconds', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    const reads = new Map<string, ReturnType<typeof countAllocationReads>>()
    for (const nodeId of ['node-a', 'node-b']) {
      const counted = countAllocationReads(cluster.coordinator)
      reads.set(nodeId, counted)
      await cluster.start(nodeId, { coordinator: counted.coordinator, durable: false })
    }
    const admission = cluster.transport('controller').holdReplyWhen(ofType('replication.insync_add'))
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    const assignment = await waitUntil('the replica to join the in-sync set', async () => {
      const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 1 ? current : null
    })
    const counted = reads.get(assignment.primary ?? '')
    if (counted === undefined) throw new Error('The primary has no allocation read counter')
    await waitUntil('the controller to hold the admission reply', () => admission.count() > 0)
    await sleep(CATCH_UP_TICK_MS * 2)
    const before = counted.count()
    admission.release()
    await sleep(IDLE_WINDOW_MS)
    expect(counted.count() - before).toBe(1)
  }, 30_000)

  it('shuts down while a queued admission settlement waits for a rollback hold', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b']) {
      await cluster.start(nodeId, { durable: false, timeouts: { replicationTimeout: REPLICATION_TIMEOUT_MS } })
    }
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    const assignment = await waitUntil('the first replica to join the in-sync set', async () => {
      const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 1 ? current : null
    })
    const primary = assignment.primary ?? ''
    const replica = assignment.inSyncSet[0] ?? ''
    await cluster.node(primary).insert(INDEX, { title: 'opening balance', amount: 0 }, 'opening')
    const transport = cluster.transport(primary)
    const admission = transport.holdWhen(ofType('replication.insync_add', 'controller'))
    await cluster.start('node-c', { durable: false })
    await waitUntil('the primary to propose node-c', () => admission.count() > 0)
    const write = transport.holdWhen(entryForDocument('blocked'))
    const writing = outcomeOf(cluster.node(primary).insert(INDEX, { title: 'held deposit', amount: 1 }, 'blocked'))
    await waitUntil('the write to start replicating', () => write.count() > 0)
    admission.release()
    await waitUntil('node-c to join the in-sync set', async () => {
      return partitionAssignment(await cluster.coordinator.getAllocation(INDEX))?.inSyncSet.includes('node-c')
    })
    await sleep(CATCH_UP_TICK_MS * 2)
    const restoreEntries = transport.dropWhen(
      (target, message) =>
        target === replica && ['replication.entry', 'replication.entry_batch'].includes(message.type),
    )
    const restoreRemovals = transport.dropWhen(ofType('replication.insync_remove'))
    write.release()
    expect(await writing).toEqual({ state: 'refused', code: 'REPLICATION_OUTCOME_UNKNOWN' })
    let stopped = false
    const shutdown = cluster.stop(primary).then(() => {
      stopped = true
    })
    try {
      await waitUntil('shutdown to release the rollback hold', () => stopped, SHUTDOWN_WINDOW_MS)
    } finally {
      restoreEntries()
      restoreRemovals()
      await shutdown
    }
  }, 30_000)
})
