import { afterEach, describe, expect, it } from 'vitest'
import { createTestCluster, INDEX, partitionAssignment, readCopy, SCHEMA, type TestCluster, waitUntil } from './harness'

const LAPSE_OBSERVED_MS = 4_000
const REJOIN_TIMEOUT_MS = 30_000

describe('a replica whose registration lapses while its link to the primary stays up', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  })

  it('stays out of the in-sync set until it registers again, and then rejoins holding every write', async () => {
    cluster = await createTestCluster()
    const started = cluster
    await started.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b']) await started.start(nodeId, { durable: false })
    const router = started.node('controller')
    await router.createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    const settled = await waitUntil('the replica to join the in-sync set', async () => {
      const current = partitionAssignment(await started.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 1 ? current : null
    })
    const replica = settled.inSyncSet[0] ?? ''

    const ledger = new Map<string, Record<string, unknown>>()
    const write = async (label: string, amount: number) => {
      const fields = { title: `transfer ${label}`, amount }
      await router.insert(INDEX, fields, label)
      ledger.set(label, fields)
    }
    for (let i = 0; i < 4; i++) await write(`before-${i}`, i)

    const allowRegistration = started.coordinator.refuseRegistrationOf(replica)
    await started.coordinator.deregisterNode(replica)
    await waitUntil('the controller to drop the unregistered replica from the in-sync set', async () => {
      const current = partitionAssignment(await started.coordinator.getAllocation(INDEX))
      return current?.inSyncSet.includes(replica) === false && current.replicas.includes(replica) ? current : null
    })

    const admittedWhileUnregistered: number[] = []
    let registered = false
    const stopWatching = await started.coordinator.watchAllocation(({ indexName, table }) => {
      if (indexName === INDEX && !registered && partitionAssignment(table)?.inSyncSet.includes(replica)) {
        admittedWhileUnregistered.push(table.version)
      }
    })
    for (let i = 0; i < 4; i++) await write(`during-${i}`, 10 + i)
    await new Promise(resolve => setTimeout(resolve, LAPSE_OBSERVED_MS))
    expect(admittedWhileUnregistered).toEqual([])

    allowRegistration()
    await waitUntil('the replica to register again', async () =>
      (await started.coordinator.listNodes()).some(node => node.nodeId === replica) ? true : null,
    )
    registered = true
    stopWatching()
    await waitUntil(
      'the replica to rejoin the in-sync set',
      async () => {
        const current = partitionAssignment(await started.coordinator.getAllocation(INDEX))
        return current?.inSyncSet.includes(replica) ? current : null
      },
      REJOIN_TIMEOUT_MS,
    )
    expect(Object.fromEntries(await readCopy(started.probe, replica))).toEqual(Object.fromEntries(ledger))
  }, 90_000)
})
