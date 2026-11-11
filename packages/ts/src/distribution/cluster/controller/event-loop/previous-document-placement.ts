import type { ClusterCoordinator, NodeRegistration } from '../../../coordinator/types'
import { readIndexMetadataSnapshot } from '../../index-metadata'
import { isHiddenGeneration, readRebalanceRecord } from '../../rebalance/records'
import { CHANGE_CAPTURE_SPEC_VERSION, reachesVersion } from '../../version'

export type NodesForIndex = (indexName: string) => NodeRegistration[]

async function recordsPreviousDocuments(coordinator: ClusterCoordinator, indexName: string): Promise<boolean> {
  try {
    const changes = (await readIndexMetadataSnapshot(coordinator, indexName))?.settings?.changes
    return changes?.enabled === true && changes.previousDocument === true
  } catch {
    return true
  }
}

async function namesRecordingPreviousDocuments(
  coordinator: ClusterCoordinator,
  indexNames: Iterable<string>,
): Promise<Set<string>> {
  const recording = new Set<string>()
  for (const indexName of indexNames) {
    if (isHiddenGeneration(indexName) || !(await recordsPreviousDocuments(coordinator, indexName))) continue
    recording.add(indexName)
    const generation = (await coordinator.getAllocation(indexName))?.generation
    if (generation !== undefined) recording.add(generation)
    const record = await readRebalanceRecord(coordinator, indexName)
    if (record !== null) {
      recording.add(record.sourceGeneration)
      recording.add(record.targetGeneration)
    }
  }
  return recording
}

export async function nodesForEachIndex(
  coordinator: ClusterCoordinator,
  nodes: NodeRegistration[],
  indexNames: Iterable<string>,
): Promise<NodesForIndex> {
  const capable = nodes.filter(node => reachesVersion(node.version, CHANGE_CAPTURE_SPEC_VERSION))
  if (capable.length === nodes.length) return () => nodes
  const recording = await namesRecordingPreviousDocuments(coordinator, indexNames)
  return indexName => (recording.has(indexName) ? capable : nodes)
}
