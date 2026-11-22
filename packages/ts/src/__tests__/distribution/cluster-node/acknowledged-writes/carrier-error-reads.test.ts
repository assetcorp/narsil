import { afterEach, describe, expect, it } from 'vitest'
import { createInMemoryTransport } from '../../../../distribution/transport'
import type { NodeTransport, TransportMessage } from '../../../../distribution/transport/types'
import { NarsilError } from '../../../../errors'
import { createTestCluster, INDEX, SCHEMA, type TestCluster } from './harness'

const CONTROLLER = 'controller'
const FIRST_HOLDER = 'node-a'
const ROUTER = 'router'
const SCRIPTED = 'scripted-holder'
const LISTENER_FAILURE_TEXT = 'the listener failed while it read the copy'

const peers: NodeTransport[] = []
let cluster: TestCluster | undefined

afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.shutdown()
  await cluster?.dispose()
  cluster = undefined
})

function carrierFailure(message: TransportMessage): TransportMessage {
  return {
    type: 'error',
    sourceId: '',
    requestId: message.requestId,
    payload: new TextEncoder().encode(LISTENER_FAILURE_TEXT),
  }
}

async function routerBeforeFailingHolder(): Promise<TestCluster> {
  const running = await createTestCluster()
  cluster = running
  await running.start(CONTROLLER, { roles: ['controller', 'coordinator'], durable: false })
  await running.start(FIRST_HOLDER, { durable: false })
  await running.node(CONTROLLER).createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })
  await running.stop(CONTROLLER)
  await running.stop(FIRST_HOLDER)
  await running.start(ROUTER, { roles: ['coordinator'], durable: false })
  const table = await running.coordinator.getAllocation(INDEX)
  if (table === null) throw new Error(`${INDEX} has no allocation table`)
  const assignments = new Map(
    [...table.assignments].map(([partitionId, assignment]) => [
      partitionId,
      {
        ...assignment,
        primary: SCRIPTED,
        replicas: [SCRIPTED],
        inSyncSet: [],
        primaryTerm: assignment.primaryTerm + 1,
      },
    ]),
  )
  await running.coordinator.putAllocation(INDEX, { ...table, version: table.version + 1, assignments })
  const transport = createInMemoryTransport(SCRIPTED, running.network)
  peers.push(transport)
  await transport.listen(async (message, respond) => {
    if (message.type.startsWith('query.')) await respond(carrierFailure(message))
  })
  return running
}

async function failureOf(read: Promise<unknown>): Promise<unknown> {
  return read.then(
    answer => ({ answered: answer }),
    (error: unknown) => error,
  )
}

describe('a read whose only copy answers with a carrier error reply', () => {
  it('answers the client with a coded transport failure for a document fetch and for a scattered count', async () => {
    const running = await routerBeforeFailingHolder()
    const router = running.node(ROUTER)

    const reads: Array<[string, () => Promise<unknown>]> = [
      ['document fetch', () => router.get(INDEX, 'entry-1')],
      ['scattered count', () => router.countDocuments(INDEX)],
    ]
    for (const [label, read] of reads) {
      const failure = await failureOf(read())
      expect.soft(failure, label).toBeInstanceOf(NarsilError)
      expect.soft(failure, label).toMatchObject({
        code: 'QUERY_NO_ACTIVE_REPLICA',
        details: { targetNodeId: SCRIPTED, transportCode: 'TRANSPORT_PEER_UNAVAILABLE' },
      })
    }
  }, 60_000)
})
