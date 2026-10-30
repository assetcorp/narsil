import type { AllocationEvent, ClusterCoordinator, NodeRegistration } from '../../../../distribution/coordinator/types'

export interface FaultyCoordinator extends ClusterCoordinator {
  refuseRegistrationOf(nodeId: string): () => void
  cutOff(): () => void
  delayAllocationEvents(delayMs: number): () => void
}

export function faultyCoordinator(inner: ClusterCoordinator): FaultyCoordinator {
  const refused = new Set<string>()
  let unreachable = false
  let eventDelayMs = 0
  return new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'refuseRegistrationOf') {
        return (nodeId: string) => {
          refused.add(nodeId)
          return () => refused.delete(nodeId)
        }
      }
      if (property === 'cutOff') {
        return () => {
          unreachable = true
          return () => {
            unreachable = false
          }
        }
      }
      if (property === 'delayAllocationEvents') {
        return (delayMs: number) => {
          eventDelayMs = delayMs
          return () => {
            eventDelayMs = 0
          }
        }
      }
      const value = Reflect.get(target, property, receiver)
      if (unreachable && typeof value === 'function' && property !== 'shutdown') {
        return async () => {
          throw new Error(`the coordinator is unreachable, so ${String(property)} failed`)
        }
      }
      if (property === 'registerNode') {
        return async (registration: NodeRegistration) => {
          if (refused.has(registration.nodeId)) {
            throw new Error(`the coordinator cannot reach ${registration.nodeId}`)
          }
          return target.registerNode(registration)
        }
      }
      if (property === 'watchAllocation') {
        return (handler: (event: AllocationEvent) => void) =>
          target.watchAllocation(event => {
            if (eventDelayMs === 0) handler(event)
            else setTimeout(() => handler(event), eventDelayMs)
          })
      }
      return value
    },
  }) as FaultyCoordinator
}
