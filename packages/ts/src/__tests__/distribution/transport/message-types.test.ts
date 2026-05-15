import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InMemoryNetwork, NodeTransport, TransportMessage } from '../../../distribution/transport'
import {
  ClusterMessageTypes,
  createInMemoryNetwork,
  createInMemoryTransport,
  QueryMessageTypes,
  ReplicationMessageTypes,
  TransportError,
  TransportErrorCodes,
} from '../../../distribution/transport'

function makeMessage(overrides: Partial<TransportMessage> = {}): TransportMessage {
  return {
    type: ClusterMessageTypes.PING,
    sourceId: 'node-a',
    requestId: 'req-001',
    payload: new Uint8Array([1, 2, 3]),
    ...overrides,
  }
}

function makeResponse(requestId: string, sourceId: string): TransportMessage {
  return {
    type: ClusterMessageTypes.PONG,
    sourceId,
    requestId,
    payload: new Uint8Array([4, 5, 6]),
  }
}

describe('Transport message types and realistic flows', () => {
  let network: InMemoryNetwork
  let transportA: NodeTransport
  let transportB: NodeTransport

  beforeEach(async () => {
    network = createInMemoryNetwork()
    transportA = createInMemoryTransport('node-a', network)
    transportB = createInMemoryTransport('node-b', network)

    await transportB.listen((message, respond) => {
      respond(makeResponse(message.requestId, 'node-b'))
    })
  })

  afterEach(async () => {
    await transportA.shutdown()
    await transportB.shutdown()
  })

  describe('message type constants', () => {
    it('defines all replication message types', () => {
      expect(ReplicationMessageTypes.FORWARD).toBe('replication.forward')
      expect(ReplicationMessageTypes.ENTRY).toBe('replication.entry')
      expect(ReplicationMessageTypes.ACK).toBe('replication.ack')
      expect(ReplicationMessageTypes.SYNC_REQUEST).toBe('replication.sync_request')
      expect(ReplicationMessageTypes.SYNC_ENTRIES).toBe('replication.sync_entries')
      expect(ReplicationMessageTypes.SNAPSHOT_START).toBe('replication.snapshot_start')
      expect(ReplicationMessageTypes.SNAPSHOT_CHUNK).toBe('replication.snapshot_chunk')
      expect(ReplicationMessageTypes.SNAPSHOT_END).toBe('replication.snapshot_end')
      expect(ReplicationMessageTypes.INSYNC_REMOVE).toBe('replication.insync_remove')
      expect(ReplicationMessageTypes.INSYNC_CONFIRM).toBe('replication.insync_confirm')
    })

    it('defines all query message types', () => {
      expect(QueryMessageTypes.SEARCH).toBe('query.search')
      expect(QueryMessageTypes.SEARCH_RESULT).toBe('query.search_result')
      expect(QueryMessageTypes.FETCH).toBe('query.fetch')
      expect(QueryMessageTypes.FETCH_RESULT).toBe('query.fetch_result')
      expect(QueryMessageTypes.STATS).toBe('query.stats')
      expect(QueryMessageTypes.STATS_RESULT).toBe('query.stats_result')
    })

    it('defines all cluster message types', () => {
      expect(ClusterMessageTypes.PING).toBe('cluster.ping')
      expect(ClusterMessageTypes.PONG).toBe('cluster.pong')
    })

    it('preserves message type through the transport', async () => {
      const allTypes = [
        ReplicationMessageTypes.FORWARD,
        ReplicationMessageTypes.ENTRY,
        QueryMessageTypes.SEARCH,
        QueryMessageTypes.FETCH,
        ClusterMessageTypes.PING,
      ]

      await transportB.listen((message, respond) => {
        respond({ ...message, sourceId: 'node-b' })
      })

      for (const messageType of allTypes) {
        const response = await transportA.send(
          'node-b',
          makeMessage({ type: messageType, requestId: `req-${messageType}` }),
        )
        expect(response.type).toBe(messageType)
      }
    })
  })

  describe('transport error codes', () => {
    it('defines all transport error codes', () => {
      expect(TransportErrorCodes.CONNECT_FAILED).toBe('TRANSPORT_CONNECT_FAILED')
      expect(TransportErrorCodes.TIMEOUT).toBe('TRANSPORT_TIMEOUT')
      expect(TransportErrorCodes.MESSAGE_TOO_LARGE).toBe('TRANSPORT_MESSAGE_TOO_LARGE')
      expect(TransportErrorCodes.DECODE_FAILED).toBe('TRANSPORT_DECODE_FAILED')
      expect(TransportErrorCodes.PEER_UNAVAILABLE).toBe('TRANSPORT_PEER_UNAVAILABLE')
    })

    it('creates TransportError with code, message, and details', () => {
      const error = new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'Node not found', { target: 'node-x' })

      expect(error.name).toBe('TransportError')
      expect(error.code).toBe('TRANSPORT_PEER_UNAVAILABLE')
      expect(error.message).toBe('Node not found')
      expect(error.details.target).toBe('node-x')
      expect(error).toBeInstanceOf(Error)
    })

    it('defaults details to empty object when not provided', () => {
      const error = new TransportError(TransportErrorCodes.TIMEOUT, 'Timed out')
      expect(error.details).toEqual({})
    })
  })

  describe('realistic message flows', () => {
    it('simulates a replication forward and ack cycle', async () => {
      const forwardPayload = new Uint8Array([10, 20, 30])
      const ackPayload = new Uint8Array([40, 50])

      await transportB.listen((message, respond) => {
        expect(message.type).toBe(ReplicationMessageTypes.FORWARD)
        respond({
          type: ReplicationMessageTypes.ACK,
          sourceId: 'node-b',
          requestId: message.requestId,
          payload: ackPayload,
        })
      })

      const response = await transportA.send('node-b', {
        type: ReplicationMessageTypes.FORWARD,
        sourceId: 'node-a',
        requestId: 'req-repl-001',
        payload: forwardPayload,
      })

      expect(response.type).toBe(ReplicationMessageTypes.ACK)
      expect(response.payload).toEqual(ackPayload)
    })

    it('simulates a search request and result cycle', async () => {
      const searchPayload = new Uint8Array([1, 2, 3, 4])
      const resultPayload = new Uint8Array([5, 6, 7, 8])

      await transportB.listen((message, respond) => {
        expect(message.type).toBe(QueryMessageTypes.SEARCH)
        respond({
          type: QueryMessageTypes.SEARCH_RESULT,
          sourceId: 'node-b',
          requestId: message.requestId,
          payload: resultPayload,
        })
      })

      const response = await transportA.send('node-b', {
        type: QueryMessageTypes.SEARCH,
        sourceId: 'node-a',
        requestId: 'req-search-001',
        payload: searchPayload,
      })

      expect(response.type).toBe(QueryMessageTypes.SEARCH_RESULT)
      expect(response.payload).toEqual(resultPayload)
    })

    it('simulates a snapshot stream transfer', async () => {
      const chunkSize = 64
      const totalChunks = 5
      const chunks: Uint8Array[] = []

      for (let i = 0; i < totalChunks; i++) {
        const chunk = new Uint8Array(chunkSize)
        chunk.fill(i + 1)
        chunks.push(chunk)
      }

      await transportB.listen((message, respond) => {
        expect(message.type).toBe(ReplicationMessageTypes.SNAPSHOT_START)
        for (const chunk of chunks) {
          respond({
            type: ReplicationMessageTypes.SNAPSHOT_CHUNK,
            sourceId: 'node-b',
            requestId: message.requestId,
            payload: chunk,
          })
        }
      })

      const receivedChunks: Uint8Array[] = []
      await transportA.stream(
        'node-b',
        {
          type: ReplicationMessageTypes.SNAPSHOT_START,
          sourceId: 'node-a',
          requestId: 'req-snapshot-001',
          payload: new Uint8Array(0),
        },
        chunk => {
          receivedChunks.push(chunk)
        },
      )

      expect(receivedChunks).toHaveLength(totalChunks)
      for (let i = 0; i < totalChunks; i++) {
        expect(receivedChunks[i]).toEqual(chunks[i])
      }
    })

    it('simulates ping/pong between three nodes', async () => {
      const transportC = createInMemoryTransport('node-c', network)

      await transportA.listen((message, respond) => {
        respond(makeResponse(message.requestId, 'node-a'))
      })

      await transportC.listen((message, respond) => {
        respond(makeResponse(message.requestId, 'node-c'))
      })

      const pingFromBtoA = await transportB.send('node-a', makeMessage({ sourceId: 'node-b', requestId: 'b-to-a' }))
      expect(pingFromBtoA.sourceId).toBe('node-a')

      const pingFromBtoC = await transportB.send('node-c', makeMessage({ sourceId: 'node-b', requestId: 'b-to-c' }))
      expect(pingFromBtoC.sourceId).toBe('node-c')

      const pingFromCtoA = await transportC.send('node-a', makeMessage({ sourceId: 'node-c', requestId: 'c-to-a' }))
      expect(pingFromCtoA.sourceId).toBe('node-a')

      await transportC.shutdown()
    })
  })
})
