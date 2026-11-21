import { decode, encode } from '@msgpack/msgpack'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { waitForActiveAllocation } from './cluster-harness'
import { peerRequest, replyBody, startTcpNodeWithPeer, type TcpNodeWithPeer } from './tcp-peer'

const INDEX = 'archive'
const SPEC_MAX_MESSAGE_BYTES = 67_108_864
const LARGE_DOCUMENT_COUNT = 5
const LARGE_FIELD_BYTES = 13 * 1_048_576
const UNREACHABLE_PEER_ADDRESS = '[::1]:1'

describe('the sync answer a primary streams to a replica whose log lags by more than one message', () => {
  let cluster: TcpNodeWithPeer
  const documentIds = Array.from({ length: LARGE_DOCUMENT_COUNT }, (_, at) => `scan-${at}`)

  beforeAll(async () => {
    cluster = await startTcpNodeWithPeer()
    await cluster.coordinator.registerNode({
      nodeId: 'peer',
      address: UNREACHABLE_PEER_ADDRESS,
      roles: ['data'],
      capacity: { memoryBytes: 1_000_000_000, cpuCores: 1, diskBytes: null },
      startedAt: new Date().toISOString(),
      version: '1.4',
    })
    await cluster.node.createIndex(INDEX, { schema: { title: 'string' } }, { partitionCount: 1, replicationFactor: 1 })
    const allocation = await waitForActiveAllocation(cluster.coordinator, INDEX)
    expect(allocation.assignments.get(0)?.replicas).toEqual(['peer'])
    for (const [at, documentId] of documentIds.entries()) {
      await cluster.node.insert(INDEX, { title: `scan ${at}`, pages: 'p'.repeat(LARGE_FIELD_BYTES) }, documentId)
    }
  }, 120_000)

  afterAll(async () => {
    await cluster.shutdown()
  })

  it('splits the entries into sync_entries batches that each fit the message limit, with isLast on the last alone', async () => {
    const frames: Uint8Array[] = []
    const request = peerRequest(
      'replication.sync_request',
      encode({ indexName: INDEX, partitionId: 0, lastSeqNo: 0, lastPrimaryTerm: 0 }),
    )
    await cluster.peer.stream(cluster.target, request, frame => {
      frames.push(frame)
    })

    const batches = frames.map(frame => {
      expect(frame.byteLength).toBeLessThanOrEqual(SPEC_MAX_MESSAGE_BYTES)
      return replyBody(frame)
    })
    expect(batches.filter(batch => batch.error !== undefined)).toEqual([])
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.map(batch => batch.isLast)).toEqual(batches.map((_, at) => at === batches.length - 1))

    const entries = batches.flatMap(batch => batch.entries as Array<Record<string, unknown>>)
    expect(entries.map(entry => entry.seqNo)).toEqual(documentIds.map((_, at) => at + 1))
    expect(entries.map(entry => entry.documentId)).toEqual(documentIds)
    for (const entry of entries) {
      const stored = decode(entry.document as Uint8Array) as Record<string, unknown>
      expect((stored.pages as string).length).toBe(LARGE_FIELD_BYTES)
    }
  }, 120_000)
})
