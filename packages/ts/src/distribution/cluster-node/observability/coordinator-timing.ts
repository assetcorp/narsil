import type { ClusterCoordinator } from '../../coordinator/types'
import { COORDINATOR_REQUEST_BUCKET_BOUNDS_SECONDS } from '../constants'
import type { CoordinatorRequestFigure } from '../types/observability'

const MILLISECONDS_PER_SECOND = 1_000

interface OperationTiming {
  bucketCounts: number[]
  count: number
  sumSeconds: number
}

export interface CoordinatorTiming {
  record(operation: string, elapsedSeconds: number): void
  figures(): CoordinatorRequestFigure[]
}

export function createCoordinatorTiming(): CoordinatorTiming {
  const operations = new Map<string, OperationTiming>()
  return {
    record(operation, elapsedSeconds) {
      let timing = operations.get(operation)
      if (timing === undefined) {
        timing = { bucketCounts: COORDINATOR_REQUEST_BUCKET_BOUNDS_SECONDS.map(() => 0), count: 0, sumSeconds: 0 }
        operations.set(operation, timing)
      }
      COORDINATOR_REQUEST_BUCKET_BOUNDS_SECONDS.forEach((bound, position) => {
        if (elapsedSeconds <= bound && timing !== undefined) timing.bucketCounts[position] += 1
      })
      timing.count += 1
      timing.sumSeconds += elapsedSeconds
    },
    figures() {
      return [...operations.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([operation, timing]) => ({
          operation,
          bucketBoundsSeconds: [...COORDINATOR_REQUEST_BUCKET_BOUNDS_SECONDS],
          bucketCounts: [...timing.bucketCounts],
          count: timing.count,
          sumSeconds: timing.sumSeconds,
        }))
    },
  }
}

export function timeCoordinatorCalls(coordinator: ClusterCoordinator, timing: CoordinatorTiming): ClusterCoordinator {
  const wrapped = new Map<PropertyKey, unknown>()
  return new Proxy(coordinator, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function' || typeof property !== 'string') return value
      const held = wrapped.get(property)
      if (held !== undefined) return held
      const call = (...args: unknown[]): unknown => {
        const started = performance.now()
        const result: unknown = value.apply(target, args)
        if (!(result instanceof Promise)) return result
        const settle = (): void => timing.record(property, (performance.now() - started) / MILLISECONDS_PER_SECOND)
        result.then(settle, settle)
        return result
      }
      wrapped.set(property, call)
      return call
    },
  })
}
