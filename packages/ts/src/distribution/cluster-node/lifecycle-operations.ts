import { ErrorCodes, NarsilError } from '../../errors'

export interface NodeLifecycleCalls {
  start(run: () => Promise<void>): Promise<void>
  shutdown(run: () => Promise<void>): Promise<void>
  begin(): void
}

export function createNodeLifecycleCalls(
  nodeId: string,
  stopping: AbortController,
  cancelStart: () => Promise<void>,
): NodeLifecycleCalls {
  let starting: Promise<void> | undefined
  let shuttingDown: Promise<void> | undefined
  let cancelling: Promise<void> | undefined

  function requireOpen(): void {
    if (stopping.signal.aborted) {
      throw new NarsilError(ErrorCodes.NODE_NOT_JOINED, `Cluster node '${nodeId}' has been shut down`, { nodeId })
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

  return {
    async start(run) {
      requireOpen()
      if (starting !== undefined) return starting
      const pending = Promise.resolve().then(run).then(requireOpen)
      starting = pending
      try {
        await pending
      } finally {
        starting = undefined
      }
    },
    shutdown(run) {
      if (shuttingDown !== undefined) return shuttingDown
      const completion = Promise.withResolvers<void>()
      shuttingDown = completion.promise
      begin()
      const finish = async (): Promise<void> => {
        await starting?.catch(() => undefined)
        await cancelling
        await run()
      }
      void finish().then(completion.resolve, completion.reject)
      return shuttingDown
    },
    begin,
  }
}
