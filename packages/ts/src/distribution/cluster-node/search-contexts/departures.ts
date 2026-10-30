import type { ClusterCoordinator } from '../../coordinator/types'
import type { SearchContextRegistry } from './registry'

export function releaseContextsOfDepartedNodes(
  coordinator: ClusterCoordinator,
  registry: SearchContextRegistry,
): Promise<() => void> {
  return coordinator.watchNodes(event => {
    if (event.type === 'node_left') registry.releaseCoordinator(event.nodeId)
  })
}
