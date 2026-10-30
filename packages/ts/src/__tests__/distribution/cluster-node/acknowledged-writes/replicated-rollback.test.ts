import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import {
  createTestCluster,
  entryForDocument,
  INDEX,
  type Outcome,
  ofType,
  onceFor,
  outcomeOf,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitForCopies,
  waitUntil,
} from './harness'

const REPLICATION_TIMEOUT_MS = 1_000
const DATA_NODES = ['node-a', 'node-b']

interface StalledLookups {
  coordinator: ClusterCoordinator
  stall(): () => void
}

function stallingLeaseLookups(inner: ClusterCoordinator): StalledLookups {
  let stalled = false
  const waiting: (() => void)[] = []
  const coordinator = new Proxy(inner, {
    get(target, property, receiver) {
      if (property !== 'getLeaseHolder') return Reflect.get(target, property, receiver)
      return (key: string) =>
        stalled
          ? new Promise<string | null>(resolve => waiting.push(() => resolve(target.getLeaseHolder(key))))
          : target.getLeaseHolder(key)
    },
  })
  return {
    coordinator,
    stall() {
      stalled = true
      return () => {
        stalled = false
        for (const release of waiting.splice(0)) release()
      }
    },
  }
}

async function settledPair(cluster: TestCluster): Promise<{ primary: string; replica: string }> {
  await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
  const table = await waitUntil('both data nodes to hold the partition in sync', async () => {
    const current = await cluster.coordinator.getAllocation(INDEX)
    const assignment = partitionAssignment(current)
    return assignment?.state === 'ACTIVE' && assignment.inSyncSet.length === 1 ? current : null
  })
  const assignment = partitionAssignment(table)
  const primary = assignment?.primary ?? ''
  const replica = assignment?.inSyncSet[0] ?? ''
  await cluster.node(primary).insert(INDEX, { title: 'opening balance', amount: 0 }, 'account-1')
  await waitForCopies(cluster.coordinator, primary, [replica])
  return { primary, replica }
}

async function expectInSyncCopiesToMatch(cluster: TestCluster, primary: string): Promise<Map<string, unknown>> {
  const assignment = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
  const primaryCopy = await readCopy(cluster.probe, primary)
  for (const replica of assignment?.inSyncSet ?? []) {
    expect(Object.fromEntries(await readCopy(cluster.probe, replica)), replica).toEqual(Object.fromEntries(primaryCopy))
  }
  return primaryCopy
}

function within(outcome: Promise<Outcome>, timeoutMs: number): Promise<Outcome | 'still waiting'> {
  return Promise.race([outcome, sleep(timeoutMs).then(() => 'still waiting' as const)])
}

describe('a write that fails after the primary applied it', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  async function startCluster(coordinators?: Map<string, StalledLookups>): Promise<void> {
    cluster = await createTestCluster()
    const timeouts = { replicationTimeout: REPLICATION_TIMEOUT_MS }
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false, timeouts })
    for (const nodeId of DATA_NODES) {
      const lookups = stallingLeaseLookups(cluster.coordinator)
      coordinators?.set(nodeId, lookups)
      await cluster.start(nodeId, { durable: false, timeouts, coordinator: lookups.coordinator })
    }
  }

  it('drops a refused insert from a replica whose acknowledgement was lost', async () => {
    await startCluster()
    const { primary, replica } = await settledPair(cluster)
    const transport = cluster.transport(primary)
    transport.loseReplyWhen(onceFor(entryForDocument('account-9')))
    transport.dropWhen(onceFor(ofType('replication.insync_remove')))

    const outcome = await outcomeOf(cluster.node(primary).insert(INDEX, { title: 'refused', amount: 9 }, 'account-9'))

    expect(outcome.state).toBe('refused')
    expect(outcome).not.toEqual({ state: 'refused', code: 'REPLICATION_OUTCOME_UNKNOWN' })
    expect(partitionAssignment(await cluster.coordinator.getAllocation(INDEX))?.inSyncSet).toContain(replica)
    const held = await expectInSyncCopiesToMatch(cluster, primary)
    expect(held.has('account-9')).toBe(false)
  }, 30_000)

  it('answers outcome unknown while the controller and the replica are cut off, and holds the partition', async () => {
    await startCluster()
    const { primary, replica } = await settledPair(cluster)
    const transport = cluster.transport(primary)
    let entriesToReplica = 0
    transport.loseReplyWhen(onceFor(entryForDocument('account-9')))
    const reconnectReplica = transport.dropWhen(
      (target, message) => target === replica && message.type.startsWith('replication.entry') && entriesToReplica++ > 0,
    )
    const reconnectController = transport.dropWhen(target => target === 'controller')

    const refused = outcomeOf(cluster.node(primary).insert(INDEX, { title: 'in doubt', amount: 9 }, 'account-9'))
    await sleep(50)
    const queued = outcomeOf(cluster.node(primary).insert(INDEX, { title: 'queued', amount: 10 }, 'account-10'))

    expect(await within(refused, 5 * REPLICATION_TIMEOUT_MS)).toEqual({
      state: 'refused',
      code: 'REPLICATION_OUTCOME_UNKNOWN',
    })
    expect(await within(queued, 2 * REPLICATION_TIMEOUT_MS)).toBe('still waiting')
    expect((await readCopy(cluster.probe, primary)).has('account-10')).toBe(false)

    reconnectReplica()
    reconnectController()
    expect(await within(queued, 10 * REPLICATION_TIMEOUT_MS)).toEqual({ state: 'acknowledged' })
    expect(partitionAssignment(await cluster.coordinator.getAllocation(INDEX))?.inSyncSet).toContain(replica)
    const held = await expectInSyncCopiesToMatch(cluster, primary)
    expect(held.has('account-9')).toBe(false)
    expect(held.get('account-10')).toEqual({ title: 'queued', amount: 10 })
  }, 60_000)

  it('ends the write when the controller lookup never answers, and keeps the partition writable', async () => {
    const coordinators = new Map<string, StalledLookups>()
    await startCluster(coordinators)
    const { primary, replica } = await settledPair(cluster)
    cluster.transport(primary).dropWhen(onceFor(entryForDocument('account-9')))
    const resume = coordinators.get(primary)?.stall()

    try {
      const outcome = await within(
        outcomeOf(cluster.node(primary).insert(INDEX, { title: 'stalled', amount: 9 }, 'account-9')),
        5 * REPLICATION_TIMEOUT_MS,
      )
      expect(outcome).toEqual({ state: 'refused', code: 'REPLICATION_INSYNC_REMOVAL_FAILED' })
      const next = await within(
        outcomeOf(cluster.node(primary).insert(INDEX, { title: 'after the stall', amount: 11 }, 'account-11')),
        5 * REPLICATION_TIMEOUT_MS,
      )
      expect(next).toEqual({ state: 'acknowledged' })
    } finally {
      resume?.()
    }

    expect(partitionAssignment(await cluster.coordinator.getAllocation(INDEX))?.inSyncSet).toContain(replica)
    const held = await expectInSyncCopiesToMatch(cluster, primary)
    expect(held.has('account-9')).toBe(false)
    expect(held.get('account-11')).toEqual({ title: 'after the stall', amount: 11 })
  }, 30_000)
})
