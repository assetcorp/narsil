import type { Narsil } from '../../../narsil'
import type { ClusterCoordinator, NodeRole } from '../../coordinator/types'
import type { NodeTransport } from '../../transport/types'

export interface ClusterNodeDeps {
  nodeId: string
  roles: ReadonlyArray<NodeRole>
  coordinator: ClusterCoordinator
  transport: NodeTransport
  engine: Narsil
  address: string
}
