import { afterEach, describe, expect, it } from 'vitest'
import type { AllocationTable, PartitionAssignment } from '../../../../distribution/coordinator/types'
import { ErrorCodes } from '../../../../errors'
import {
  createTestCluster,
  INDEX,
  ofType,
  outcomeOf,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
} from './harness'

const REPLICATION_TIMEOUT_MS = 2_000
const REJOIN_TIMEOUT_MS = 30_000
const SETTLED_WRITES = 3
const DATA_NODES = ['node-a', 'node-b', 'node-c']

type Ledger = Map<string, Record<string, unknown>>

function fields(label: string, amount: number): Record<string, unknown> {
  return { title: `transfer ${label}`, amount }
}

describe('a new primary whose term start one copy never answers', () => {
  let cluster: TestCluster | undefined
  const unwatchers: Array<() => void> = []

  afterEach(async () => {
    for (const unwatch of unwatchers.splice(0)) unwatch()
    await cluster?.dispose()
    cluster = undefined
  })

  async function startLedger(): Promise<{ running: TestCluster; settled: PartitionAssignment; ledger: Ledger }> {
    const running = await createTestCluster()
    cluster = running
    const timeouts = { replicationTimeout: REPLICATION_TIMEOUT_MS }
    await running.start('controller', { roles: ['controller', 'coordinator'], durable: false, timeouts })
    for (const nodeId of DATA_NODES) await running.start(nodeId, { durable: false, timeouts })
    await running.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    const settled = await waitUntil('every data node to hold the partition in sync', async () => {
      const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 2 ? current : null
    })
    const ledger: Ledger = new Map()
    for (let i = 0; i < SETTLED_WRITES; i++) {
      await running.node(settled.primary ?? '').insert(INDEX, fields(`settled ${i}`, i), `settled-${i}`)
      ledger.set(`settled-${i}`, fields(`settled ${i}`, i))
    }
    return { running, settled, ledger }
  }

  async function leavingTimeOf(running: TestCluster, nodeId: string): Promise<() => number | null> {
    let leftAt: number | null = null
    const note = (table: AllocationTable | null) => {
      const current = partitionAssignment(table)
      if (leftAt === null && current !== undefined && current.primary !== nodeId && !current.inSyncSet.includes(nodeId))
        leftAt = Date.now()
    }
    unwatchers.push(
      await running.coordinator.watchAllocation(event => {
        if (event.indexName === INDEX) note(event.table)
      }),
    )
    note(await running.coordinator.getAllocation(INDEX))
    return () => leftAt
  }

  it('refuses every write while the controller cannot remove that copy, and writes again once the copy leaves the in-sync set', async () => {
    const { running, settled, ledger } = await startLedger()
    const oldPrimary = settled.primary ?? ''
    const candidate = [...settled.inSyncSet].sort()[0] ?? ''
    const silent = settled.inSyncSet.find(nodeId => nodeId !== candidate) ?? ''
    running.transport(silent).ignoreWhen(ofType('replication.term_start'))
    const restoreRemovals = running.transport(candidate).dropWhen(ofType('replication.insync_remove'))
    const silentLeftAt = await leavingTimeOf(running, silent)

    running.transport(oldPrimary).dropWhen(() => true)
    await running.stop(oldPrimary)
    await waitUntil(
      'the controller to promote the candidate',
      async () => {
        const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
        return current?.state === 'ACTIVE' && current.primary === candidate ? current : null
      },
      REJOIN_TIMEOUT_MS,
    )

    const duringOutage = await outcomeOf(
      running.node('controller').insert(INDEX, fields('during the outage', 31), 'during-outage'),
    )
    expect(duringOutage).toEqual({ state: 'refused', code: ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED })
    expect(partitionAssignment(await running.coordinator.getAllocation(INDEX))?.inSyncSet).toContain(silent)
    for (const holder of [candidate, silent]) {
      expect((await readCopy(running.probe, holder)).has('during-outage'), holder).toBe(false)
    }

    restoreRemovals()
    await running.node('controller').insert(INDEX, fields('after the outage', 32), 'after-outage')
    const acknowledgedAt = Date.now()
    ledger.set('after-outage', fields('after the outage', 32))
    const leftAt = silentLeftAt()
    expect(leftAt).not.toBeNull()
    expect(leftAt ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(acknowledgedAt)

    const expected = Object.fromEntries(ledger)
    const rejoined = await waitUntil(
      'the silent copy to resync and rejoin the in-sync set',
      async () => {
        const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
        if (current?.primary !== candidate || !current.inSyncSet.includes(silent)) return null
        return (await readCopy(running.probe, silent)).size === ledger.size ? current : null
      },
      REJOIN_TIMEOUT_MS,
    )
    for (const holder of [rejoined.primary ?? '', ...rejoined.inSyncSet]) {
      expect(Object.fromEntries(await readCopy(running.probe, holder)), holder).toEqual(expected)
    }
  }, 120_000)
})
