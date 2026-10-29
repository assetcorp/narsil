import { afterEach, describe, expect, it } from 'vitest'
import {
  createTestCluster,
  type HeldMessages,
  INDEX,
  ofType,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
} from './harness'

const ROUTER = 'router'
const DATA_NODES = ['node-a', 'node-b']
const SETTLE_TIMEOUT_MS = 30_000

describe('a partition whose primary fails before the partition first serves', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  })

  it('starts again empty on another node under a higher term, and then keeps every write', async () => {
    cluster = await createTestCluster()
    const started = cluster
    await started.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
    const holds = new Map<string, HeldMessages>()
    for (const nodeId of DATA_NODES) {
      await started.start(nodeId, { durable: false })
      holds.set(nodeId, started.transport(nodeId).holdWhen(ofType('cluster.bootstrap_complete')))
    }
    const router = started.node(ROUTER)
    await router.createIndex(
      INDEX,
      { schema: SCHEMA },
      { partitionCount: 1, replicationFactor: 1, waitForServingMs: 0 },
    )

    const stalled = await waitUntil('the primary to stall before it reports its partition ready', async () => {
      const current = partitionAssignment(await started.coordinator.getAllocation(INDEX))
      if (current?.state !== 'INITIALISING' || current.primary === null) return null
      return (holds.get(current.primary)?.count() ?? 0) > 0 ? current : null
    })
    const failed = stalled.primary ?? ''
    await started.stop(failed)
    for (const [nodeId, held] of holds) if (nodeId !== failed) held.release()

    const restarted = await waitUntil(
      'another node to lead the partition',
      async () => {
        const current = partitionAssignment(await started.coordinator.getAllocation(INDEX))
        return current?.state === 'ACTIVE' && current.primary !== null && current.primary !== failed ? current : null
      },
      SETTLE_TIMEOUT_MS,
    )
    expect(restarted.primaryTerm).toBeGreaterThan(stalled.primaryTerm)
    expect(restarted.lastHolders).toBeUndefined()

    const documents = Array.from({ length: 6 }, (_, i) => ({ id: `entry-${i}`, title: `entry ${i}`, amount: i }))
    expect((await router.insertBatch(INDEX, documents)).failed).toEqual([])
    const expected = Object.fromEntries(documents.map(({ id, ...fields }) => [id, fields]))
    expect(Object.fromEntries(await readCopy(started.probe, restarted.primary ?? ''))).toEqual(expected)
    expect(await router.countDocuments(INDEX)).toBe(documents.length)
  }, 90_000)
})
