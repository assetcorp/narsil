import { encode } from '@msgpack/msgpack'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { localParamsToWire } from '../../../distribution/cluster-node/query-conversion'
import { waitForActiveAllocation } from './cluster-harness'
import { peerRequest, replyBody, startTcpNodeWithPeer, type TcpNodeWithPeer } from './tcp-peer'

const INDEX = 'shop'
const UNDECODABLE_PAYLOAD = new Uint8Array([0xc1])
const LONG_LABEL_LENGTH = 5_000
const LABEL_FIELDS = ['shelfLabel', 'aisleLabel', 'binLabel']
const FIRST_CJK_CODE_POINT = 0x4e00
const SPEC_LIST_CURSOR_LIMIT = 40_960
const SPEC_BATCH_OPERATION_LIMIT = 1_000

const ITEMS = [
  { id: 'item-1', title: 'portable grinder', category: 'kitchen', rank: 3 },
  { id: 'item-2', title: 'pour over kettle', category: 'kitchen', rank: 1 },
  { id: 'item-3', title: 'travel mug', category: 'travel', rank: 2 },
]

describe('what a hostile peer receives from a node over TCP', () => {
  let cluster: TcpNodeWithPeer

  beforeAll(async () => {
    cluster = await startTcpNodeWithPeer()
    await cluster.node.createIndex(
      INDEX,
      {
        schema: {
          title: 'string',
          category: 'string',
          rank: 'number',
          ...Object.fromEntries(LABEL_FIELDS.map(field => [field, 'string:sortable'])),
        },
      },
      { partitionCount: 1, replicationFactor: 0 },
    )
    await waitForActiveAllocation(cluster.coordinator, INDEX)
    for (const item of ITEMS) {
      await cluster.node.insert(INDEX, { title: item.title, category: item.category, rank: item.rank }, item.id)
    }
  }, 60_000)

  afterAll(async () => {
    await cluster.shutdown()
  })

  async function ask(type: string, payload: Uint8Array) {
    return cluster.peer.send(cluster.target, peerRequest(type, payload))
  }

  it('answers a cluster.ping sent to a bracketed IPv6 address with a cluster.pong that echoes the timestamp', async () => {
    const timestamp = Date.now()
    const response = await ask('cluster.ping', encode({ timestamp }))
    expect(response.type).toBe('cluster.pong')
    const pong = replyBody(response)
    expect(pong.timestamp).toBe(timestamp)
    expect(Number.isInteger(pong.respondedAt)).toBe(true)
    expect(pong.respondedAt).toBeGreaterThanOrEqual(timestamp)
  })

  it('answers a ping without a usable timestamp with an error reply', async () => {
    for (const payload of [encode({}), encode({ timestamp: -1 }), encode({ timestamp: 'now' })]) {
      const response = await ask('cluster.ping', payload)
      expect(response.type).toBe('cluster.ping.error')
      expect(replyBody(response).error).toBe(true)
    }
  })

  it('refuses an undecodable payload with TRANSPORT_DECODE_FAILED on every request type it serves', async () => {
    const types = [
      'query.search',
      'query.fetch',
      'query.stats',
      'query.count',
      'query.list',
      'replication.forward',
      'replication.forward_batch',
      'replication.entry',
      'replication.term_start',
      'cluster.partition_stores',
      'cluster.index_settings',
      'cluster.rebuild_analysis',
    ]
    for (const type of types) {
      const response = await ask(type, UNDECODABLE_PAYLOAD)
      expect(response.type, type).toBe(`${type}.error`)
      expect(replyBody(response).code, type).toBe('TRANSPORT_DECODE_FAILED')
    }
  })

  it('refuses malformed forwards and forward batches with REPLICATION_ENTRY_INVALID', async () => {
    const insertWithoutDocument = { indexName: INDEX, documentId: 'item-9', operation: 'insert' }
    const updateWithNeitherField = { indexName: INDEX, documentId: 'item-1', operation: 'update' }
    const forwards = [
      ['replication.forward', insertWithoutDocument],
      ['replication.forward', updateWithNeitherField],
      ['replication.forward', { ...updateWithNeitherField, updateFields: 'title' }],
      ['replication.forward_batch', { indexName: INDEX, operations: [] }],
      [
        'replication.forward_batch',
        {
          indexName: INDEX,
          operations: Array.from({ length: SPEC_BATCH_OPERATION_LIMIT + 1 }, (_, at) => ({
            documentId: `bulk-${at}`,
            operation: 'insert',
            document: encode({ title: `bulk ${at}` }),
          })),
        },
      ],
      ['replication.forward_batch', { indexName: INDEX, operations: [{ documentId: 'item-9', operation: 'insert' }] }],
    ] as const
    for (const [type, payload] of forwards) {
      const response = await ask(type, encode(payload))
      expect(response.type).toBe(`${type}.error`)
      expect(replyBody(response).code).toBe('REPLICATION_ENTRY_INVALID')
    }
    expect(await cluster.node.has(INDEX, 'bulk-0')).toBe(false)
    expect(await cluster.node.has(INDEX, 'item-9')).toBe(false)
  })

  it('answers malformed control requests with an error reply in place of a success reply', async () => {
    const requests = [
      ['cluster.partition_stores', {}],
      ['cluster.index_settings', { indexName: INDEX }],
      ['cluster.bootstrap_complete', { indexName: INDEX }],
      ['replication.insync_add', { indexName: INDEX, partitionId: 0 }],
      ['replication.insync_remove', {}],
      ['replication.primary_resign', { partitionId: 'zero' }],
    ] as const
    for (const [type, payload] of requests) {
      const response = await ask(type, encode(payload))
      expect(response.type, type).toBe(`${type}.error`)
      const reply = replyBody(response)
      expect(reply.error, type).toBe(true)
      expect(reply.partitionId, type).toBeUndefined()
    }
  })

  it('reads list sort values from the stored document when the fields leave the sort field out', async () => {
    const response = await ask(
      'query.list',
      encode({
        indexName: INDEX,
        partitionIds: [0],
        limit: 10,
        sort: [{ field: 'rank', direction: 'asc' }],
        fields: ['title'],
      }),
    )
    expect(response.type).toBe('query.list_result')
    const entries = replyBody(response).entries as Array<Record<string, unknown>>
    const byRank = [...ITEMS].sort((left, right) => left.rank - right.rank)
    expect(entries.map(entry => entry.docId)).toEqual(byRank.map(item => item.id))
    expect(entries.map(entry => entry.sortValues)).toEqual(byRank.map(item => [item.rank]))
    expect(entries.map(entry => entry.document)).toEqual(byRank.map(item => ({ title: item.title })))
  })

  it('serves the next listing page from a cursor longer than 4,096 characters', async () => {
    for (let at = 0; at < 3; at++) {
      const label = String.fromCodePoint(FIRST_CJK_CODE_POINT + at) + '字'.repeat(LONG_LABEL_LENGTH)
      const labels = Object.fromEntries(LABEL_FIELDS.map(field => [field, label]))
      await cluster.node.insert(INDEX, { title: `labelled ${at}`, ...labels }, `labelled-${at}`)
    }
    const sort = LABEL_FIELDS.map(field => ({ field, direction: 'asc' as const }))
    const firstPage = await cluster.node.listDocuments(INDEX, { limit: 1, sort })
    expect(firstPage.documents.map(entry => entry.id)).toEqual(['labelled-0'])
    const cursor = firstPage.cursor
    expect(cursor).not.toBeNull()
    expect(cursor?.length).toBeGreaterThan(4_096)
    expect(cursor?.length).toBeLessThanOrEqual(SPEC_LIST_CURSOR_LIMIT)

    const response = await ask(
      'query.list',
      encode({
        indexName: INDEX,
        partitionIds: [0],
        cursor,
        limit: 1,
        sort,
        fields: null,
      }),
    )
    expect(response.type).toBe('query.list_result')
    const entries = replyBody(response).entries as Array<Record<string, unknown>>
    expect(entries.map(entry => entry.docId)).toEqual(['labelled-1'])
  })

  it('accepts a fetch and a grouped search whose nested structures leave optional keys out', async () => {
    const fetched = await ask(
      'query.fetch',
      encode({ indexName: INDEX, documentIds: [{ docId: 'item-1', partitionId: 0 }] }),
    )
    expect(fetched.type).toBe('query.fetch_result')
    const documents = replyBody(fetched).documents as Array<Record<string, unknown>>
    expect(documents.map(entry => entry.docId)).toEqual(['item-1'])

    const params: Record<string, unknown> = { ...localParamsToWire({ term: 'kettle mug grinder', limit: 10 }) }
    params.group = { fields: ['category'], maxPerGroup: 1 }
    const searched = await ask('query.search', encode({ indexName: INDEX, partitionIds: [0], params }))
    expect(searched.type).toBe('query.search_result')
    const groups = replyBody(searched).groups as Array<Record<string, unknown>>
    expect(groups.length).toBe(2)
  })
})
