import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { type SingleNodeCluster, startSingleNodeCluster, waitForActiveAllocation } from './cluster-harness'

const CHURN_INTERVAL_MS = 200
const PLACED_WITHIN_MS = 4_000
const POLL_MS = 25
const TEST_TIMEOUT_MS = 30_000
const INDEX = 'orders'
const NEW_DATA_NODE = 'node-b'

let cluster: SingleNodeCluster | null = null
let churning = false

afterEach(async () => {
  churning = false
  await cluster?.shutdown()
  cluster = null
})

function registrationOf(nodeId: string, roles: Array<'data' | 'coordinator'>) {
  return {
    nodeId,
    address: `${nodeId}:9200`,
    roles,
    capacity: { memoryBytes: 1_000_000_000, cpuCores: 1, diskBytes: null },
    startedAt: new Date().toISOString(),
    version: '1.4',
  }
}

async function registerCoordinatorsUntilStopped(active: SingleNodeCluster): Promise<void> {
  let joined = 0
  while (churning) {
    joined += 1
    await active.coordinator.registerNode(registrationOf(`gateway-${joined}`, ['coordinator']))
    await sleep(CHURN_INTERVAL_MS)
  }
}

async function replicaPlacedWithin(active: SingleNodeCluster, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const table = await active.coordinator.getAllocation(INDEX)
    if (table !== null && [...table.assignments.values()].every(a => a.replicas.includes(NEW_DATA_NODE))) {
      return true
    }
    await sleep(POLL_MS)
  }
  return false
}

describe('a controller whose cluster registers nodes steadily', () => {
  it(
    'places replicas on a new data node while coordinator nodes join every 200 ms',
    async () => {
      const active = await startSingleNodeCluster()
      cluster = active
      await active.node.createIndex(
        INDEX,
        { schema: { customer: 'string' } },
        { partitionCount: 2, replicationFactor: 1 },
      )
      const before = await waitForActiveAllocation(active.coordinator, INDEX)
      for (const assignment of before.assignments.values()) expect(assignment.replicas).toEqual([])

      churning = true
      const churn = registerCoordinatorsUntilStopped(active)
      await sleep(CHURN_INTERVAL_MS / 2)
      await active.coordinator.registerNode(registrationOf(NEW_DATA_NODE, ['data']))

      const placed = await replicaPlacedWithin(active, PLACED_WITHIN_MS)
      churning = false
      await churn
      expect(placed).toBe(true)
    },
    TEST_TIMEOUT_MS,
  )
})
