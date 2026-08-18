import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import { createClusterLocalEngine } from '../../../distribution/cluster-node/local-engine'
import { handleFetch } from '../../../distribution/cluster-node/message-handler/queries'
import type { DataNodeHandlerDeps } from '../../../distribution/cluster-node/message-handler/types'
import type { FetchResultPayload, TransportMessage } from '../../../distribution/transport/types'
import { QueryMessageTypes } from '../../../distribution/transport/types'

const DIMENSION = 4

function makeFetchMessage(fields: string[] | null): TransportMessage {
  return {
    type: QueryMessageTypes.FETCH,
    sourceId: 'coordinator',
    requestId: 'fetch-req',
    payload: encode({
      indexName: 'products',
      documentIds: [{ docId: 'doc-1', partitionId: 0 }],
      fields,
      highlight: null,
    }),
  }
}

async function seedEngine() {
  const engine = await createClusterLocalEngine()
  await engine.createIndex('products', {
    schema: { title: 'string', description: 'string', price: 'number', embedding: `vector[${DIMENSION}]` },
  })
  await engine.insert(
    'products',
    { title: 'Zebra', description: 'a striped animal', price: 3, embedding: [0.1, 0.2, 0.3, 0.4] },
    'doc-1',
  )
  return engine
}

async function fetchWith(fields: string[] | null): Promise<FetchResultPayload> {
  const engine = await seedEngine()
  try {
    const deps = { nodeId: 'node-a', engine } as DataNodeHandlerDeps
    const responses: TransportMessage[] = []
    await handleFetch(
      makeFetchMessage(fields),
      async response => {
        responses.push(response)
      },
      deps,
    )
    expect(responses).toHaveLength(1)
    return decode(responses[0].payload) as FetchResultPayload
  } finally {
    await engine.shutdown()
  }
}

describe('a data node answering a fetch that names fields', () => {
  it('returns only the named fields', async () => {
    const payload = await fetchWith(['title', 'price'])

    expect(payload.documents).toHaveLength(1)
    expect(payload.documents[0].document).toEqual({ title: 'Zebra', price: 3 })
  })

  it('leaves the embedding out of the response, so it never crosses the wire', async () => {
    const payload = await fetchWith(['title'])

    expect(payload.documents[0].document.embedding).toBeUndefined()
  })

  it('returns the whole document when the fetch names no fields', async () => {
    const payload = await fetchWith(null)

    expect(payload.documents[0].document.title).toBe('Zebra')
    expect(payload.documents[0].document.description).toBe('a striped animal')
    expect(payload.documents[0].document.embedding).toBeDefined()
  })

  it('ignores a named field the document does not carry', async () => {
    const payload = await fetchWith(['title', 'absent'])

    expect(payload.documents[0].document).toEqual({ title: 'Zebra' })
  })
})
