import { setTimeout as sleep } from 'node:timers/promises'
import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PARTITION_WRITE_CONCURRENCY,
  PRIMARY_CHANGE_RETRY_WINDOW_MS,
} from '../../../../distribution/cluster-node/constants'
import type { ClusterCoordinator } from '../../../../distribution/coordinator/types'
import { createInMemoryTransport } from '../../../../distribution/transport'
import type { NodeTransport, TransportMessage } from '../../../../distribution/transport/types'
import type { BatchResult } from '../../../../types/results'
import { createTestCluster, readCopy, SCHEMA, type TestCluster } from './harness'

const CONTROLLER = 'controller'
const FIRST_HOLDER = 'node-a'
const ROUTER = 'router'
const SCRIPTED = 'scripted-primary'
const SUCCESSOR = 'scripted-successor'
const ANSWER_MARGIN_MS = 3_000
const LATE_CHUNK_WAIT_MS = 2_000
const QUEUED_PARTITION_HOLD_MS = 16_000
const WIDE_BATCH = 340
const TWO_CHUNK_BATCH = 1_001
const NESTING_PAST_ENCODING_LIMIT = 120

const ENDED_TERM_INDEX = 'ended-term'
const TWO_CHUNK_INDEX = 'two-chunk'
const WIDE_INDEX = 'wide'
const STALLED_INDEX = 'stalled'
const FAILING_LISTENER_INDEX = 'failing-listener'

interface ScriptedPrimary {
  arrivals: TransportMessage[]
}

type ForwardScript = (message: TransportMessage) => Promise<TransportMessage>

interface ForwardedRequest {
  indexName: string
  documentId?: string
  operations?: Array<{ documentId: string }>
}

const peers: NodeTransport[] = []
let cluster: TestCluster | undefined

afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.shutdown()
  await cluster?.dispose()
  cluster = undefined
})

function requestOf(message: TransportMessage): ForwardedRequest {
  return decode(message.payload) as ForwardedRequest
}

function documentIdsOf(message: TransportMessage): string[] {
  const request = requestOf(message)
  return request.operations?.map(operation => operation.documentId) ?? [request.documentId ?? '']
}

function accepted(message: TransportMessage, nodeId: string): TransportMessage {
  const documentIds = documentIdsOf(message)
  const payload =
    message.type === 'replication.forward_batch'
      ? { results: documentIds.map(documentId => ({ documentId, success: true })) }
      : { documentId: documentIds[0], success: true }
  return { type: message.type, sourceId: nodeId, requestId: message.requestId, payload: encode(payload) }
}

function refused(
  message: TransportMessage,
  nodeId: string,
  code: string,
  details: Record<string, unknown>,
): TransportMessage {
  return {
    type: `${message.type}.error`,
    sourceId: nodeId,
    requestId: message.requestId,
    payload: encode({ error: true, code, message: `${nodeId} refused the forwarded write`, details }),
  }
}

function carrierFailure(message: TransportMessage): TransportMessage {
  return {
    type: 'error',
    sourceId: '',
    requestId: message.requestId,
    payload: new TextEncoder().encode('the listener failed after it applied the write'),
  }
}

async function scriptedPrimary(running: TestCluster, nodeId: string, script: ForwardScript): Promise<ScriptedPrimary> {
  const transport = createInMemoryTransport(nodeId, running.network)
  peers.push(transport)
  const arrivals: TransportMessage[] = []
  await transport.listen(async (message, respond) => {
    if (!message.type.startsWith('replication.forward')) return
    arrivals.push(message)
    await respond(await script(message))
  })
  return { arrivals }
}

async function leadEveryPartition(running: TestCluster, indexName: string, primary: string): Promise<void> {
  const table = await running.coordinator.getAllocation(indexName)
  if (table === null) throw new Error(`${indexName} has no allocation table`)
  const assignments = new Map(
    [...table.assignments].map(([partitionId, assignment]) => [
      partitionId,
      { ...assignment, primary, replicas: [primary], inSyncSet: [], primaryTerm: assignment.primaryTerm + 1 },
    ]),
  )
  await running.coordinator.putAllocation(indexName, { ...table, version: table.version + 1, assignments })
}

async function startRouterBeforeScriptedPrimary(
  partitionCounts: Record<string, number>,
  routerCoordinator?: (shared: ClusterCoordinator) => ClusterCoordinator,
): Promise<TestCluster> {
  const running = await createTestCluster()
  cluster = running
  await running.start(CONTROLLER, { roles: ['controller', 'coordinator'], durable: false })
  await running.start(FIRST_HOLDER, { durable: false })
  for (const [indexName, partitionCount] of Object.entries(partitionCounts)) {
    await running.node(CONTROLLER).createIndex(indexName, { schema: SCHEMA }, { partitionCount, replicationFactor: 0 })
  }
  await running.stop(CONTROLLER)
  await running.stop(FIRST_HOLDER)
  await running.start(ROUTER, {
    roles: ['coordinator'],
    durable: false,
    ...(routerCoordinator === undefined ? {} : { coordinator: routerCoordinator(running.coordinator) }),
  })
  for (const indexName of Object.keys(partitionCounts)) await leadEveryPartition(running, indexName, SCRIPTED)
  return running
}

interface StalledReads {
  coordinator(shared: ClusterCoordinator): ClusterCoordinator
  stall(): void
  release(): void
}

function stalledAllocationReads(indexName: string): StalledReads {
  let gate: Promise<void> | null = null
  let open: () => void = () => undefined
  return {
    coordinator: shared =>
      new Proxy(shared, {
        get(target, property, receiver) {
          if (property !== 'getAllocation') return Reflect.get(target, property, receiver)
          return async (name: string) => {
            if (name === indexName && gate !== null) await gate
            return target.getAllocation(name)
          }
        },
      }),
    stall() {
      gate = new Promise<void>(resolve => (open = resolve))
    },
    release() {
      gate = null
      open()
    },
  }
}

const UNANSWERED = 'unanswered'

function answerOf(write: Promise<unknown>): Promise<unknown> {
  return write.catch((error: unknown) => error)
}

function withinWindow(answer: Promise<unknown>): Promise<unknown> {
  return Promise.race([answer, sleep(PRIMARY_CHANGE_RETRY_WINDOW_MS + ANSWER_MARGIN_MS, UNANSWERED)])
}

function ledgerEntries(prefix: string, count: number): Array<{ id: string; title: string; amount: number }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    title: `transfer ${prefix} ${i}`,
    amount: i,
  }))
}

function nestedPastEncodingLimit(): Record<string, unknown> {
  let nested: Record<string, unknown> = { leaf: 'end' }
  for (let depth = 0; depth < NESTING_PAST_ENCODING_LIMIT; depth++) nested = { child: nested }
  return nested
}

describe('the node that forwards a write answers the client from the forward rules', () => {
  it('answers an earlier term_ended refusal, sends no chunk after its window, gives each queued partition a full window, and answers while the table cannot be read', async () => {
    const stalled = stalledAllocationReads(STALLED_INDEX)
    const running = await startRouterBeforeScriptedPrimary(
      {
        [ENDED_TERM_INDEX]: 1,
        [TWO_CHUNK_INDEX]: 1,
        [WIDE_INDEX]: PARTITION_WRITE_CONCURRENCY + 1,
        [STALLED_INDEX]: 1,
      },
      stalled.coordinator,
    )
    let releaseFirstChunk: () => void = () => undefined
    const firstChunkHeld = new Promise<void>(resolve => (releaseFirstChunk = resolve))
    let heldChunks = 0
    const scripted = await scriptedPrimary(running, SCRIPTED, async message => {
      const { indexName } = requestOf(message)
      if (indexName === ENDED_TERM_INDEX) {
        await leadEveryPartition(running, ENDED_TERM_INDEX, SUCCESSOR)
        return refused(message, SCRIPTED, 'REPLICATION_OUTCOME_UNKNOWN', { reason: 'term_ended', partitionId: 0 })
      }
      if (indexName === TWO_CHUNK_INDEX && heldChunks++ === 0) {
        await firstChunkHeld
        return accepted(message, SCRIPTED)
      }
      if (indexName === WIDE_INDEX) {
        await sleep(QUEUED_PARTITION_HOLD_MS)
        return accepted(message, SCRIPTED)
      }
      if (indexName === STALLED_INDEX) {
        stalled.stall()
        return refused(message, SCRIPTED, 'PARTITION_NOT_PRIMARY', { partitionId: 0, localNodeId: SCRIPTED })
      }
      return accepted(message, SCRIPTED)
    })
    const successor = await scriptedPrimary(running, SUCCESSOR, async message =>
      refused(message, SUCCESSOR, 'PARTITION_NOT_PRIMARY', { partitionId: 0, localNodeId: SUCCESSOR }),
    )

    const router = running.node(ROUTER)
    const wideEntries = ledgerEntries('wide', WIDE_BATCH)
    const twoChunkEntries = ledgerEntries('chunked', TWO_CHUNK_BATCH)
    const endedTerm = answerOf(router.insert(ENDED_TERM_INDEX, { title: 'ended term', amount: 1 }, 'ended-term-1'))
    const twoChunks = answerOf(router.insertBatch(TWO_CHUNK_INDEX, twoChunkEntries))
    const wide = answerOf(router.insertBatch(WIDE_INDEX, wideEntries))
    const stalledWrite = answerOf(router.update(STALLED_INDEX, 'stalled-1', { title: 'stalled', amount: 2 }))

    try {
      expect.soft(await withinWindow(endedTerm), 'the write refused with term_ended').toMatchObject({
        code: 'REPLICATION_OUTCOME_UNKNOWN',
        details: { reason: 'term_ended' },
      })
      expect.soft(successor.arrivals.length).toBeGreaterThanOrEqual(1)

      const twoChunkResult = (await withinWindow(twoChunks)) as BatchResult
      expect(twoChunkResult).not.toBe(UNANSWERED)
      expect.soft(twoChunkResult.succeeded).toEqual([])
      expect
        .soft(twoChunkResult.failed.map(failure => failure.docId).sort())
        .toEqual(twoChunkEntries.map(entry => entry.id).sort())
      const twoChunkReasons = new Set(
        twoChunkResult.failed.map(failure => `${failure.error.code} ${String(failure.error.details.reason)}`),
      )
      expect.soft(twoChunkReasons).toEqual(new Set(['REPLICATION_OUTCOME_UNKNOWN forward_window_ended']))
      releaseFirstChunk()
      await sleep(LATE_CHUNK_WAIT_MS)
      const twoChunkSends = scripted.arrivals.filter(message => requestOf(message).indexName === TWO_CHUNK_INDEX)
      expect.soft(twoChunkSends.length, 'messages of the batch whose window closed').toBe(1)

      const wideResult = (await wide) as BatchResult
      expect
        .soft(
          wideResult.failed.map(failure => failure.docId),
          'writes of the queued partitions',
        )
        .toEqual([])
      expect.soft([...wideResult.succeeded].sort()).toEqual(wideEntries.map(entry => entry.id).sort())
      const wideSends = scripted.arrivals.filter(message => requestOf(message).indexName === WIDE_INDEX)
      expect.soft(wideSends.length).toBeGreaterThan(PARTITION_WRITE_CONCURRENCY)

      expect
        .soft(await withinWindow(stalledWrite), 'the write whose table read stalls')
        .toMatchObject({ code: 'PARTITION_NOT_PRIMARY' })
    } finally {
      releaseFirstChunk()
      stalled.release()
    }
  }, 120_000)

  it('answers a carrier error reply to a forwarded update or remove as an interrupted forward and never sends it again', async () => {
    const running = await startRouterBeforeScriptedPrimary({ [FAILING_LISTENER_INDEX]: 1 })
    const scripted = await scriptedPrimary(running, SCRIPTED, async message => carrierFailure(message))
    const router = running.node(ROUTER)
    const interrupted = { code: 'REPLICATION_OUTCOME_UNKNOWN', details: { reason: 'forward_interrupted' } }

    await expect(
      router.update(FAILING_LISTENER_INDEX, 'entry-1', { title: 'updated', amount: 3 }),
    ).rejects.toMatchObject(interrupted)
    await expect(router.remove(FAILING_LISTENER_INDEX, 'entry-2')).rejects.toMatchObject(interrupted)
    const batch = await router.updateBatch(FAILING_LISTENER_INDEX, [
      { docId: 'entry-3', document: { title: 'first', amount: 4 } },
      { docId: 'entry-4', document: { title: 'second', amount: 5 } },
    ])
    expect(batch.succeeded).toEqual([])
    expect(batch.failed.map(failure => failure.docId).sort()).toEqual(['entry-3', 'entry-4'])
    for (const failure of batch.failed) expect(failure.error).toMatchObject(interrupted)

    await sleep(LATE_CHUNK_WAIT_MS)
    expect(scripted.arrivals.map(message => documentIdsOf(message))).toEqual([
      ['entry-1'],
      ['entry-2'],
      ['entry-3', 'entry-4'],
    ])
  }, 60_000)
})

describe('a batch whose documents land in two partitions', () => {
  it('keeps the outcome of each partition when one partition holds a document that cannot be encoded', async () => {
    const running = await createTestCluster()
    cluster = running
    await running.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
    await running.start('node-a', { durable: false })
    await running.start('node-b', { durable: false })
    await running.node(ROUTER).createIndex('ledger', { schema: SCHEMA }, { partitionCount: 2, replicationFactor: 0 })

    const entries = ledgerEntries('entry', 20)
    const unencodable = { id: 'unencodable', title: 'nested', amount: 0, extra: nestedPastEncodingLimit() }
    const result = await running.node(ROUTER).insertBatch('ledger', [...entries, unencodable])

    const table = await running.coordinator.getAllocation('ledger')
    const stored = new Set<string>()
    for (const [partitionId, assignment] of table?.assignments ?? []) {
      if (assignment.primary === null) continue
      for (const docId of (await readCopy(running.probe, assignment.primary, partitionId, 'ledger')).keys()) {
        stored.add(docId)
      }
    }
    const everyId = [...entries.map(entry => entry.id), unencodable.id].sort()
    expect([...result.succeeded, ...result.failed.map(failure => failure.docId)].sort()).toEqual(everyId)
    expect(result.succeeded.length).toBeGreaterThan(0)
    expect([...stored].sort()).toEqual([...result.succeeded].sort())
    expect(result.failed.find(failure => failure.docId === unencodable.id)?.error.code).toBe('DOC_VALIDATION_FAILED')
  }, 60_000)

  it('stores every other write of a forwarded batch when one document of the same partition cannot be encoded', async () => {
    const running = await createTestCluster()
    cluster = running
    await running.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
    await running.start('node-a', { durable: false })
    await running.node(ROUTER).createIndex('ledger', { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })
    const primary = (await running.coordinator.getAllocation('ledger'))?.assignments.get(0)?.primary
    expect(primary).toBe('node-a')

    const entries = ledgerEntries('entry', 20)
    const unencodable = { id: 'unencodable', title: 'nested', amount: 0, extra: nestedPastEncodingLimit() }
    const result = await running
      .node(ROUTER)
      .insertBatch('ledger', [...entries.slice(0, 10), unencodable, ...entries.slice(10)])

    const stored = await readCopy(running.probe, 'node-a', 0, 'ledger')
    expect([...result.succeeded].sort()).toEqual(entries.map(entry => entry.id).sort())
    expect(result.failed.map(failure => [failure.docId, failure.error.code])).toEqual([
      [unencodable.id, 'DOC_VALIDATION_FAILED'],
    ])
    expect([...stored.keys()].sort()).toEqual(entries.map(entry => entry.id).sort())
    for (const { id, ...fields } of entries) expect(stored.get(id)).toEqual(fields)
  }, 60_000)
})
