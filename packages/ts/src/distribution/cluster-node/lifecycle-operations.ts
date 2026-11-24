import { ErrorCodes, NarsilError } from '../../errors'
import type { ClusterNode } from './types'

export function bindNodeLifecycle(
  node: ClusterNode,
  stopping: AbortController,
  cancelStart: () => Promise<void>,
): () => void {
  const start = node.start.bind(node)
  const shutdown = node.shutdown.bind(node)
  let starting: Promise<void> | undefined
  let shuttingDown: Promise<void> | undefined
  let cancelling: Promise<void> | undefined

  function requireOpen(): void {
    if (stopping.signal.aborted) {
      throw new NarsilError(ErrorCodes.NODE_NOT_JOINED, `Cluster node '${node.nodeId}' has been shut down`, {
        nodeId: node.nodeId,
      })
    }
  }

  function begin(): void {
    if (stopping.signal.aborted) return
    stopping.abort()
    if (starting !== undefined) {
      cancelling = cancelStart()
      cancelling.catch(() => undefined)
    }
  }

  node.start = async () => {
    requireOpen()
    if (starting !== undefined) return starting
    const pending = Promise.resolve().then(start).then(requireOpen)
    starting = pending
    try {
      await pending
    } finally {
      starting = undefined
    }
  }

  node.shutdown = () => {
    if (shuttingDown !== undefined) return shuttingDown
    const completion = Promise.withResolvers<void>()
    shuttingDown = completion.promise
    begin()
    const finish = async (): Promise<void> => {
      await starting?.catch(() => undefined)
      await cancelling
      await shutdown()
    }
    void finish().then(completion.resolve, completion.reject)
    return shuttingDown
  }

  return begin
}
