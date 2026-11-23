import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { type SingleNodeCluster, startSingleNodeCluster, waitForActiveAllocation } from './cluster-harness'

const CHURN_INTERVAL_MS = 100
const ACTIVE_WITHIN_MS = 5_000
const POLL_MS = 25
const TEST_TIMEOUT_MS = 30_000

let cluster: SingleNodeCluster | null = null
let churning = false

afterEach(async () => {
  churning = false
  await cluster?.shutdown()
  cluster = null
})

async function rewriteTableUntilStopped(active: SingleNodeCluster, indexName: string): Promise<void> {
  while (churning) {
    const table = await active.coordinator.getAllocation(indexName)
    if (table !== null) {
      await active.coordinator.putAllocation(indexName, { ...table, version: table.version + 1 })
    }
    await sleep(CHURN_INTERVAL_MS)
  }
}

async function activeWithin(active: SingleNodeCluster, indexName: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const table = await active.coordinator.getAllocation(indexName)
    if (
      table !== null &&
      table.assignments.size > 0 &&
      [...table.assignments.values()].every(assignment => assignment.state === 'ACTIVE')
    ) {
      return true
    }
    await sleep(POLL_MS)
  }
  return false
}

describe('a data node whose allocation tables change steadily', () => {
  it(
    'bootstraps a new index while another index rewrites its table every 100 ms',
    async () => {
      const active = await startSingleNodeCluster()
      cluster = active
      await active.node.createIndex('audit-log', { schema: { message: 'string' } })
      await waitForActiveAllocation(active.coordinator, 'audit-log')

      churning = true
      const churn = rewriteTableUntilStopped(active, 'audit-log')

      const creation = active.node.createIndex('orders', { schema: { customer: 'string' } }).then(
        () => 'created',
        (error: unknown) => error,
      )
      const ordersActive = await activeWithin(active, 'orders', ACTIVE_WITHIN_MS)
      expect(ordersActive).toBe(true)
      expect(await creation).toBe('created')

      await active.node.insert('orders', { customer: 'Northwind' }, 'order-1')
      const stored = await active.node.get('orders', 'order-1')
      expect(stored).toEqual({ customer: 'Northwind' })

      churning = false
      await churn
    },
    TEST_TIMEOUT_MS,
  )
})
