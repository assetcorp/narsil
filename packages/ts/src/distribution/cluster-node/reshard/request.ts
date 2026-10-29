import { ErrorCodes, NarsilError } from '../../../errors'
import { RESHARD_CONTROLLER_POLL_INTERVAL_MS } from '../../cluster/constants'
import { CONTROLLER_LEASE_KEY } from '../../cluster/controller/types'
import { pause } from '../../cluster/rebalance/pause'
import { readRebalanceRecord } from '../../cluster/rebalance/records'
import { exchangeRebalanceMessage } from '../../cluster/rebalance/reply'
import { MAX_PARTITION_COUNT } from '../../constants'
import { isValidInteger } from '../../payload-guards'
import type { RebalancePayload } from '../../transport/reshard-payloads'
import { ClusterMessageTypes } from '../../transport/types'
import { refuseHiddenGeneration } from '../generation-routing'
import { resolveNodeTargets } from '../node-messaging'
import type { ClusterNodeConfig } from '../types'

export interface RebalanceJob {
  jobId: string
  targetGeneration: string
}

export async function waitForSwap(
  config: ClusterNodeConfig,
  indexName: string,
  { jobId, targetGeneration }: RebalanceJob,
  guard: () => void,
): Promise<void> {
  for (;;) {
    guard()
    if ((await config.coordinator.getAllocation(indexName))?.generation === targetGeneration) return
    const record = await readRebalanceRecord(config.coordinator, indexName)
    if (record === null || record.jobId !== jobId) {
      if ((await config.coordinator.getAllocation(indexName))?.generation === targetGeneration) return
      throw new NarsilError(
        ErrorCodes.ALLOCATION_FAILED,
        `The partition count change of index '${indexName}' was aborted, so the index keeps its partitions`,
        { indexName, jobId },
      )
    }
    await pause(RESHARD_CONTROLLER_POLL_INTERVAL_MS)
  }
}

export async function requestRebalance(
  config: ClusterNodeConfig,
  nodeId: string,
  indexName: string,
  targetPartitionCount: number,
): Promise<RebalanceJob> {
  refuseHiddenGeneration(indexName)
  if (!isValidInteger(targetPartitionCount) || targetPartitionCount < 1 || targetPartitionCount > MAX_PARTITION_COUNT) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `The partition count of index '${indexName}' must be an integer from 1 to ${MAX_PARTITION_COUNT}`,
      { indexName, targetPartitionCount: String(targetPartitionCount) },
    )
  }
  const controllerNodeId = await config.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
  if (controllerNodeId === null) {
    throw new NarsilError(
      ErrorCodes.NODE_NOT_CONTROLLER,
      `No node holds the controller lease, so index '${indexName}' keeps its partition count`,
      { indexName },
    )
  }
  const payload: RebalancePayload = { indexName, targetPartitionCount }
  const reply = await exchangeRebalanceMessage({
    transport: config.transport,
    senderId: nodeId,
    targets: await resolveNodeTargets(config, controllerNodeId),
    type: ClusterMessageTypes.REBALANCE,
    payload,
    failureMessage: `The controller '${controllerNodeId}' did not answer a partition count change`,
    details: { indexName, controllerNodeId },
  })
  if (typeof reply.jobId !== 'string' || typeof reply.targetGeneration !== 'string') {
    throw new NarsilError(
      ErrorCodes.ALLOCATION_FAILED,
      `The controller sent an unreadable answer to the partition count change of '${indexName}'`,
      { indexName, controllerNodeId },
    )
  }
  return { jobId: reply.jobId, targetGeneration: reply.targetGeneration }
}
