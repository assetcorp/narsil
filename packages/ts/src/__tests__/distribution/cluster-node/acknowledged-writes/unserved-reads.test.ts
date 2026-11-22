import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import type { NodeTransport } from '../../../../distribution/transport/types'
import {
  createTestCluster,
  INDEX,
  ofType,
  onLinksTo,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitForCopies,
  waitUntil,
} from './harness'

const LIST_LIMIT = 100

const READS_OF_ONE_PARTITION: Array<[string, (documentId: string) => Record<string, unknown>]> = [
  [
    'query.list',
    () => ({
      indexName: INDEX,
      partitionIds: [0],
      cursor: null,
      limit: LIST_LIMIT,
      filters: null,
      sort: null,
      fields: null,
    }),
  ],
  ['query.count', () => ({ indexName: INDEX, partitionIds: [0] })],
  ['query.fetch', documentId => ({ indexName: INDEX, documentIds: [{ docId: documentId, partitionId: 0 }] })],
]

async function answerOf(probe: NodeTransport, nodeId: string, type: string, payload: unknown) {
  const response = await probe.send(nodeId, {
    type,
    sourceId: 'copy-reader',
    requestId: `unserved-read-${nodeId}-${Date.now()}-${Math.random()}`,
    payload: encode(payload),
  })
  const decoded = decode(response.payload) as { code?: unknown }
  return response.type.endsWith('.error') ? { refused: decoded.code } : { answered: response.type }
}

describe('a node asked for a read that its copy of the partition cannot serve', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('refuses every read on a replica outside the in-sync set, which lacks a write the primary acknowledged', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start('node-a', { durable: false })
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    await waitForCopies(cluster.coordinator, 'node-a', [])
    await cluster.start('node-b', { durable: false })
    await waitForCopies(cluster.coordinator, 'node-a', ['node-b'])
    await cluster.node('node-a').insert(INDEX, { title: 'opening deposit', amount: 10 }, 'account-1')

    cluster.transport('node-a').dropWhen(onLinksTo(['node-b'], (_, message) => message.type.startsWith('replication.')))
    cluster.transport('node-b').dropWhen(ofType('replication.sync_request'))
    await cluster.node('node-a').insert(INDEX, { title: 'late deposit', amount: 20 }, 'account-2')
    await waitUntil('node-a to remove node-b from the in-sync set', async () => {
      const assignment = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return (
        assignment?.state === 'ACTIVE' &&
        assignment.replicas.includes('node-b') &&
        !assignment.inSyncSet.includes('node-b')
      )
    })

    expect(Object.fromEntries(await readCopy(cluster.probe, 'node-a'))).toEqual({
      'account-1': { title: 'opening deposit', amount: 10 },
      'account-2': { title: 'late deposit', amount: 20 },
    })
    for (const [type, payloadFor] of READS_OF_ONE_PARTITION) {
      expect(await answerOf(cluster.probe, 'node-b', type, payloadFor('account-2')), type).toEqual({
        refused: 'QUERY_NO_ACTIVE_REPLICA',
      })
    }
  }, 60_000)

  it('refuses every read on a primary whose partition is INITIALISING', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start('node-a', { durable: false })
    cluster.transport('node-a').dropWhen(ofType('cluster.bootstrap_complete'))
    await cluster
      .node('controller')
      .createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0, waitForServingMs: 0 })
    await waitUntil(
      'node-a to try reporting its finished bootstrap',
      () => cluster.transport('node-a').dropped().length > 0,
    )
    expect(partitionAssignment(await cluster.coordinator.getAllocation(INDEX))).toMatchObject({
      primary: 'node-a',
      state: 'INITIALISING',
    })

    for (const [type, payloadFor] of READS_OF_ONE_PARTITION) {
      expect(await answerOf(cluster.probe, 'node-a', type, payloadFor('account-1')), type).toEqual({
        refused: 'QUERY_NO_ACTIVE_REPLICA',
      })
    }
  }, 60_000)
})
