import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import type { NodeTransport } from '../../../../distribution/transport/types'
import { NarsilError } from '../../../../errors'
import {
  createTestCluster,
  INDEX,
  ofType,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitForCopies,
  waitUntil,
} from './harness'

const EVERY_REPORT_FAILED_WITHIN_MS = 70_000
const ACTIVE_AFTER_CONTROLLER_RETURNS_MS = 10_000
const RELEASED_AFTER_MOVE_MS = 10_000

async function heldPartitionIds(probe: NodeTransport, nodeId: string): Promise<unknown> {
  const response = await probe.send(nodeId, {
    type: 'cluster.partition_stores',
    sourceId: 'copy-reader',
    requestId: `held-partitions-${nodeId}-${Date.now()}-${Math.random()}`,
    payload: encode({ indexName: INDEX }),
  })
  return (decode(response.payload) as { partitionIds?: unknown }).partitionIds
}

async function startPrimaryWhoseReportsFail(cluster: TestCluster): Promise<() => void> {
  await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
  const failures: NarsilError[] = []
  await cluster.start('node-a', {
    durable: false,
    onError: error => {
      if (error instanceof NarsilError && error.code === 'NODE_BOOTSTRAP_FAILED') failures.push(error)
    },
  })
  const restoreReports = cluster.transport('node-a').dropWhen(ofType('cluster.bootstrap_complete'))
  await cluster
    .node('controller')
    .createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0, waitForServingMs: 0 })
  await waitUntil(
    'node-a to report that its last bootstrap completion report failed',
    () => failures.length > 0,
    EVERY_REPORT_FAILED_WITHIN_MS,
  )
  expect(cluster.transport('node-a').dropped().length).toBeGreaterThan(1)
  expect(partitionAssignment(await cluster.coordinator.getAllocation(INDEX))).toMatchObject({
    primary: 'node-a',
    state: 'INITIALISING',
  })
  return restoreReports
}

describe('a primary whose every bootstrap completion report fails', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('bootstraps the partition again once the controller answers, and then takes writes', async () => {
    cluster = await createTestCluster()
    const restoreReports = await startPrimaryWhoseReportsFail(cluster)

    restoreReports()

    await waitForCopies(cluster.coordinator, 'node-a', [], ACTIVE_AFTER_CONTROLLER_RETURNS_MS)
    await cluster.node('node-a').insert(INDEX, { title: 'deposit', amount: 40 }, 'account-1')
    expect(Object.fromEntries(await readCopy(cluster.probe, 'node-a'))).toEqual({
      'account-1': { title: 'deposit', amount: 40 },
    })
  }, 120_000)

  it('releases the copy that it prepared once the cluster gives the partition to another node', async () => {
    cluster = await createTestCluster()
    await startPrimaryWhoseReportsFail(cluster)
    expect(await heldPartitionIds(cluster.probe, 'node-a')).toEqual([0])

    await cluster.stop('controller')
    const table = await cluster.coordinator.getAllocation(INDEX)
    const assignment = partitionAssignment(table)
    if (table === null || assignment === undefined) throw new Error(`${INDEX} lost its allocation`)
    await cluster.coordinator.putAllocation(INDEX, {
      ...table,
      version: table.version + 1,
      assignments: new Map([
        [0, { ...assignment, primary: 'node-b', primaryTerm: assignment.primaryTerm + 1, replicas: [], inSyncSet: [] }],
      ]),
    })

    await waitUntil(
      'node-a to release the copy that the partition no longer uses',
      async () => {
        const held = await heldPartitionIds(cluster.probe, 'node-a')
        return Array.isArray(held) && held.length === 0
      },
      RELEASED_AFTER_MOVE_MS,
    )
  }, 120_000)
})
