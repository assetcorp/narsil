import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { CATCH_UP_TICK_MS } from '../../../../distribution/cluster-node/constants'
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

const SHUTDOWN_WINDOW_MS = 3_000
const REPLICATION_TIMEOUT_MS = 200

describe('settling an admitted replica behind a partition write', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

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
