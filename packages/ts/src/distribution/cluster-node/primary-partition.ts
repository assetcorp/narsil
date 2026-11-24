import { ErrorCodes, NarsilError } from '../../errors'
import { validateSchema } from '../../schema/validator'
import type { IndexConfig } from '../../types/schema'
import { getClusterIndexConfig, getIndexMetadata } from '../cluster/index-metadata'
import { withPartitionCount } from '../cluster/index-settings'
import { lastHoldersOf } from '../cluster/last-holders'
import type { ClusterCoordinator, PartitionAssignment } from '../coordinator/types'
import { validateRestoredSchema } from './bootstrap-restore'
import type { ClusterLocalEngine } from './local-engine'
import { numberingFloor } from './local-replication'

export interface PrimaryPartitionDeps {
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  nodeId: string
  seedReplicationLog: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm: number) => void
  replicationLogPosition: (indexName: string, partitionId: number) => number
  canListCopy: (indexName: string, indexUuid: string | undefined, partitionId: number) => Promise<boolean>
  failMissingCopy: (indexName: string, partitionId: number) => void
  onError: (error: unknown) => void
}

/**
 * Readies this node to take writes for a partition it leads, and reports whether it can.
 *
 * The node creates the index where it holds no copy, and it checks a copy it already holds against the schema the
 * cluster keeps. A node the controller promoted back after every copy of the partition was lost numbers its next
 * entry above both the commit point the controller stored and everything that the node's write-ahead log holds, so a
 * replica that returns can still reach that commit point. Where that node lacks the copy, it fails the copy and
 * creates nothing, so that the other last holders stay on record.
 *
 * @param indexName - The index the partition belongs to.
 * @param partitionId - The partition this node leads.
 * @param deps - The engine, the coordinator, this node's id, and the replication log this node writes.
 * @returns True where the node can serve the partition as primary.
 */
export async function preparePrimaryPartition(
  indexName: string,
  partitionId: number,
  deps: PrimaryPartitionDeps,
): Promise<boolean> {
  const storedSchema = await deps.coordinator.getSchema(indexName)
  if (storedSchema === null) {
    return false
  }
  let config: IndexConfig
  let indexUuid: string | undefined
  try {
    config = await getClusterIndexConfig(deps.coordinator, indexName, validateSchema(storedSchema))
    indexUuid = (await getIndexMetadata(deps.coordinator, indexName))?.indexUuid
  } catch (error) {
    deps.onError(error)
    return false
  }
  const allocation = await deps.coordinator.getAllocation(indexName)
  if (allocation === null || allocation.assignments.size === 0) {
    return false
  }
  if (
    promotedFromLastHolders(allocation.assignments.get(partitionId), deps.nodeId) &&
    !(await deps.canListCopy(indexName, indexUuid, partitionId))
  ) {
    if (indexUuid !== undefined) deps.failMissingCopy(indexName, partitionId)
    return false
  }

  const existing = deps.engine.listIndexes().find(index => index.name === indexName)
  if (existing === undefined) {
    try {
      await deps.engine.createIndexWithUuid(
        indexName,
        withPartitionCount(config, allocation.assignments.size),
        indexUuid,
      )
    } catch (error) {
      if (!(error instanceof NarsilError) || error.code !== ErrorCodes.INDEX_ALREADY_EXISTS) {
        deps.onError(error)
        return false
      }
    }
  } else {
    const schemaError = validateRestoredSchema(deps.engine, indexName, deps.nodeId, config.schema)
    if (schemaError !== null) {
      deps.onError(schemaError)
      return false
    }
  }

  resumeNumberingAboveOwnCopy(indexName, partitionId, allocation.assignments.get(partitionId), deps)
  return true
}

function promotedFromLastHolders(assignment: PartitionAssignment | undefined, nodeId: string): boolean {
  return (
    assignment !== undefined &&
    assignment.state === 'INITIALISING' &&
    assignment.primary === nodeId &&
    lastHoldersOf(assignment).length > 0
  )
}

function resumeNumberingAboveOwnCopy(
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment | undefined,
  deps: PrimaryPartitionDeps,
): void {
  if (assignment === undefined) {
    return
  }
  if (deps.replicationLogPosition(indexName, partitionId) > 0) {
    return
  }
  const floor = numberingFloor(deps.engine.persistedPositionOf(indexName, partitionId), assignment)
  if (floor.seqNo <= 0) {
    return
  }
  deps.seedReplicationLog(indexName, partitionId, floor.seqNo + 1, floor.primaryTerm)
}
