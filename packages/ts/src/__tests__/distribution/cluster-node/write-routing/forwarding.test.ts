import { describe, expect, it } from 'vitest'
import { forwardInsertToRemote } from '../../../../distribution/cluster-node/write-routing/forwarding'
import type { WriteRoutingDeps } from '../../../../distribution/cluster-node/write-routing/types'
import type { NodeTransport } from '../../../../distribution/transport/types'
import { TransportError, TransportErrorCodes } from '../../../../distribution/transport/types'
import { ErrorCodes, NarsilError } from '../../../../errors'

function depsFailingWith(error: Error): WriteRoutingDeps {
  const transport: NodeTransport = {
    async send(): Promise<never> {
      throw error
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

describe('forwarding a write to an unreachable primary', () => {
  it('maps an unreachable peer to QUERY_NO_ACTIVE_REPLICA', async () => {
    const deps = depsFailingWith(
      new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, "Node 'primary' is not reachable"),
    )

    const failure = await forwardInsertToRemote('products', { title: 'a' }, 'doc-1', 'primary', deps).then(
      () => null,
      caught => caught,
    )

    expect(failure).toBeInstanceOf(NarsilError)
    expect((failure as NarsilError).code).toBe(ErrorCodes.QUERY_NO_ACTIVE_REPLICA)
    expect((failure as NarsilError).details.transportCode).toBe(TransportErrorCodes.PEER_UNAVAILABLE)
  })

  it('maps a transport timeout to QUERY_NODE_TIMEOUT', async () => {
    const deps = depsFailingWith(new TransportError(TransportErrorCodes.TIMEOUT, 'Request timed out'))

    const failure = await forwardInsertToRemote('products', { title: 'a' }, 'doc-1', 'primary', deps).then(
      () => null,
      caught => caught,
    )

    expect(failure).toBeInstanceOf(NarsilError)
    expect((failure as NarsilError).code).toBe(ErrorCodes.QUERY_NODE_TIMEOUT)
  })

  it('leaves an error that is not a transport failure unchanged', async () => {
    const plain = new Error('unrelated failure')
    const deps = depsFailingWith(plain)

    const failure = await forwardInsertToRemote('products', { title: 'a' }, 'doc-1', 'primary', deps).then(
      () => null,
      caught => caught,
    )

    expect(failure).toBe(plain)
  })
})
