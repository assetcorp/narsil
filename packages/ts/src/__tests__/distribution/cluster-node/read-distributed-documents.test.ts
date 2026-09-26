import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import type { ClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { readDistributedDocuments } from '../../../distribution/cluster-node/node-messaging'
import type { ClusterNodeConfig } from '../../../distribution/cluster-node/types'
import type { AllocationTable } from '../../../distribution/coordinator/types'
import { MAX_FETCH_DOCUMENT_IDS } from '../../../distribution/query/constants'
import type { TransportMessage } from '../../../distribution/transport/types'

const REMOTE_NODE = 'holder-remote'
const DOCUMENTS_READ = 25_000

function remoteOnlyAllocation(): AllocationTable {
  return {
    indexName: 'orders',
    version: 1,
    replicationFactor: 0,
    assignments: new Map([
      [
        0,
        {
          primary: REMOTE_NODE,
          replicas: [REMOTE_NODE],
          inSyncSet: [REMOTE_NODE],
          state: 'ACTIVE',
          primaryTerm: 1,
          commitPoint: 0,
        },
      ],
    ]),
  }
}

describe('reading documents from a remote holder', () => {
  it('splits a read above the fetch limit into messages the holder accepts', async () => {
    const fetchSizes: number[] = []
    const config = {
      coordinator: { listNodes: async () => [] },
      transport: {
        send: async (_target: string, message: TransportMessage): Promise<TransportMessage> => {
          const { documentIds } = decode(message.payload) as { documentIds: Array<{ docId: string }> }
          fetchSizes.push(documentIds.length)
          const documents = documentIds.map(({ docId }) => ({ docId, document: { id: docId }, highlights: null }))
          return {
            type: 'query.fetch.result',
            sourceId: REMOTE_NODE,
            requestId: message.requestId,
            payload: encode({ documents }),
          }
        },
      },
    } as unknown as ClusterNodeConfig
    const docIds = Array.from({ length: DOCUMENTS_READ }, (_, index) => `order-${index}`)

    const documents = await readDistributedDocuments(
      config,
      'router',
      {} as ClusterLocalEngine,
      'orders',
      docIds,
      remoteOnlyAllocation(),
    )

    expect(documents.size).toBe(DOCUMENTS_READ)
    expect(fetchSizes.length).toBe(Math.ceil(DOCUMENTS_READ / MAX_FETCH_DOCUMENT_IDS))
    expect(Math.max(...fetchSizes)).toBeLessThanOrEqual(MAX_FETCH_DOCUMENT_IDS)
  })
})
