import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../errors'
import { CONTROLLER_LEASE_KEY } from '../cluster/controller/types'
import { getIndexMetadata } from '../cluster/index-metadata'
import { holdsLastCopy } from '../cluster/last-holders'
import type { AllocationTable, PartitionAssignment } from '../coordinator/types'
import { createPrimaryResignMessage, validateInsyncConfirmPayload } from '../replication/codec'
import { COPY_FAILURE_ATTEMPTS, COPY_FAILURE_RETRY_DELAY_MS } from './constants'
import type { ClusterLocalEngine } from './local-engine'
import { sendThroughTargets } from './transport-failure'
import { resolveNodeTargets } from './write-routing/assignment'
import { enqueuePartitionWrite } from './write-routing/partition-queue'
import { requestInsyncRemovalWithTargets } from './write-routing/replication'
import type { WriteRoutingDeps } from './write-routing/types'

export interface CopyFailureDeps {
  engine: Pick<ClusterLocalEngine, 'emptyPartitionCopy' | 'reloadPartitionCopy'>
  writeDeps: WriteRoutingDeps
  forgetPartitionLog(indexName: string, partitionId: number): void
  isShutdown(): boolean
  onError(error: unknown): void
}

export interface CopyFailures {
  record(indexName: string, partitionId: number, error: Error): void
  isFailed(indexName: string, partitionId: number): boolean
  isUnlisted(indexName: string, partitionId: number): boolean
  awaitReset(indexName: string, partitionId: number): Promise<boolean>
}

type Step = 'reset' | 'kept' | 'retry'

interface FailedCopy {
  indexName: string
  partitionId: number
  recovery: Promise<boolean> | null
  reloaded: boolean | null
  resignedTerm: number | null
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

async function controllerOf(deps: CopyFailureDeps): Promise<string | null> {
  return deps.writeDeps.coordinator.getLeaseHolder(CONTROLLER_LEASE_KEY)
}

async function resign(
  deps: CopyFailureDeps,
  indexName: string,
  partitionId: number,
  primaryTerm: number,
): Promise<void> {
  const controller = await controllerOf(deps)
  const metadata = await getIndexMetadata(deps.writeDeps.coordinator, indexName)
  if (controller === null || metadata === null) return
  const message = createPrimaryResignMessage(
    { indexName, indexUuid: metadata.indexUuid, partitionId, primaryTerm },
    deps.writeDeps.nodeId,
  )
  await sendThroughTargets(
    await resolveNodeTargets(controller, deps.writeDeps),
    async target =>
      validateInsyncConfirmPayload(decode((await deps.writeDeps.transport.send(target, message)).payload)),
    {
      message: `Controller '${controller}' did not answer the resignation of partition ${partitionId} of index '${indexName}'`,
      details: { indexName, partitionId, controllerNodeId: controller },
    },
  )
}

async function removeSelf(
  deps: CopyFailureDeps,
  indexName: string,
  partitionId: number,
  primaryTerm: number,
): Promise<void> {
  const controller = await controllerOf(deps)
  if (controller === null) return
  const { nodeId } = deps.writeDeps
  await requestInsyncRemovalWithTargets(indexName, partitionId, nodeId, primaryTerm, controller, deps.writeDeps)
}

function emptyCopy(deps: CopyFailureDeps, indexName: string, partitionId: number): Promise<void> {
  return enqueuePartitionWrite(deps.writeDeps.partitionWriteQueues, indexName, partitionId, async () => {
    await deps.engine.emptyPartitionCopy(indexName, partitionId)
    deps.forgetPartitionLog(indexName, partitionId)
  })
}

async function reloadFromDisk(deps: CopyFailureDeps, indexName: string, partitionId: number): Promise<boolean> {
  try {
    await enqueuePartitionWrite(deps.writeDeps.partitionWriteQueues, indexName, partitionId, () =>
      deps.engine.reloadPartitionCopy(indexName, partitionId),
    )
    return true
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    deps.onError(
      new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `Partition ${partitionId} of index '${indexName}' failed to reload from this node's checkpoint and log, so the node leaves it out of the partitions it reports holding: ${cause}`,
        { indexName, partitionId, nodeId: deps.writeDeps.nodeId, cause },
      ),
    )
    return false
  }
}

async function reloadOnce(deps: CopyFailureDeps, round: FailedCopy, indexName: string, partitionId: number) {
  round.reloaded ??= await reloadFromDisk(deps, indexName, partitionId)
  return round.reloaded
}

function holdsOtherInSyncCopy(assignment: PartitionAssignment, nodeId: string): boolean {
  return assignment.replicas.some(replica => replica !== nodeId && assignment.inSyncSet.includes(replica))
}

async function stepFor(
  deps: CopyFailureDeps,
  round: FailedCopy,
  table: AllocationTable | null,
  indexName: string,
  partitionId: number,
): Promise<Step> {
  const { nodeId } = deps.writeDeps
  const assignment = table?.assignments.get(partitionId)
  if (table === null || assignment === undefined) {
    await emptyCopy(deps, indexName, partitionId)
    return 'reset'
  }
  if (assignment.state === 'UNASSIGNED') {
    if (holdsLastCopy(assignment, nodeId))
      return (await reloadOnce(deps, round, indexName, partitionId)) ? 'reset' : 'kept'
    await emptyCopy(deps, indexName, partitionId)
    return 'reset'
  }
  if (assignment.primary === nodeId) {
    const resigned = round.resignedTerm !== null && assignment.primaryTerm > round.resignedTerm
    if (resigned && round.reloaded === true) return 'reset'
    if (!holdsOtherInSyncCopy(assignment, nodeId)) await reloadOnce(deps, round, indexName, partitionId)
    await resign(deps, indexName, partitionId, assignment.primaryTerm)
    round.resignedTerm = assignment.primaryTerm
    return 'retry'
  }
  if (assignment.inSyncSet.includes(nodeId)) {
    await removeSelf(deps, indexName, partitionId, assignment.primaryTerm)
    return 'retry'
  }
  await emptyCopy(deps, indexName, partitionId)
  return 'reset'
}

async function recover(deps: CopyFailureDeps, round: FailedCopy): Promise<boolean> {
  const { indexName, partitionId } = round
  round.reloaded = null
  round.resignedTerm = null
  let lastError: unknown = null
  for (let attempt = 0; attempt < COPY_FAILURE_ATTEMPTS && !deps.isShutdown(); attempt++) {
    if (attempt > 0) await delay(COPY_FAILURE_RETRY_DELAY_MS)
    try {
      const { readLiveAllocation, coordinator } = deps.writeDeps
      const table = await (readLiveAllocation?.(indexName) ?? coordinator.getAllocation(indexName))
      const step = await stepFor(deps, round, table, indexName, partitionId)
      if (step !== 'retry') return step === 'reset'
    } catch (error) {
      lastError = error
    }
  }
  if (!deps.isShutdown()) {
    const cause = lastError instanceof Error ? lastError.message : String(lastError)
    deps.onError(
      new NarsilError(
        ErrorCodes.REPLICATION_INSYNC_REMOVAL_FAILED,
        `Partition ${partitionId} of index '${indexName}' keeps a failed copy, because the controller never took it out of service: ${cause}`,
        { indexName, partitionId, nodeId: deps.writeDeps.nodeId, cause },
      ),
    )
  }
  return false
}

export function createCopyFailures(deps: CopyFailureDeps): CopyFailures {
  const failed = new Map<string, FailedCopy>()
  const keyOf = (indexName: string, partitionId: number) => `${indexName}:${partitionId}`

  function startRecovery(key: string, copy: FailedCopy): Promise<boolean> {
    const recovery = recover(deps, copy).then(reset => {
      if (reset && failed.get(key) === copy) failed.delete(key)
      copy.recovery = null
      return reset
    })
    copy.recovery = recovery
    return recovery
  }

  return {
    record(indexName, partitionId) {
      const key = keyOf(indexName, partitionId)
      if (failed.has(key)) return
      const copy: FailedCopy = { indexName, partitionId, recovery: null, reloaded: null, resignedTerm: null }
      failed.set(key, copy)
      void startRecovery(key, copy)
    },
    isFailed: (indexName, partitionId) => failed.has(keyOf(indexName, partitionId)),
    isUnlisted(indexName, partitionId) {
      const copy = failed.get(keyOf(indexName, partitionId))
      return copy !== undefined && copy.reloaded !== true
    },
    async awaitReset(indexName, partitionId) {
      const key = keyOf(indexName, partitionId)
      const copy = failed.get(key)
      if (copy === undefined) return true
      return copy.recovery ?? startRecovery(key, copy)
    },
  }
}
