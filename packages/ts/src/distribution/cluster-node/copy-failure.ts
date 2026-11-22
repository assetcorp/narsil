import { ErrorCodes, NarsilError } from '../../errors'
import { decode } from '../../serialization/msgpack'
import { CONTROLLER_LEASE_KEY } from '../cluster/controller/types'
import { getIndexMetadata } from '../cluster/index-metadata'
import { holdsLastCopy, lastHoldersOf } from '../cluster/last-holders'
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
  engine: Pick<ClusterLocalEngine, 'emptyPartitionCopy' | 'reloadPartitionCopy' | 'indexUuidOf'>
  writeDeps: WriteRoutingDeps
  forgetPartitionLog(indexName: string, partitionId: number): void
  isShutdown(): boolean
  onError(error: unknown): void
}

export interface CopyFailures {
  record(indexName: string, partitionId: number, error: Error): void
  recordMissing(indexName: string, partitionId: number): void
  isFailed(indexName: string, partitionId: number): boolean
  isUnlisted(indexName: string, partitionId: number): boolean
  awaitReset(indexName: string, partitionId: number): Promise<boolean>
}

type Step = 'reset' | 'kept' | 'retry'

interface FailedCopy {
  indexName: string
  partitionId: number
  indexUuid: string | null
  recovery: Promise<boolean> | null
  reloaded: boolean | null
  resignedTerm: number | null
  removed: boolean
  missing: boolean
  released: boolean
}

function heldIndexUuid(deps: CopyFailureDeps, indexName: string): string | null {
  return deps.engine.indexUuidOf(indexName) ?? null
}

function namesAnotherIndex(deps: CopyFailureDeps, copy: FailedCopy): boolean {
  if (copy.indexUuid === null) return false
  const held = heldIndexUuid(deps, copy.indexName)
  return held !== null && held !== copy.indexUuid
}

function allocatesAnotherIndex(table: AllocationTable | null, copy: FailedCopy): boolean {
  return copy.indexUuid !== null && table?.indexUuid !== undefined && table.indexUuid !== copy.indexUuid
}

export function failedCopyRefusal(indexName: string, partitionId: number, nodeId: string): NarsilError {
  return new NarsilError(
    ErrorCodes.REPLICATION_ENTRY_INVALID,
    `Partition ${partitionId} of index '${indexName}' holds a failed copy on node '${nodeId}', which takes no entries until it syncs again from an empty copy`,
    { indexName, partitionId, nodeId },
  )
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
): Promise<boolean> {
  const controller = await controllerOf(deps)
  if (controller === null) return false
  const { nodeId } = deps.writeDeps
  return requestInsyncRemovalWithTargets(indexName, partitionId, nodeId, primaryTerm, controller, deps.writeDeps)
}

function emptyCopy(deps: CopyFailureDeps, round: FailedCopy): Promise<void> {
  const { indexName, partitionId, missing } = round
  if (missing) return Promise.resolve()
  return enqueuePartitionWrite(deps.writeDeps.partitionWriteQueues, indexName, partitionId, async () => {
    if (round.released) return
    const emptied =
      !namesAnotherIndex(deps, round) && (await deps.engine.emptyPartitionCopy(indexName, round.indexUuid, partitionId))
    if (emptied || deps.engine.indexUuidOf(indexName) === undefined) deps.forgetPartitionLog(indexName, partitionId)
  })
}

async function reloadFromDisk(deps: CopyFailureDeps, round: FailedCopy): Promise<boolean | null> {
  const { indexName, partitionId } = round
  try {
    const reloaded = await enqueuePartitionWrite(deps.writeDeps.partitionWriteQueues, indexName, partitionId, () =>
      round.released
        ? Promise.resolve(false)
        : deps.engine.reloadPartitionCopy(indexName, round.indexUuid, partitionId),
    )
    return reloaded ? true : null
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

function reportMissingCopy(deps: CopyFailureDeps, indexName: string, partitionId: number): void {
  deps.onError(
    new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `Partition ${partitionId} of index '${indexName}' has no copy on this node to reload, so the node gives up the lead and leaves the partition out of the partitions it reports holding`,
      { indexName, partitionId, nodeId: deps.writeDeps.nodeId },
    ),
  )
}

async function reloadOnce(deps: CopyFailureDeps, round: FailedCopy): Promise<boolean> {
  if (round.missing) return false
  round.reloaded ??= await reloadFromDisk(deps, round)
  return round.reloaded === true
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
  const assignment = allocatesAnotherIndex(table, round) ? undefined : table?.assignments.get(partitionId)
  if (table === null || assignment === undefined) {
    await emptyCopy(deps, round)
    return 'reset'
  }
  if (round.missing && assignment.state === 'INITIALISING' && lastHoldersOf(assignment).length === 0) return 'reset'
  if (assignment.state === 'UNASSIGNED') {
    if (holdsLastCopy(assignment, nodeId)) return (await reloadOnce(deps, round)) ? 'reset' : 'kept'
    await emptyCopy(deps, round)
    return 'reset'
  }
  if (assignment.primary === nodeId) {
    const resigned = round.resignedTerm !== null && assignment.primaryTerm > round.resignedTerm
    if (resigned && round.reloaded === true) return 'reset'
    if (!holdsOtherInSyncCopy(assignment, nodeId)) await reloadOnce(deps, round)
    await resign(deps, indexName, partitionId, assignment.primaryTerm)
    round.resignedTerm = assignment.primaryTerm
    return 'retry'
  }
  if (assignment.inSyncSet.includes(nodeId)) {
    if (await removeSelf(deps, indexName, partitionId, assignment.primaryTerm)) round.removed = true
    return 'retry'
  }
  if (assignment.replicas.includes(nodeId) && !round.removed) {
    if (!(await removeSelf(deps, indexName, partitionId, assignment.primaryTerm))) return 'retry'
    round.removed = true
  }
  await emptyCopy(deps, round)
  return 'reset'
}

async function recover(deps: CopyFailureDeps, round: FailedCopy): Promise<boolean> {
  const { indexName, partitionId } = round
  round.reloaded = null
  round.resignedTerm = null
  round.removed = false
  let lastError: unknown = null
  for (let attempt = 0; attempt < COPY_FAILURE_ATTEMPTS && !deps.isShutdown(); attempt++) {
    if (attempt > 0) await delay(COPY_FAILURE_RETRY_DELAY_MS)
    if (round.released) return false
    if (namesAnotherIndex(deps, round)) return true
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

function newFailedCopy(deps: CopyFailureDeps, indexName: string, partitionId: number, missing: boolean): FailedCopy {
  return {
    indexName,
    partitionId,
    indexUuid: heldIndexUuid(deps, indexName),
    recovery: null,
    reloaded: null,
    resignedTerm: null,
    removed: false,
    missing,
    released: false,
  }
}

export function createCopyFailures(deps: CopyFailureDeps): CopyFailures {
  const failed = new Map<string, FailedCopy>()
  const keyOf = (indexName: string, partitionId: number) => `${indexName}:${partitionId}`

  function release(key: string, copy: FailedCopy): void {
    if (failed.get(key) === copy) failed.delete(key)
    copy.released = true
  }

  function heldFailure(indexName: string, partitionId: number): FailedCopy | undefined {
    const key = keyOf(indexName, partitionId)
    const copy = failed.get(key)
    if (copy === undefined || !namesAnotherIndex(deps, copy)) return copy
    release(key, copy)
    return undefined
  }

  function startRecovery(key: string, copy: FailedCopy): Promise<boolean> {
    const recovery = recover(deps, copy).then(reset => {
      if (reset) release(key, copy)
      copy.recovery = null
      return reset
    })
    copy.recovery = recovery
    return recovery
  }

  return {
    record(indexName, partitionId) {
      if (heldFailure(indexName, partitionId) !== undefined) return
      const key = keyOf(indexName, partitionId)
      const copy = newFailedCopy(deps, indexName, partitionId, false)
      failed.set(key, copy)
      void startRecovery(key, copy)
    },
    recordMissing(indexName, partitionId) {
      const key = keyOf(indexName, partitionId)
      const known = heldFailure(indexName, partitionId)
      if (known?.missing === true) return
      const copy = known ?? newFailedCopy(deps, indexName, partitionId, true)
      copy.missing = true
      copy.reloaded = null
      failed.set(key, copy)
      reportMissingCopy(deps, indexName, partitionId)
      if (copy.recovery === null) void startRecovery(key, copy)
    },
    isFailed: (indexName, partitionId) => heldFailure(indexName, partitionId) !== undefined,
    isUnlisted(indexName, partitionId) {
      const copy = heldFailure(indexName, partitionId)
      return copy !== undefined && (copy.missing || copy.reloaded !== true)
    },
    async awaitReset(indexName, partitionId) {
      const key = keyOf(indexName, partitionId)
      const copy = heldFailure(indexName, partitionId)
      if (copy === undefined) return true
      return copy.recovery ?? startRecovery(key, copy)
    },
  }
}
