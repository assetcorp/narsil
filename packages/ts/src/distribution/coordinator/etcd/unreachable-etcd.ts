import { ErrorCodes, NarsilError } from '../../../errors'
import type { ClusterCoordinator } from '../types'

function unreachableEtcdOf(error: unknown, operation: string, isRecoverable: (error: Error) => boolean): unknown {
  if (!(error instanceof Error) || error instanceof NarsilError || !isRecoverable(error)) return error
  return new NarsilError(
    ErrorCodes.COORDINATOR_UNAVAILABLE,
    `The coordinator reached no etcd endpoint for ${operation}: ${error.message}`,
    { operation },
  )
}

export function refusingUnreachableEtcdAsUnavailable(
  coordinator: ClusterCoordinator,
  isRecoverable: (error: Error) => boolean,
): ClusterCoordinator {
  const wrapped = new Map<string, unknown>()
  return new Proxy(coordinator, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || typeof property !== 'string') return value
      const held = wrapped.get(property)
      if (held !== undefined) return held
      const call = (...args: unknown[]): unknown => {
        const result: unknown = value.apply(target, args)
        if (!(result instanceof Promise)) return result
        return result.catch((error: unknown) => {
          throw unreachableEtcdOf(error, property, isRecoverable)
        })
      }
      wrapped.set(property, call)
      return call
    },
  })
}
