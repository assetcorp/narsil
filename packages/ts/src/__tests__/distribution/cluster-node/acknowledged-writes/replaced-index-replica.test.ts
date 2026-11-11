import { afterEach, describe, expect, it } from 'vitest'
import type {
  AllocationEvent,
  AllocationTable,
  ClusterCoordinator,
  SchemaEvent,
} from '../../../../distribution/coordinator/types'
import { createTestCluster, INDEX, partitionAssignment, readCopy, SCHEMA, type TestCluster, waitUntil } from './harness'

const OLD_WRITES = 40
const NEW_WRITES = 2 * OLD_WRITES
const NEW_WRITE_BATCH = 10
const OUT_OF_SYNC_WRITES = 5
const REPLICA_RESYNC_TIMEOUT_MS = 60_000

interface SeverableCoordinator {
  coordinator: ClusterCoordinator
  sever(): void
  restoreReads(): void
  restoreWatches(indexName: string): Promise<void>
}

function severable(inner: ClusterCoordinator): SeverableCoordinator {
  let readsDown = false
  let watchesDown = false
  const allocationHandlers = new Set<(event: AllocationEvent) => void>()
  const schemaHandlers = new Set<(event: SchemaEvent) => void>()
  const coordinator = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'getAllocation') {
        return async (indexName: string) => {
          if (readsDown) throw new Error('the coordinator is unreachable, so getAllocation failed')
          return target.getAllocation(indexName)
        }
      }
      if (property === 'watchAllocation') {
        return async (handler: (event: AllocationEvent) => void) => {
          allocationHandlers.add(handler)
          const unwatch = await target.watchAllocation(event => {
            if (!watchesDown) handler(event)
          })
          return () => {
            allocationHandlers.delete(handler)
            unwatch()
          }
        }
      }
      if (property === 'watchSchemas') {
        return async (handler: (event: SchemaEvent) => void) => {
          schemaHandlers.add(handler)
          const unwatch = await target.watchSchemas(event => {
            if (!watchesDown) handler(event)
          })
          return () => {
            schemaHandlers.delete(handler)
            unwatch()
          }
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return {
    coordinator,
    sever() {
      readsDown = true
      watchesDown = true
    },
    restoreReads() {
      readsDown = false
    },
    async restoreWatches(indexName) {
      watchesDown = false
      const table = await inner.getAllocation(indexName)
      if (table !== null) for (const handler of allocationHandlers) handler({ indexName, table })
      const schema = await inner.getSchema(indexName)
      if (schema !== null) {
        for (const handler of schemaHandlers) handler({ type: 'schema_created', indexName, schema })
      }
    },
  }
}

function writesNumbered(prefix: string, count: number): Array<{ id: string; title: string; amount: number }> {
  return Array.from({ length: count }, (_, at) => ({
    id: `${prefix}-${at}`,
    title: `${prefix} deposit ${at}`,
    amount: at,
  }))
}

async function expectCopiesToHold(
  cluster: TestCluster,
  table: AllocationTable,
  expected: Map<string, Record<string, unknown>>,
): Promise<void> {
  const assignment = partitionAssignment(table)
  if (assignment === undefined || assignment.primary === null) throw new Error(`${INDEX} has no primary`)
  for (const holder of [assignment.primary, ...assignment.inSyncSet]) {
    const copy = await readCopy(cluster.probe, holder)
    expect(Object.fromEntries(copy), `${holder} holds partition 0`).toEqual(Object.fromEntries(expected))
  }
}

describe('a replica that misses a drop and a create while it is out of the in-sync set', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('holds every write of the new index once it rejoins the in-sync set', async () => {
    cluster = await createTestCluster()
    const severed = new Map<string, SeverableCoordinator>()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b']) {
      const cut = severable(cluster.coordinator)
      severed.set(nodeId, cut)
      await cluster.start(nodeId, { coordinator: cut.coordinator })
    }
    const indexConfig = { schema: SCHEMA }
    const layout = { partitionCount: 1, replicationFactor: 1 }
    await cluster.node('controller').createIndex(INDEX, indexConfig, layout)
    const settled = await waitUntil('the partition to hold two copies in sync', async () => {
      const assignment = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return assignment?.state === 'ACTIVE' && assignment.inSyncSet.length === 1 ? assignment : null
    })
    const primary = settled.primary ?? ''
    const replica = settled.inSyncSet[0] ?? ''
    const replicaCoordinator = severed.get(replica)
    if (replicaCoordinator === undefined) throw new Error(`${replica} has no severable coordinator`)

    const old = await cluster.node(primary).insertBatch(INDEX, writesNumbered('old', OLD_WRITES))
    expect(old.failed).toEqual([])

    const unreachableReplica = cluster.transport(primary).dropWhen(target => target === replica)
    const refusedSyncs = cluster
      .transport(replica)
      .dropWhen((target, message) => target === primary && message.type === 'replication.sync_request')
    const stranded = await cluster.node(primary).insertBatch(INDEX, writesNumbered('stranded', OUT_OF_SYNC_WRITES))
    expect(stranded.failed).toEqual([])
    await waitUntil(`${replica} to leave the in-sync set and fail to sync`, async () => {
      const assignment = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      const refused = cluster
        .transport(replica)
        .dropped()
        .some(message => message.type === 'replication.sync_request')
      return assignment !== undefined && !assignment.inSyncSet.includes(replica) && refused
    })

    replicaCoordinator.sever()
    unreachableReplica()
    refusedSyncs()

    const dropped = await cluster
      .node(primary)
      .dropIndex(INDEX)
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(dropped).toMatchObject({ code: 'QUERY_NODE_TIMEOUT', details: { pendingNodeIds: [replica] } })

    const creating = cluster
      .node(primary)
      .createIndex(INDEX, indexConfig, layout)
      .then(
        () => null,
        (error: unknown) => error,
      )
    const created = await waitUntil('the new index to take its partition', async () => {
      const assignment = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return assignment?.primary === null ? null : assignment
    })
    expect(created.primary).toBe(primary)
    expect(created.replicas).toEqual([replica])

    const expected = new Map<string, Record<string, unknown>>()
    for (let start = 0; start < NEW_WRITES; start += NEW_WRITE_BATCH) {
      const batch = writesNumbered('new', NEW_WRITES).slice(start, start + NEW_WRITE_BATCH)
      const written = await cluster.node(primary).insertBatch(INDEX, batch)
      expect(written.failed).toEqual([])
      for (const { id, ...document } of batch) expected.set(id, document)
    }

    replicaCoordinator.restoreReads()
    const rejoined = await waitUntil(
      `${replica} to rejoin the in-sync set of the new index`,
      async () => {
        const table = await cluster.coordinator.getAllocation(INDEX)
        return partitionAssignment(table)?.inSyncSet.includes(replica) === true ? table : null
      },
      REPLICA_RESYNC_TIMEOUT_MS,
    )
    await expectCopiesToHold(cluster, rejoined, expected)

    await replicaCoordinator.restoreWatches(INDEX)
    expect(await creating).toBeNull()
    const watched = await waitUntil(
      `${replica} to stay in the in-sync set once its watch returns`,
      async () => {
        const table = await cluster.coordinator.getAllocation(INDEX)
        return partitionAssignment(table)?.inSyncSet.includes(replica) === true ? table : null
      },
      REPLICA_RESYNC_TIMEOUT_MS,
    )
    await expectCopiesToHold(cluster, watched, expected)
  }, 180_000)
})
