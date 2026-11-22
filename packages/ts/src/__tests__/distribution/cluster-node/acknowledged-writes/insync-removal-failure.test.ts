import { afterEach, describe, expect, it } from 'vitest'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import { ErrorCodes, NarsilError } from '../../../../errors'
import {
  createTestCluster,
  entryForDocument,
  INDEX,
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
const OPENING_BALANCE = { title: 'opening balance', amount: 0 }

interface FailingLookups {
  coordinator: ClusterCoordinator
  failNext(): void
}

function failingLeaseLookups(inner: ClusterCoordinator): FailingLookups {
  let failures = 0
  const coordinator = new Proxy(inner, {
    get(target, property, receiver) {
      if (property !== 'getLeaseHolder') return Reflect.get(target, property, receiver)
      return async (key: string) => {
        if (failures > 0) {
          failures -= 1
          throw new NarsilError(ErrorCodes.COORDINATOR_UNAVAILABLE, 'the coordinator lost its quorum')
        }
        return target.getLeaseHolder(key)
      }
    },
  })
  return {
    coordinator,
    failNext() {
      failures += 1
    },
  }
}

describe('a primary that cannot remove a failed replica from the in-sync set', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  })

  async function settledPair(lookups: Map<string, FailingLookups>) {
    const running = await createTestCluster()
    cluster = running
    const timeouts = { replicationTimeout: REPLICATION_TIMEOUT_MS }
    await running.start('controller', { roles: ['controller', 'coordinator'], durable: false, timeouts })
    for (const nodeId of DATA_NODES) {
      const gate = failingLeaseLookups(running.coordinator)
      lookups.set(nodeId, gate)
      await running.start(nodeId, { durable: false, timeouts, coordinator: gate.coordinator })
    }
    await running.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    const settled = await waitUntil('both data nodes to hold the partition in sync', async () => {
      const current = partitionAssignment(await running.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 1 ? current : null
    })
    const primary = settled.primary ?? ''
    const replica = settled.inSyncSet[0] ?? ''
    await running.node(primary).insert(INDEX, OPENING_BALANCE, 'account-1')
    await waitForCopies(running.coordinator, primary, [replica])
    return { running, primary, replica }
  }

  async function expectOnlyTheOpeningBalance(running: TestCluster, primary: string, replica: string) {
    expect(partitionAssignment(await running.coordinator.getAllocation(INDEX))?.inSyncSet).toContain(replica)
    for (const holder of [primary, replica]) {
      expect(Object.fromEntries(await readCopy(running.probe, holder)), holder).toEqual({
        'account-1': OPENING_BALANCE,
      })
    }
  }

  it('refuses the write as a failed removal when the removal request never reaches the controller', async () => {
    const { running, primary, replica } = await settledPair(new Map())
    const transport = running.transport(primary)
    transport.loseReplyWhen(onceFor(entryForDocument('account-9')))
    transport.dropWhen(onceFor(ofType('replication.insync_remove')))

    const outcome = await outcomeOf(running.node(primary).insert(INDEX, { title: 'refused', amount: 9 }, 'account-9'))

    expect(outcome).toEqual({ state: 'refused', code: ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED })
    await expectOnlyTheOpeningBalance(running, primary, replica)
  }, 30_000)

  it('refuses the write as a failed removal when the primary cannot look up the controller', async () => {
    const lookups = new Map<string, FailingLookups>()
    const { running, primary, replica } = await settledPair(lookups)
    running.transport(primary).dropWhen(onceFor(entryForDocument('account-9')))
    lookups.get(primary)?.failNext()

    const outcome = await outcomeOf(running.node(primary).insert(INDEX, { title: 'refused', amount: 9 }, 'account-9'))

    expect(outcome).toEqual({ state: 'refused', code: ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED })
    await expectOnlyTheOpeningBalance(running, primary, replica)
  }, 30_000)
})
