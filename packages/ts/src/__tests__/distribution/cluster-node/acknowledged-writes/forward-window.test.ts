import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { PRIMARY_CHANGE_RETRY_WINDOW_MS } from '../../../../distribution/cluster-node/constants'
import type { PartitionAssignment } from '../../../../distribution/coordinator/types'
import {
  createTestCluster,
  INDEX,
  ofType,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
} from './harness'

const SETTLED_WRITES = 5
const TERM_START_HOLD_MS = 12_000
const REPLICATION_TIMEOUT_MS = 20_000
const ANSWER_MARGIN_MS = 1_000
const REJOIN_TIMEOUT_MS = 30_000

describe('a forwarded write held across several promotions', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  })

  async function promote(running: TestCluster, primary: string): Promise<void> {
    const table = await running.coordinator.getAllocation(INDEX)
    const current = partitionAssignment(table)
    if (table === null || current === undefined) throw new Error('the ledger index has no assignment')
    const copies = [...new Set([current.primary ?? '', ...current.replicas])].filter(nodeId => nodeId !== '')
    const next: PartitionAssignment = {
      ...current,
      primary,
      replicas: copies,
      inSyncSet: copies.filter(nodeId => nodeId !== primary),
      primaryTerm: current.primaryTerm + 1,
    }
    await running.coordinator.putAllocation(INDEX, {
      ...table,
      version: table.version + 1,
      assignments: new Map([...table.assignments].map(([id, assignment]) => [id, id === 0 ? next : assignment])),
    })
  }

  it('answers within the window when three promotions each hold the write, and every copy agrees once the abandoned attempt applies', async () => {
    const running = await createTestCluster()
    cluster = running
    await running.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b', 'node-c']) {
      await running.start(nodeId, { durable: false, timeouts: { replicationTimeout: REPLICATION_TIMEOUT_MS } })
    }
    await running.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    const settled = await waitUntil('every data node to hold the partition in sync', async () => {
      const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 2 ? current : null
    })
    const expected = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < SETTLED_WRITES; i++) {
      await running.node(settled.primary ?? '').insert(INDEX, { title: `settled ${i}`, amount: i }, `settled-${i}`)
      expected.set(`settled-${i}`, { title: `settled ${i}`, amount: i })
    }

    const promotions = [settled.inSyncSet[0] ?? '', settled.inSyncSet[1] ?? '', settled.primary ?? '']
    const forwardedTo: string[] = []
    running.transport('controller').holdWhen((target, message) => {
      if (message.type === 'replication.forward') forwardedTo.push(target)
      return false
    })
    const holds = promotions.map(nodeId => running.transport(nodeId).holdWhen(ofType('replication.term_start')))

    await promote(running, promotions[0] ?? '')
    const startedAt = Date.now()
    let answeredAt = 0
    const answer = running
      .node('controller')
      .insert(INDEX, { title: 'held transfer', amount: 77 }, 'held')
      .then(
        () => ({ state: 'acknowledged' }),
        (error: unknown) => error,
      )
      .finally(() => {
        answeredAt = Date.now()
      })

    for (const [at, primary] of promotions.entries()) {
      await waitUntil(`the write to reach ${primary}`, () => forwardedTo.includes(primary), REJOIN_TIMEOUT_MS)
      const following = promotions[at + 1]
      if (following !== undefined) await promote(running, following)
      await sleep(TERM_START_HOLD_MS)
      holds[at]?.release()
    }

    expect(await answer).toMatchObject({
      code: 'REPLICATION_OUTCOME_UNKNOWN',
      details: { reason: 'forward_window_ended' },
    })
    expect(answeredAt - startedAt).toBeLessThan(PRIMARY_CHANGE_RETRY_WINDOW_MS + ANSWER_MARGIN_MS)

    expected.set('held', { title: 'held transfer', amount: 77 })
    const healed = await waitUntil(
      'every copy to hold the abandoned write',
      async () => {
        const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
        if (current?.state !== 'ACTIVE' || current.primary === null) return null
        for (const holder of [current.primary, ...current.inSyncSet]) {
          if (!(await readCopy(running.probe, holder)).has('held')) return null
        }
        return current
      },
      REJOIN_TIMEOUT_MS,
    )
    for (const holder of [healed.primary ?? '', ...healed.inSyncSet]) {
      expect(Object.fromEntries(await readCopy(running.probe, holder)), holder).toEqual(Object.fromEntries(expected))
    }
  }, 120_000)
})
