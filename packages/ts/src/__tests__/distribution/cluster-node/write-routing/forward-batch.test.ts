import { decode, encode } from '@msgpack/msgpack'
import { describe, expect, it } from 'vitest'
import {
  type ForwardBatchItem,
  forwardBatchToRemote,
} from '../../../../distribution/cluster-node/write-routing/forward-batch'
import type { WriteRoutingDeps } from '../../../../distribution/cluster-node/write-routing/types'
import {
  createForwardBatchResultMessage,
  validateForwardBatchPayload,
} from '../../../../distribution/replication/codec'
import type {
  ForwardBatchOperationResult,
  ForwardBatchPayload,
  NodeTransport,
  TransportMessage,
} from '../../../../distribution/transport/types'
import { ReplicationMessageTypes } from '../../../../distribution/transport/types'

function successResults(payload: ForwardBatchPayload): ForwardBatchOperationResult[] {
  return payload.operations.map(operation => ({
    documentId: operation.documentId,
    success: true,
    errorCode: null,
    errorMessage: null,
  }))
}

function stubDeps(
  respond: (payload: ForwardBatchPayload, message: TransportMessage) => TransportMessage,
  sentPayloads: ForwardBatchPayload[],
): WriteRoutingDeps {
  const transport: NodeTransport = {
    async send(_target: string, message: TransportMessage): Promise<TransportMessage> {
      const payload = validateForwardBatchPayload(decode(message.payload))
      sentPayloads.push(payload)
      return respond(payload, message)
    },
    async stream(): Promise<void> {
      throw new Error('stream is not part of this test')
    },
    async listen(): Promise<() => void> {
      return () => undefined
    },
    async shutdown(): Promise<void> {
      return undefined
    },
  }
  return {
    nodeId: 'sender',
    transport,
    resolveNodeTargets: async (targetNodeId: string) => [targetNodeId],
  } as unknown as WriteRoutingDeps
}

function insertItems(count: number, documentBytes = 10): ForwardBatchItem[] {
  return Array.from({ length: count }, (_, index) => ({
    documentId: `doc-${index}`,
    operation: 'insert' as const,
    document: { title: 'x'.repeat(documentBytes) },
  }))
}

describe('forwardBatchToRemote', () => {
  it('splits a batch above the operation count limit into several messages', async () => {
    const sentPayloads: ForwardBatchPayload[] = []
    const deps = stubDeps(
      (payload, message) =>
        createForwardBatchResultMessage({ results: successResults(payload) }, 'primary', message.requestId),
      sentPayloads,
    )

    const result = await forwardBatchToRemote('products', insertItems(1_500), 'primary', deps)

    expect(result.failed).toEqual([])
    expect(result.succeeded).toHaveLength(1_500)
    expect(sentPayloads).toHaveLength(2)
    expect(sentPayloads[0].operations).toHaveLength(1_000)
    expect(sentPayloads[1].operations).toHaveLength(500)
  })

  it('splits a batch above the byte budget into several messages', async () => {
    const sentPayloads: ForwardBatchPayload[] = []
    const deps = stubDeps(
      (payload, message) =>
        createForwardBatchResultMessage({ results: successResults(payload) }, 'primary', message.requestId),
      sentPayloads,
    )

    const threeMegabytes = 3 * 1_024 * 1_024
    const result = await forwardBatchToRemote('products', insertItems(3, threeMegabytes), 'primary', deps)

    expect(result.failed).toEqual([])
    expect(sentPayloads).toHaveLength(2)
    expect(sentPayloads[0].operations).toHaveLength(2)
    expect(sentPayloads[1].operations).toHaveLength(1)
  })

  it('fails every document of a chunk whose response length does not match', async () => {
    const sentPayloads: ForwardBatchPayload[] = []
    const deps = stubDeps(
      (payload, message) =>
        createForwardBatchResultMessage({ results: successResults(payload).slice(1) }, 'primary', message.requestId),
      sentPayloads,
    )

    const result = await forwardBatchToRemote('products', insertItems(3), 'primary', deps)

    expect(result.succeeded).toEqual([])
    expect(result.failed).toHaveLength(3)
  })

  it('carries per-document failures back with their error codes', async () => {
    const sentPayloads: ForwardBatchPayload[] = []
    const deps = stubDeps((payload, message) => {
      const results = successResults(payload)
      results[1] = {
        documentId: results[1].documentId,
        success: false,
        errorCode: 'DOC_NOT_FOUND',
        errorMessage: 'missing',
      }
      return createForwardBatchResultMessage({ results }, 'primary', message.requestId)
    }, sentPayloads)

    const result = await forwardBatchToRemote('products', insertItems(3), 'primary', deps)

    expect(result.succeeded).toEqual(['doc-0', 'doc-2'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].docId).toBe('doc-1')
    expect(result.failed[0].error.code).toBe('DOC_NOT_FOUND')
  })

  it('fails every document of a chunk answered with an error message', async () => {
    const sentPayloads: ForwardBatchPayload[] = []
    const deps = stubDeps(
      (_payload, message) => ({
        type: `${ReplicationMessageTypes.FORWARD_BATCH}.error`,
        sourceId: 'primary',
        requestId: message.requestId,
        payload: encode({ error: true, code: 'PARTITION_NOT_PRIMARY', message: 'moved' }),
      }),
      sentPayloads,
    )

    const result = await forwardBatchToRemote('products', insertItems(3), 'primary', deps)

    expect(result.succeeded).toEqual([])
    expect(result.failed).toHaveLength(3)
    expect(result.failed[0].error.code).toBe('PARTITION_NOT_PRIMARY')
  })
})

describe('validateForwardBatchPayload', () => {
  function wireOperations(): ForwardBatchPayload {
    return {
      indexName: 'products',
      operations: [
        { documentId: 'doc-1', operation: 'insert', document: encode({ title: 'a' }), updateFields: null },
        { documentId: 'doc-2', operation: 'remove', document: null, updateFields: null },
        { documentId: 'doc-3', operation: 'update', document: encode({ title: 'b' }), updateFields: null },
      ],
    }
  }

  it('accepts a mixed batch round-tripped through MessagePack', () => {
    const validated = validateForwardBatchPayload(decode(encode(wireOperations())))
    expect(validated.operations).toHaveLength(3)
  })

  it('rejects an empty batch', () => {
    expect(() => validateForwardBatchPayload({ indexName: 'products', operations: [] })).toThrow('must not be empty')
  })

  it('rejects an insert without a document', () => {
    const payload = wireOperations()
    payload.operations[0].document = null
    expect(() => validateForwardBatchPayload(decode(encode(payload)))).toThrow('requires a document')
  })

  it('rejects an update with neither a document nor update fields', () => {
    const payload = wireOperations()
    payload.operations[2].document = null
    expect(() => validateForwardBatchPayload(decode(encode(payload)))).toThrow('requires a document or updateFields')
  })

  it('rejects an unknown operation', () => {
    const payload = wireOperations() as unknown as { operations: Array<{ operation: string }> }
    payload.operations[1].operation = 'upsert'
    expect(() => validateForwardBatchPayload(decode(encode(payload)))).toThrow(
      'must be "insert", "remove", or "update"',
    )
  })

  it('rejects a batch above the operation count limit', () => {
    const payload: ForwardBatchPayload = {
      indexName: 'products',
      operations: Array.from({ length: 1_001 }, (_, index) => ({
        documentId: `doc-${index}`,
        operation: 'remove' as const,
        document: null,
        updateFields: null,
      })),
    }
    expect(() => validateForwardBatchPayload(decode(encode(payload)))).toThrow('exceeds maximum length')
  })
})
