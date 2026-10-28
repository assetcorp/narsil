import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import { readMemoryFigures } from '../../../distribution/cluster-node/memory/measure'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createForwardBatchMessage, createForwardMessage } from '../../../distribution/replication/codec'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { ReplicationMessageTypes } from '../../../distribution/transport/types'
import { ErrorCodes, NarsilError } from '../../../errors'
import { encodeDocument } from '../../../serialization/document-encoding'

const SCHEMA = { title: 'string', price: 'number' } as const
const HEAP_LIMIT_BYTES_PER_OVERSIZED_CHARACTER = 1_000
const OVERSIZED_WORD = 'ledger '

interface RealNode {
  node: ClusterNode
  transport: NodeTransport
}

const started: RealNode[] = []
const peers: NodeTransport[] = []
const coordinators: ClusterCoordinator[] = []

afterEach(async () => {
  for (const { node, transport } of started.splice(0)) {
    await node.shutdown()
    await transport.shutdown()
  }
  for (const peer of peers.splice(0)) await peer.shutdown()
  for (const coordinator of coordinators.splice(0)) await coordinator.shutdown()
})

function largeTable(serial: number): { title: string; price: number } {
  const heapLimitBytes = readMemoryFigures()?.heapLimitBytes
  if (heapLimitBytes === undefined) throw new Error('this process reports no heap limit')
  const words = Math.ceil(heapLimitBytes / HEAP_LIMIT_BYTES_PER_OVERSIZED_CHARACTER / OVERSIZED_WORD.length)
  return { title: `oak table ${serial} ${OVERSIZED_WORD.repeat(words)}`, price: serial }
}

function withoutErrorDetails(payload: Uint8Array): Uint8Array {
  const decoded = decode(payload)
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return payload
  }
  const { details: _details, ...reply } = decoded as Record<string, unknown>
  if (!Array.isArray(reply.results)) {
    return encode(reply)
  }
  const results = reply.results.map((result: unknown) => {
    if (result === null || typeof result !== 'object') return result
    const { errorDetails: _errorDetails, ...kept } = result as Record<string, unknown>
    return kept
  })
  return encode({ ...reply, results })
}

function repliesWithoutDetails(base: NodeTransport): NodeTransport {
  return {
    send: (target, message) => base.send(target, message),
    stream: (target, message, handler) => base.stream(target, message, handler),
    shutdown: () => base.shutdown(),
    listen: handler =>
      base.listen((message, respond) =>
        handler(message, reply =>
          respond(
            reply.type.endsWith('.error') || message.type === ReplicationMessageTypes.FORWARD_BATCH
              ? { ...reply, payload: withoutErrorDetails(reply.payload) }
              : reply,
          ),
        ),
      ),
  }
}

async function startPair(primaryTransport: (base: NodeTransport) => NodeTransport) {
  const coordinator = createInMemoryCoordinator()
  coordinators.push(coordinator)
  const network = createInMemoryNetwork()
  const primaryBase = createInMemoryTransport('node-a', network)
  const primary = await createClusterNode({
    coordinator,
    transport: primaryTransport(primaryBase),
    address: 'node-a:9200',
    nodeId: 'node-a',
    roles: ['data'],
    engine: { workers: { enabled: false } },
  })
  started.push({ node: primary, transport: primaryBase })
  await primary.start()
  const entryTransport = createInMemoryTransport('node-b', network)
  const entry = await createClusterNode({
    coordinator,
    transport: entryTransport,
    address: 'node-b:9200',
    nodeId: 'node-b',
    roles: ['data', 'coordinator', 'controller'],
    engine: { workers: { enabled: false } },
  })
  started.push({ node: entry, transport: entryTransport })
  await entry.start()
  await entry.createIndex('catalogue', { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })
  expect((await coordinator.getAllocation('catalogue'))?.assignments.get(0)?.primary).toBe('node-a')
  return { network, entry }
}

async function failureOf(work: Promise<unknown>): Promise<NarsilError | null> {
  try {
    await work
    return null
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
}

describe('a forwarded write keeps working between nodes that do and do not carry error details', () => {
  it('raises the primary code with the entry details when the primary replies without details', async () => {
    const { entry } = await startPair(repliesWithoutDetails)

    const single = await failureOf(entry.insert('catalogue', largeTable(1), 'table-1'))
    expect(single?.code).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)
    expect(single?.message).toContain("Node 'node-a' refuses this document")
    expect(single?.details).toEqual({ indexName: 'catalogue', primaryNodeId: 'node-a' })

    const batch = await entry.insertBatch('catalogue', [
      { id: 'table-2', ...largeTable(2) },
      { id: 'table-3', ...largeTable(3) },
    ])
    expect(batch.succeeded).toEqual([])
    expect(batch.failed.map(failure => failure.docId).sort()).toEqual(['table-2', 'table-3'])
    for (const failure of batch.failed) {
      expect(failure.error.code).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)
      expect(failure.error.details).toEqual({ indexName: 'catalogue', primaryNodeId: 'node-a' })
    }
    expect(await entry.countDocuments('catalogue')).toBe(0)
  }, 60_000)

  it('keeps every field that an older forwarding node reads, with the details beside them', async () => {
    const { network } = await startPair(base => base)
    const peer = createInMemoryTransport('peer-x', network)
    peers.push(peer)

    const single = decode(
      (
        await peer.send(
          'node-a',
          createForwardMessage(
            {
              indexName: 'catalogue',
              documentId: 'table-1',
              operation: 'insert',
              document: encodeDocument(largeTable(1)),
              updateFields: null,
            },
            'peer-x',
          ),
        )
      ).payload,
    ) as Record<string, unknown>
    expect(single.error).toBe(true)
    expect(single.code).toBe(ErrorCodes.CLUSTER_WRITE_BLOCKED)
    expect(typeof single.message).toBe('string')
    expect(single.details).toMatchObject({ reason: 'write_exceeds_memory', nodeId: 'node-a' })

    const batch = decode(
      (
        await peer.send(
          'node-a',
          createForwardBatchMessage(
            {
              indexName: 'catalogue',
              operations: [
                {
                  documentId: 'table-2',
                  operation: 'insert',
                  document: encodeDocument(largeTable(2)),
                  updateFields: null,
                },
                { documentId: 'table-3', operation: 'remove', document: null, updateFields: null },
              ],
            },
            'peer-x',
          ),
        )
      ).payload,
    ) as { results: Array<Record<string, unknown>> }
    expect(batch.results.map(result => [result.documentId, result.success, result.errorCode])).toEqual([
      ['table-2', false, ErrorCodes.CLUSTER_WRITE_BLOCKED],
      ['table-3', false, ErrorCodes.DOC_NOT_FOUND],
    ])
    expect(typeof batch.results[0].errorMessage).toBe('string')
    expect(batch.results[0].errorDetails).toMatchObject({ reason: 'write_exceeds_memory', nodeId: 'node-a' })
  }, 60_000)
})
