import type { AllocationTable } from '../../../distribution/coordinator/types'

export interface PlacementExpectation {
  partitionCount: number
  replicationFactor: number
  dataNodeIds: readonly string[]
  absentNodeIds: readonly string[]
  balanced: boolean
}

function spreadOf(counts: Map<string, number>, nodeIds: readonly string[]): number {
  const values = nodeIds.map(nodeId => counts.get(nodeId) ?? 0)
  return Math.max(...values) - Math.min(...values)
}

function bump(counts: Map<string, number>, nodeId: string): void {
  counts.set(nodeId, (counts.get(nodeId) ?? 0) + 1)
}

export function placementFaults(table: AllocationTable | null, expected: PlacementExpectation): string[] {
  if (table === null) return ['the index holds no allocation table']
  const faults: string[] = []
  const live = new Set(expected.dataNodeIds)
  const replicaTarget = Math.min(expected.replicationFactor, expected.dataNodeIds.length - 1)
  const ids = [...table.assignments.keys()].sort((left, right) => left - right)
  const wanted = Array.from({ length: expected.partitionCount }, (_, at) => at)
  if (JSON.stringify(ids) !== JSON.stringify(wanted)) faults.push(`the table holds partitions ${ids.join(',')}`)
  const primaries = new Map<string, number>()
  const copies = new Map<string, number>()
  for (const [partitionId, assignment] of table.assignments) {
    const where = `partition ${partitionId}`
    const primary = assignment.primary
    if (assignment.state !== 'ACTIVE') faults.push(`${where} is ${assignment.state}`)
    if (primary === null || !live.has(primary)) faults.push(`${where} is led by ${String(primary)}`)
    if (new Set(assignment.replicas).size !== assignment.replicas.length) faults.push(`${where} repeats a replica`)
    if (primary !== null && assignment.replicas.includes(primary)) faults.push(`${where} copies its primary twice`)
    if (assignment.replicas.length !== replicaTarget) {
      faults.push(`${where} holds ${assignment.replicas.length} replicas, not ${replicaTarget}`)
    }
    for (const replica of assignment.replicas) {
      if (!live.has(replica)) faults.push(`${where} places a replica on ${replica}`)
      if (!assignment.inSyncSet.includes(replica))
        faults.push(`${where} has replica ${replica} outside its in-sync set`)
    }
    for (const member of assignment.inSyncSet) {
      if (member !== primary && !assignment.replicas.includes(member)) {
        faults.push(`${where} keeps ${member} in sync without a copy`)
      }
    }
    const named = [primary, ...assignment.replicas, ...assignment.inSyncSet, ...(assignment.lastHolders ?? [])]
    for (const absent of expected.absentNodeIds) {
      if (named.includes(absent)) faults.push(`${where} names ${absent}`)
    }
    if (primary !== null) {
      bump(primaries, primary)
      bump(copies, primary)
    }
    for (const replica of assignment.replicas) bump(copies, replica)
  }
  if (expected.balanced && spreadOf(primaries, expected.dataNodeIds) > 1) {
    faults.push(`the primaries spread unevenly: ${JSON.stringify([...primaries])}`)
  }
  if (expected.balanced && spreadOf(copies, expected.dataNodeIds) > 1) {
    faults.push(`the copies spread unevenly: ${JSON.stringify([...copies])}`)
  }
  return faults
}
