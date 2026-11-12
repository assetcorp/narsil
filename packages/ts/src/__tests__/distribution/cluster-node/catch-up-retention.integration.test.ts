import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationEvent, ClusterCoordinator, PartitionAssignment } from '../../../distribution/coordinator/types'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import {
  type NodeTransport,
  ReplicationMessageTypes,
  type RespondFn,
  type TransportMessage,
} from '../../../distribution/transport/types'
import { readCopy } from './acknowledged-writes/harness'

const INDEX_NAME = 'tide-ledger'
const PARTITION_ID = 0
const CONTROLLER = 'harbour-master'
const PRIMARY = 'quay-north'
const REPLICA = 'quay-south'
const LOG_RETENTION_BYTES = 2_048
const REPLICATION_TIMEOUT_MS = 1_000
const REQUEST_TIMEOUT_MS = 5_000
const TIDE_NOTE = 'x'.repeat(700)
const ENTRIES_BEFORE_REPLICA = 3
const ENTRIES_WHILE_PROOF_WAITS = 8
const ENTRIES_WHILE_FEED_FAILS = 10
const WAIT_BUDGET_MS = 40_000
const POLL_MS = 50
const ENTRY_TYPES = new Set<string>([ReplicationMessageTypes.ENTRY, ReplicationMessageTypes.ENTRY_BATCH])

interface Gate {
  promise: Promise<void>
  release: () => void
}

function gate(): Gate {
  let release = () => {}
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}

async function waitFor<T>(read: () => Promise<T | null> | T | null, what: string): Promise<T> {
  const deadline = Date.now() + WAIT_BUDGET_MS
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function entrySeqNoOf(message: TransportMessage): number | null {
  const payload = decode(message.payload) as { entry?: { seqNo?: unknown } }
  return typeof payload.entry?.seqNo === 'number' ? payload.entry.seqNo : null
}

interface UnchangedTableFilter {
  coordinator: ClusterCoordinator
  dropUnchangedTables: () => void
}

function filterUnchangedTables(inner: ClusterCoordinator): UnchangedTableFilter {
  const deliveredAssignments = new Map<string, string>()
  let dropping = false
  const watchAllocation = (handler: (event: AllocationEvent) => void) =>
    inner.watchAllocation(event => {
      const assignments = JSON.stringify([...event.table.assignments])
      if (dropping && deliveredAssignments.get(event.indexName) === assignments) return
      deliveredAssignments.set(event.indexName, assignments)
      handler(event)
    })
  const coordinator = new Proxy(inner, {
    get(target, property, receiver) {
      return property === 'watchAllocation' ? watchAllocation : Reflect.get(target, property, receiver)
    },
  })
  return {
    coordinator,
    dropUnchangedTables: () => {
      dropping = true
    },
  }
}

describe('catch-up of a replica whose position leaves the retained log', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let probe: NodeTransport
  const running: ClusterNode[] = []
  const transports: NodeTransport[] = []
  const openGates: Gate[] = []

  function transportOf(nodeId: string): NodeTransport {
    const transport = createInMemoryTransport(nodeId, network, {
      replicationTimeout: REPLICATION_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
    })
    transports.push(transport)
    return transport
  }

  async function startNode(
    nodeId: string,
    transport: NodeTransport,
    nodeCoordinator: ClusterCoordinator = coordinator,
  ): Promise<ClusterNode> {
    const node = await createClusterNode({
      coordinator: nodeCoordinator,
      transport,
      address: nodeId,
      nodeId,
      roles: nodeId === CONTROLLER ? ['controller', 'coordinator'] : ['data', 'coordinator'],
      engine: { workers: { enabled: false } },
      replication: { logRetentionBytes: LOG_RETENTION_BYTES },
    })
    running.push(node)
    await node.start()
    return node
  }

  async function startPrimaryWithEntries(primaryTransport: NodeTransport): Promise<ClusterNode> {
    const controller = await startNode(CONTROLLER, transportOf(CONTROLLER))
    await startNode(PRIMARY, primaryTransport)
    await controller.createIndex(
      INDEX_NAME,
      { schema: { note: 'string' } },
      { partitionCount: 1, replicationFactor: 1 },
    )
    for (let tide = 0; tide < ENTRIES_BEFORE_REPLICA; tide++) {
      await controller.insert(INDEX_NAME, { id: `tide-${tide}`, note: TIDE_NOTE })
    }
    return controller
  }

  async function assignment(): Promise<PartitionAssignment> {
    const entry = (await coordinator.getAllocation(INDEX_NAME))?.assignments.get(PARTITION_ID)
    if (entry === undefined) throw new Error(`${INDEX_NAME} has no assignment for partition ${PARTITION_ID}`)
    return entry
  }

  async function replicaHolds(documentIds: string[]): Promise<true | null> {
    const copy = await readCopy(probe, REPLICA, PARTITION_ID, INDEX_NAME).catch(() => null)
    if (copy === null) return null
    return documentIds.every(documentId => copy.has(documentId)) ? true : null
  }

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    probe = transportOf('tide-reader')
  })

  afterEach(async () => {
    for (const open of openGates.splice(0)) open.release()
    for (const node of running.splice(0).reverse()) await node.shutdown().catch(() => {})
    for (const transport of transports.splice(0)) await transport.shutdown().catch(() => {})
    await coordinator.shutdown()
  })

  it('acknowledges a resent entry that its log has evicted but its copy holds, so the primary admits the replica and sends it every later write', async () => {
    const proofHeld = gate()
    const proofReleased = gate()
    openGates.push(proofHeld, proofReleased)
    let proofReply: TransportMessage | null = null
    const primaryTransport = transportOf(PRIMARY)
    const controller = await startPrimaryWithEntries({
      ...primaryTransport,
      async send(target, message) {
        const holdsProof =
          proofReply === null &&
          target === REPLICA &&
          message.type === ReplicationMessageTypes.ENTRY &&
          entrySeqNoOf(message) === ENTRIES_BEFORE_REPLICA
        if (!holdsProof) return primaryTransport.send(target, message)
        proofHeld.release()
        await proofReleased.promise
        const reply = await primaryTransport.send(target, message)
        proofReply = reply
        return reply
      },
    })
    await startNode(REPLICA, transportOf(REPLICA))
    await proofHeld.promise
    const tideIds = Array.from(
      { length: ENTRIES_BEFORE_REPLICA + ENTRIES_WHILE_PROOF_WAITS },
      (_, tide) => `tide-${tide}`,
    )
    for (const documentId of tideIds.slice(ENTRIES_BEFORE_REPLICA)) {
      await controller.insert(INDEX_NAME, { id: documentId, note: TIDE_NOTE })
    }
    await waitFor(() => replicaHolds(tideIds), 'the replica to apply every write sent while the proof waited')
    proofReleased.release()

    const reply = await waitFor(() => proofReply, 'the replica to answer the resent entry')
    expect(reply.type).toBe(ReplicationMessageTypes.ACK)
    await waitFor(
      async () => ((await assignment()).inSyncSet.includes(REPLICA) ? true : null),
      'the replica to join the in-sync set',
    )
    await controller.insert(INDEX_NAME, { id: 'tide-later', note: 'slack water' })
    await waitFor(() => replicaHolds([...tideIds, 'tide-later']), 'the replica to receive the later write')
  }, 90_000)

  it('syncs a replica again once its position falls below the oldest entry that the primary retains, so it rejoins the in-sync set and receives every acknowledged write', async () => {
    const controller = await startPrimaryWithEntries(transportOf(PRIMARY))
    let feedFails = false
    const replicaTransport = transportOf(REPLICA)
    const feedFailingTransport: NodeTransport = {
      ...replicaTransport,
      listen: handler =>
        replicaTransport.listen((message: TransportMessage, respond: RespondFn) => {
          if (feedFails && ENTRY_TYPES.has(message.type)) return
          return handler(message, respond)
        }),
    }
    const tableFilter = filterUnchangedTables(coordinator)
    await startNode(REPLICA, feedFailingTransport, tableFilter.coordinator)
    await waitFor(
      async () => ((await assignment()).inSyncSet.includes(REPLICA) ? true : null),
      'the replica to join the in-sync set',
    )

    feedFails = true
    const tideIds = Array.from(
      { length: ENTRIES_BEFORE_REPLICA + 1 + ENTRIES_WHILE_FEED_FAILS },
      (_, tide) => `tide-${tide}`,
    )
    const syncedIds = tideIds.slice(0, ENTRIES_BEFORE_REPLICA + 1)
    await controller.insert(INDEX_NAME, { id: syncedIds[ENTRIES_BEFORE_REPLICA], note: TIDE_NOTE })
    expect((await assignment()).inSyncSet).not.toContain(REPLICA)
    await waitFor(() => replicaHolds(syncedIds), 'the replica to sync the write that it missed')
    tableFilter.dropUnchangedTables()
    const versionAfterSync = (await assignment()).inSyncVersion

    for (const documentId of tideIds.slice(syncedIds.length)) {
      await controller.insert(INDEX_NAME, { id: documentId, note: TIDE_NOTE })
    }
    expect((await assignment()).inSyncVersion).toBe(versionAfterSync)
    feedFails = false

    await controller.insert(INDEX_NAME, { id: 'tide-later', note: 'slack water' })
    await waitFor(
      async () => ((await assignment()).inSyncSet.includes(REPLICA) ? true : null),
      'the replica to rejoin the in-sync set',
    )
    await waitFor(() => replicaHolds([...tideIds, 'tide-later']), 'the replica to hold every acknowledged write')
  }, 90_000)
})
