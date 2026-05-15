import type { Decider, DeciderContext, DeciderVerdict } from '../types'

export function createZoneDecider(zoneAttribute: string): Decider {
  return {
    name: 'zone',

    canAllocate(context: DeciderContext): DeciderVerdict {
      const { candidateNodeId, currentAssignment, nodes } = context

      const candidateNode = nodes.get(candidateNodeId)
      if (candidateNode === undefined) {
        return 'NO'
      }

      const candidateZone = candidateNode.metadata?.[zoneAttribute]
      if (candidateZone === undefined) {
        return 'YES'
      }

      if (currentAssignment === undefined) {
        return 'YES'
      }

      const assignedZones = new Set<string>()
      const allAssignedNodeIds: string[] = []

      if (currentAssignment.primary !== null) {
        allAssignedNodeIds.push(currentAssignment.primary)
      }
      for (const replicaId of currentAssignment.replicas) {
        allAssignedNodeIds.push(replicaId)
      }

      for (const assignedNodeId of allAssignedNodeIds) {
        const assignedNode = nodes.get(assignedNodeId)
        const zone = assignedNode?.metadata?.[zoneAttribute]
        if (zone !== undefined) {
          assignedZones.add(zone)
        }
      }

      if (!assignedZones.has(candidateZone)) {
        return 'YES'
      }

      const allZones = new Set<string>()
      for (const node of nodes.values()) {
        const zone = node.metadata?.[zoneAttribute]
        if (zone !== undefined) {
          allZones.add(zone)
        }
      }

      let hasUnrepresentedZone = false
      for (const zone of allZones) {
        if (!assignedZones.has(zone)) {
          hasUnrepresentedZone = true
          break
        }
      }

      if (hasUnrepresentedZone) {
        return 'THROTTLE'
      }

      return 'YES'
    },
  }
}
