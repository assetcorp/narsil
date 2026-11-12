import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decode as decodeWire, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createAckMessage } from '../../../distribution/replication/codec'
import {
  createInMemoryNetwork,
  createInMemoryTransport,
  type InMemoryNetwork,
} from '../../../distribution/transport/in-memory'
import {
  type NodeTransport,
  ReplicationMessageTypes,
  type RespondFn,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../../../distribution/transport/types'

const INDEX_NAME = 'harbour-berths'
const PARTITION_ID = 0
const DATA_NODES = ['quay-north', 'quay-south']
const REPLICATION_TIMEOUT_MS = 2_000
const ADMISSION_REPLY_TIMEOUT_MS = 2_000
const WITHDRAWAL_REPLY_TIMEOUT_MS = 5_000
const WITHDRAWAL_REPLY_SETTLE_MS = 250
const REMOVAL_REPLY_REPLICATION_TIMEOUT_MS = 8_000
const BERTHS_AFTER_READMISSION = 12
const CATCH_UP_TICK_MS = 1_000
const WAIT_BUDGET_MS = 30_000
const POLL_MS = 25
const LOG_RETENTION_BYTES = 2_048
const BERTHS_BEFORE_RACE = 40
const BERTH_NOTE = 'deep water berth with two cranes, a fuel dock, and a pilot station on the eastern breakwater'
const ENTRY_TYPES = new Set<string>([ReplicationMessageTypes.ENTRY, ReplicationMessageTypes.ENTRY_BATCH])
const INSYNC_TYPES = new Set<string>([ReplicationMessageTypes.INSYNC_ADD, ReplicationMessageTypes.INSYNC_REMOVE])

type ReplicaMode = 'silent' | 'ack' | 'hold'

interface ControllerEvent {
  type: string
  appliedSeqNo: number | undefined
}

interface Script {
  replica: string | null
  mode: ReplicaMode
  highestAcked: number
  deliveries: { first: number; last: number }[]
  deliveredDocumentIds: Set<string>
  heldAcks: (() => Promise<void>)[]
  holdAdmission: boolean
  heldAdmission: (() => Promise<void>) | null
  heldAdmissionAccepted: boolean | null
  holdRemovalReply: boolean
  heldRemovalReply: (() => Promise<void>) | null
  heldRemovalRequestId: string | null
  removalReplies: Map<string, 'answered' | 'lost'>
  controllerEvents: ControllerEvent[]
}

interface ClusterTimeouts {
  requestTimeout?: number
  replicationTimeout?: number
}

interface WireEntry {
  seqNo: number
  documentId: string
}

function freshScript(): Script {
  return {
    replica: null,
    mode: 'ack',
    highestAcked: 0,
    deliveries: [],
    deliveredDocumentIds: new Set(),
    heldAcks: [],
    holdAdmission: false,
    heldAdmission: null,
    heldAdmissionAccepted: null,
    holdRemovalReply: false,
    heldRemovalReply: null,
    heldRemovalRequestId: null,
    removalReplies: new Map(),
    controllerEvents: [],
  }
}

function wireFieldsOf(message: TransportMessage): Record<string, unknown> {
  const payload = decodeWire(message.payload)
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`a ${message.type} payload arrived as ${payload === null ? 'nil' : typeof payload}`)
  }
  return payload as Record<string, unknown>
}

function wireEntriesOf(message: TransportMessage): WireEntry[] {
  const payload = wireFieldsOf(message)
  const entries = message.type === ReplicationMessageTypes.ENTRY ? [payload.entry] : payload.entries
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`a ${message.type} arrived without entries`)
  return entries.map(entry => {
    const { seqNo, documentId } = (entry ?? {}) as { seqNo?: unknown; documentId?: unknown }
    if (typeof seqNo !== 'number' || typeof documentId !== 'string') {
      throw new Error(`a ${message.type} entry arrived without a numeric seqNo and a string documentId`)
    }
    return { seqNo, documentId }
  })
}

function seqNosOf(entries: WireEntry[]): { first: number; last: number } {
  const first = entries[0]
  const last = entries[entries.length - 1]
  if (first === undefined || last === undefined) throw new Error('an entry batch arrived empty')
  return { first: first.seqNo, last: last.seqNo }
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

describe('catch-up sessions of a replica outside the in-sync set', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let root = ''
  let script = freshScript()
  const running: ClusterNode[] = []
  const inner = new Map<string, NodeTransport>()
  let syncRequests = 0

  function replicaOf(): string {
    if (script.replica === null) throw new Error('no replica is scripted')
    return script.replica
  }

  async function answerEntries(nodeId: string, message: TransportMessage, respond: RespondFn): Promise<void> {
    const entries = wireEntriesOf(message)
    const seqNos = seqNosOf(entries)
    script.deliveries.push(seqNos)
    if (script.mode === 'silent') return
    for (const entry of entries) script.deliveredDocumentIds.add(entry.documentId)
    const acknowledge = async () => {
      script.highestAcked = Math.max(script.highestAcked, seqNos.last)
      await respond(createAckMessage(seqNos.last, PARTITION_ID, INDEX_NAME, nodeId, message.requestId))
    }
    if (script.mode === 'hold') {
      script.heldAcks.push(acknowledge)
      return
    }
    await acknowledge()
  }

  async function sendNotingRemovalReplies(
    transport: NodeTransport,
    target: string,
    message: TransportMessage,
  ): Promise<TransportMessage> {
    if (message.type !== ReplicationMessageTypes.INSYNC_REMOVE) return transport.send(target, message)
    try {
      const reply = await transport.send(target, message)
      script.removalReplies.set(message.requestId, 'answered')
      return reply
    } catch (error) {
      script.removalReplies.set(message.requestId, 'lost')
      throw error
    }
  }

  function dataNodeTransport(nodeId: string, timeouts: ClusterTimeouts): NodeTransport {
    const transport = createInMemoryTransport(nodeId, network, {
      replicationTimeout: timeouts.replicationTimeout ?? REPLICATION_TIMEOUT_MS,
      ...(timeouts.requestTimeout === undefined ? {} : { requestTimeout: timeouts.requestTimeout }),
    })
    inner.set(nodeId, transport)
    return {
      ...transport,
      send: (target, message) => sendNotingRemovalReplies(transport, target, message),
      stream: (target, message, handler) => {
        if (script.replica === nodeId && message.type === ReplicationMessageTypes.SYNC_REQUEST) {
          return Promise.reject(
            new TransportError(TransportErrorCodes.CONNECT_FAILED, 'the test sends this replica its sync requests', {
              target,
            }),
          )
        }
        return transport.stream(target, message, handler)
      },
      listen: handler =>
        transport.listen((message: TransportMessage, respond: RespondFn) => {
          if (script.replica !== nodeId || !ENTRY_TYPES.has(message.type)) return handler(message, respond)
          return answerEntries(nodeId, message, respond)
        }),
    }
  }

  function controllerTransport(timeouts: ClusterTimeouts): NodeTransport {
    const transport = createInMemoryTransport('harbour-master', network, {
      replicationTimeout: timeouts.replicationTimeout ?? REPLICATION_TIMEOUT_MS,
    })
    return {
      ...transport,
      listen: handler =>
        transport.listen((message: TransportMessage, respond: RespondFn) => {
          if (!INSYNC_TYPES.has(message.type)) return handler(message, respond)
          const payload = wireFieldsOf(message)
          if (payload.replicaNodeId !== script.replica) return handler(message, respond)
          const appliedSeqNo = typeof payload.appliedSeqNo === 'number' ? payload.appliedSeqNo : undefined
          script.controllerEvents.push({ type: message.type, appliedSeqNo })
          if (message.type === ReplicationMessageTypes.INSYNC_ADD && script.holdAdmission) {
            script.holdAdmission = false
            const answerHeldAdmission: RespondFn = async response => {
              script.heldAdmissionAccepted = wireFieldsOf(response).accepted === true
              await respond(response)
            }
            script.heldAdmission = () => Promise.resolve(handler(message, answerHeldAdmission))
            return
          }
          if (message.type === ReplicationMessageTypes.INSYNC_REMOVE && script.holdRemovalReply) {
            script.holdRemovalReply = false
            script.heldRemovalRequestId = message.requestId
            const holdReply: RespondFn = async response => {
              script.heldRemovalReply = () => respond(response)
            }
            return handler(message, holdReply)
          }
          return handler(message, respond)
        }),
    }
  }

  async function allocation(): Promise<AllocationTable> {
    const table = await coordinator.getAllocation(INDEX_NAME)
    if (table === null) throw new Error(`${INDEX_NAME} has no allocation`)
    return table
  }

  async function inSyncSet(): Promise<string[]> {
    return (await allocation()).assignments.get(PARTITION_ID)?.inSyncSet ?? []
  }

  async function startCluster(logRetentionBytes?: number, timeouts: ClusterTimeouts = {}) {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    root = await mkdtemp(join(tmpdir(), 'narsil-catch-up-sessions-'))
    for (const nodeId of DATA_NODES) {
      const node = await createClusterNode({
        coordinator,
        transport: dataNodeTransport(nodeId, timeouts),
        address: `${nodeId}:9200`,
        nodeId,
        roles: ['data'],
        engine: { workers: { enabled: false }, durability: { directory: join(root, nodeId) } },
        ...(logRetentionBytes === undefined ? {} : { replication: { logRetentionBytes } }),
      })
      running.push(node)
      await node.start()
    }
    const router = await createClusterNode({
      coordinator,
      transport: controllerTransport(timeouts),
      address: 'harbour-master:9200',
      nodeId: 'harbour-master',
      roles: ['coordinator', 'controller'],
    })
    running.push(router)
    await router.start()
    await router.createIndex(INDEX_NAME, { schema: { note: 'string' } }, { partitionCount: 1, replicationFactor: 1 })
    const assignment = await waitFor(async () => {
      const entry = (await coordinator.getAllocation(INDEX_NAME))?.assignments.get(PARTITION_ID)
      const replica = entry?.replicas[0]
      if (entry?.state !== 'ACTIVE' || entry.primary === null || replica === undefined) return null
      return entry.inSyncSet.includes(replica) ? { ...entry, primary: entry.primary, replica } : null
    }, 'the replica to join the in-sync set')
    return { router, primary: assignment.primary, replica: assignment.replica, term: assignment.primaryTerm }
  }

  async function dropFromInSyncSet(router: ClusterNode, replica: string): Promise<void> {
    script.replica = replica
    script.mode = 'silent'
    await router.insert(INDEX_NAME, { id: 'berth-dropped', note: BERTH_NOTE })
    await waitFor(async () => ((await inSyncSet()).includes(replica) ? null : true), 'the replica to leave the set')
    script.deliveries = []
    script.controllerEvents = []
  }

  async function requestSync(primary: string, lastSeqNo: number, lastPrimaryTerm: number): Promise<void> {
    const replica = replicaOf()
    const transport = inner.get(replica)
    if (transport === undefined) throw new Error(`${replica} has no transport`)
    syncRequests += 1
    await transport.stream(
      primary,
      {
        type: ReplicationMessageTypes.SYNC_REQUEST,
        sourceId: replica,
        requestId: `scripted-sync-${syncRequests}`,
        payload: encode({ indexName: INDEX_NAME, partitionId: PARTITION_ID, lastSeqNo, lastPrimaryTerm }),
      },
      () => {},
    )
  }

  afterEach(async () => {
    script.mode = 'silent'
    for (const release of script.heldAcks.splice(0)) await release().catch(() => {})
    await script.heldAdmission?.().catch(() => {})
    await script.heldRemovalReply?.().catch(() => {})
    for (const node of running.splice(0).reverse()) await node.shutdown().catch(() => {})
    await coordinator.shutdown()
    await rm(root, { recursive: true, force: true })
    script = freshScript()
  })

  it('keeps a caught-up replica in the set when its synced-position report reaches the primary during its admission under a write burst', async () => {
    const { router, primary, replica } = await startCluster()
    await dropFromInSyncSet(router, replica)

    let writing = true
    let written = 0
    const burst = (async () => {
      while (writing) {
        await router.insert(INDEX_NAME, { id: `berth-burst-${written}`, note: BERTH_NOTE })
        written += 1
      }
    })()

    script.mode = 'ack'
    script.holdAdmission = true
    await requestSync(primary, 0, 0)
    const releaseAdmission = await waitFor(() => script.heldAdmission, 'the primary to propose the replica')
    const term = (await allocation()).assignments.get(PARTITION_ID)?.primaryTerm ?? 0
    await requestSync(primary, script.highestAcked, term)
    const proposalsBefore = script.controllerEvents.length
    script.heldAdmission = null
    await releaseAdmission()

    await waitFor(async () => ((await inSyncSet()).includes(replica) ? true : null), 'the replica to join the set')
    await new Promise(resolve => setTimeout(resolve, 2 * CATCH_UP_TICK_MS))
    writing = false
    await burst

    expect(written).toBeGreaterThan(0)
    expect(script.controllerEvents.slice(proposalsBefore)).not.toContainEqual(
      expect.objectContaining({ type: ReplicationMessageTypes.INSYNC_REMOVE }),
    )
    expect(await inSyncSet()).toContain(replica)
  }, 90_000)

  it('discards an acknowledgement from before an empty copy asks for a snapshot, so the replica is never proposed above the position it reports after it', async () => {
    const { router, primary, replica, term } = await startCluster(LOG_RETENTION_BYTES)
    await dropFromInSyncSet(router, replica)
    for (let berth = 0; berth < BERTHS_BEFORE_RACE; berth++) {
      await router.insert(INDEX_NAME, { id: `berth-${berth}`, note: BERTH_NOTE })
    }
    const logEnd = BERTHS_BEFORE_RACE + 1
    const reported = logEnd - 2

    script.mode = 'hold'
    await requestSync(primary, reported, term)
    await waitFor(() => (script.heldAcks.length > 0 ? true : null), 'the primary to feed the replica')
    expect(script.deliveries[0]).toEqual({ first: reported + 1, last: logEnd })

    await requestSync(primary, 0, 0)
    await requestSync(primary, reported, term)
    script.mode = 'silent'
    const eventsBefore = script.controllerEvents.length
    for (const release of script.heldAcks.splice(0)) await release()

    await new Promise(resolve => setTimeout(resolve, REPLICATION_TIMEOUT_MS + 2 * CATCH_UP_TICK_MS))
    expect(script.controllerEvents.slice(eventsBefore)).not.toContainEqual(
      expect.objectContaining({ type: ReplicationMessageTypes.INSYNC_ADD }),
    )
    expect(await inSyncSet()).not.toContain(replica)
  }, 90_000)

  it('withdraws the admission and proposes no other for a replica recorded at the log end once it reports a diverged history at or past that end, until it reports a position the log matches', async () => {
    const { router, primary, replica, term } = await startCluster()
    await dropFromInSyncSet(router, replica)
    for (let berth = 0; berth < BERTHS_BEFORE_RACE; berth++) {
      await router.insert(INDEX_NAME, { id: `berth-${berth}`, note: BERTH_NOTE })
    }
    const logEnd = BERTHS_BEFORE_RACE + 1

    script.mode = 'ack'
    script.holdAdmission = true
    await requestSync(primary, logEnd, term)
    const releaseAdmission = await waitFor(() => script.heldAdmission, 'the primary to propose the replica')
    expect(script.controllerEvents).toContainEqual({ type: ReplicationMessageTypes.INSYNC_ADD, appliedSeqNo: logEnd })

    await requestSync(primary, logEnd, term - 1)
    await requestSync(primary, logEnd + 3, term)
    const eventsBefore = script.controllerEvents.length
    script.heldAdmission = null
    await releaseAdmission()
    await waitFor(
      () =>
        script.controllerEvents.slice(eventsBefore).some(event => event.type === ReplicationMessageTypes.INSYNC_REMOVE)
          ? true
          : null,
      'the primary to withdraw the admission it proposed before the diverged report',
    )

    await requestSync(primary, logEnd + 3, term)
    await new Promise(resolve => setTimeout(resolve, REPLICATION_TIMEOUT_MS + 3 * CATCH_UP_TICK_MS))
    expect(script.controllerEvents.slice(eventsBefore)).not.toContainEqual(
      expect.objectContaining({ type: ReplicationMessageTypes.INSYNC_ADD }),
    )
    expect(await inSyncSet()).not.toContain(replica)

    await requestSync(primary, logEnd, term)
    await waitFor(async () => ((await inSyncSet()).includes(replica) ? true : null), 'the replica to join the set')
    expect(script.controllerEvents.slice(eventsBefore)).toContainEqual({
      type: ReplicationMessageTypes.INSYNC_ADD,
      appliedSeqNo: logEnd,
    })
  }, 90_000)

  it('withdraws an admission whose answer never came once the controller applies it after the replica has asked for a snapshot', async () => {
    const { router, primary, replica, term } = await startCluster(undefined, {
      requestTimeout: ADMISSION_REPLY_TIMEOUT_MS,
    })
    await dropFromInSyncSet(router, replica)
    for (let berth = 0; berth < BERTHS_BEFORE_RACE; berth++) {
      await router.insert(INDEX_NAME, { id: `berth-${berth}`, note: BERTH_NOTE })
    }
    const logEnd = BERTHS_BEFORE_RACE + 1

    script.mode = 'ack'
    script.holdAdmission = true
    await requestSync(primary, logEnd, term)
    const releaseAdmission = await waitFor(() => script.heldAdmission, 'the primary to propose the replica')
    await requestSync(primary, logEnd, term - 1)
    await new Promise(resolve => setTimeout(resolve, ADMISSION_REPLY_TIMEOUT_MS + CATCH_UP_TICK_MS))

    const eventsBefore = script.controllerEvents.length
    script.heldAdmission = null
    await releaseAdmission()
    expect(await waitFor(() => script.heldAdmissionAccepted, 'the controller to answer the released admission')).toBe(
      true,
    )
    await waitFor(
      () =>
        script.controllerEvents.slice(eventsBefore).some(event => event.type === ReplicationMessageTypes.INSYNC_REMOVE)
          ? true
          : null,
      'the primary to withdraw the admission that the controller applied after its answer timed out',
    )
    await waitFor(async () => ((await inSyncSet()).includes(replica) ? null : true), 'the replica to leave the set')
  }, 90_000)

  it('sends every acknowledged write to a replica readmitted while the reply to the withdrawal of its earlier admission was still on its way', async () => {
    const { router, primary, replica, term } = await startCluster(undefined, {
      requestTimeout: WITHDRAWAL_REPLY_TIMEOUT_MS,
    })
    await dropFromInSyncSet(router, replica)
    for (let berth = 0; berth < BERTHS_BEFORE_RACE; berth++) {
      await router.insert(INDEX_NAME, { id: `berth-${berth}`, note: BERTH_NOTE })
    }
    const logEnd = BERTHS_BEFORE_RACE + 1

    script.mode = 'ack'
    script.holdAdmission = true
    await requestSync(primary, logEnd, term)
    const releaseStaleAdmission = await waitFor(() => script.heldAdmission, 'the primary to propose the replica')
    await requestSync(primary, logEnd, term - 1)
    await new Promise(resolve => setTimeout(resolve, WITHDRAWAL_REPLY_TIMEOUT_MS + CATCH_UP_TICK_MS))

    script.holdRemovalReply = true
    script.heldAdmission = null
    await releaseStaleAdmission()
    expect(await waitFor(() => script.heldAdmissionAccepted, 'the controller to answer the stale admission')).toBe(true)
    const releaseWithdrawalReply = await waitFor(
      () => script.heldRemovalReply,
      'the controller to apply the withdrawal of the stale admission',
    )
    const withdrawalRequestId = script.heldRemovalRequestId
    if (withdrawalRequestId === null) throw new Error('the controller held a withdrawal reply without its request id')
    await waitFor(async () => ((await inSyncSet()).includes(replica) ? null : true), 'the replica to leave the set')

    script.holdAdmission = true
    script.heldAdmissionAccepted = null
    await requestSync(primary, logEnd, term)
    const releaseReadmission = await waitFor(
      () => script.heldAdmission,
      'the primary to propose the replica again while the withdrawal reply is held',
    )
    script.heldRemovalReply = null
    await releaseWithdrawalReply()
    expect(
      await waitFor(
        () => script.removalReplies.get(withdrawalRequestId) ?? null,
        'the primary to receive the withdrawal reply or give up on it',
      ),
    ).toBe('answered')
    await new Promise(resolve => setTimeout(resolve, WITHDRAWAL_REPLY_SETTLE_MS))
    script.heldAdmission = null
    await releaseReadmission()
    expect(await waitFor(() => script.heldAdmissionAccepted, 'the controller to answer the readmission')).toBe(true)
    await waitFor(async () => ((await inSyncSet()).includes(replica) ? true : null), 'the replica to rejoin the set')

    script.deliveredDocumentIds.clear()
    const acknowledged: string[] = []
    for (let berth = 0; berth < BERTHS_AFTER_READMISSION; berth++) {
      const documentId = `berth-readmitted-${berth}`
      await router.insert(INDEX_NAME, { id: documentId, note: BERTH_NOTE })
      acknowledged.push(documentId)
    }

    expect(acknowledged.filter(documentId => !script.deliveredDocumentIds.has(documentId))).toEqual([])
    expect(await inSyncSet()).toContain(replica)
  }, 90_000)

  it('sends every later acknowledged write to a replica readmitted while the reply to its removal after a missed write was still on its way', async () => {
    const { router, primary, replica, term } = await startCluster(undefined, {
      replicationTimeout: REMOVAL_REPLY_REPLICATION_TIMEOUT_MS,
    })
    script.replica = replica
    script.mode = 'silent'
    script.holdRemovalReply = true
    const missedWrite = router.insert(INDEX_NAME, { id: 'berth-missed', note: BERTH_NOTE }).then(
      () => 'acknowledged',
      (error: unknown) => error,
    )
    const releaseRemovalReply = await waitFor(
      () => script.heldRemovalReply,
      'the controller to apply the removal of the replica that missed the write',
    )
    const removalRequestId = script.heldRemovalRequestId
    if (removalRequestId === null) throw new Error('the controller held a removal reply without its request id')
    await waitFor(async () => ((await inSyncSet()).includes(replica) ? null : true), 'the replica to leave the set')
    const missed = script.deliveries.at(-1)
    if (missed === undefined) throw new Error('the primary never sent the replica the write that it missed')

    script.mode = 'ack'
    await requestSync(primary, missed.last, term)
    await waitFor(
      async () => ((await inSyncSet()).includes(replica) ? true : null),
      'the replica to rejoin the set while the reply to its removal is held',
    )

    script.heldRemovalReply = null
    await releaseRemovalReply()
    expect(
      await waitFor(
        () => script.removalReplies.get(removalRequestId) ?? null,
        'the primary to receive the removal reply or give up on it',
      ),
    ).toBe('answered')
    expect(await missedWrite).toBe('acknowledged')

    script.deliveredDocumentIds.clear()
    const acknowledged: string[] = []
    for (let berth = 0; berth < BERTHS_AFTER_READMISSION; berth++) {
      const documentId = `berth-after-removal-reply-${berth}`
      await router.insert(INDEX_NAME, { id: documentId, note: BERTH_NOTE })
      acknowledged.push(documentId)
    }

    expect(acknowledged.filter(documentId => !script.deliveredDocumentIds.has(documentId))).toEqual([])
    expect(await inSyncSet()).toContain(replica)
  }, 90_000)
})
